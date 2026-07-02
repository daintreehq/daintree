import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as semver from "semver";
import { z } from "zod";

import {
  PLUGIN_BLOCKLIST_URL,
  PLUGIN_BLOCKLIST_CACHE_FILENAME,
  PLUGIN_BLOCKLIST_TTL_MS,
  PLUGIN_BLOCKLIST_FETCH_TIMEOUT_MS,
} from "../../../shared/config/pluginBlocklist.js";

/**
 * One blocklist entry. OSV-inspired minimal shape: a plugin `name`, one or
 * more semver `ranges` covering the bad versions, a machine `reason` code, an
 * optional human `message`, and an optional `jti` allow-scoping reserved for a
 * future signed-identity model (unused today — see the matcher).
 */
const PluginBlocklistEntrySchema = z.object({
  name: z.string().min(1),
  ranges: z.array(z.string().min(1)).min(1),
  jti: z.array(z.string().min(1)).min(1).optional(),
  reason: z.string().min(1),
  message: z.string().min(1).optional(),
});

const PluginBlocklistSchema = z.object({
  entries: z.array(PluginBlocklistEntrySchema),
});

export type PluginBlocklistEntry = z.infer<typeof PluginBlocklistEntrySchema>;
export type ParsedPluginBlocklist = z.infer<typeof PluginBlocklistSchema>;

/** Result of a positive blocklist match, surfaced to the UI/notification. */
export interface PluginBlocklistMatch {
  /** The blocklist entry's machine reason code. */
  reason: string;
  /** Human-facing explanation — `message` if present, else `reason`. */
  message: string;
}

interface DiskPayload {
  fetchedAt: number;
  raw: unknown;
}

interface CachedBlocklist {
  data: ParsedPluginBlocklist;
  fetchedAt: number;
}

interface BlocklistDeps {
  /** Override for disk-cache path. Defaults to `app.getPath('userData')/plugin-blocklist.json`. */
  cachePath?: string;
  /** Override for `fetch` (used by tests). Defaults to Electron's `net.fetch`. */
  fetchImpl?: (
    url: string,
    init?: { signal?: AbortSignal; headers?: Record<string, string> }
  ) => Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
  }>;
  /** Override for the clock (used by tests). Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Resolves the remote plugin blocklist / kill-switch (#10891) with a
 * disk-backed stale-while-revalidate cache and singleflight dedup, mirroring
 * `AgentModelCatalogService`. The contract is **fail open**: every failure
 * path (network, HTTP error, malformed body, missing/corrupt cache) resolves
 * to `null` and never throws, so a user's plugins are never bricked just
 * because the blocklist couldn't be fetched. A previously-cached list is still
 * enforced while offline — security-favorable, and the intended behavior for a
 * kill-switch — which is why "fail open" here means "fail open when no
 * validated blocklist is available", not "ignore a stale one".
 */
export class PluginBlocklistService {
  private inFlight: Promise<ParsedPluginBlocklist | null> | null = null;
  private memCache: CachedBlocklist | null = null;

  constructor(private readonly deps: BlocklistDeps = {}) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Force a re-resolve on the next `getBlocklist()` call. Used by tests. */
  clearCache(): void {
    this.memCache = null;
  }

  /** Returns the parsed blocklist, or `null` when no validated list is available. */
  async getBlocklist(): Promise<ParsedPluginBlocklist | null> {
    if (this.memCache && this.now() - this.memCache.fetchedAt < PLUGIN_BLOCKLIST_TTL_MS) {
      return this.memCache.data;
    }

    if (this.inFlight) return this.inFlight;

    this.inFlight = this.refresh()
      .catch((err) => {
        console.warn("[PluginBlocklistService] refresh failed", err);
        return null;
      })
      .finally(() => {
        this.inFlight = null;
      });

    const fresh = await this.inFlight;
    if (fresh) return fresh;

    // Network failed — fall back to disk if memCache was never warmed.
    const disk = await this.readDisk();
    if (disk) {
      this.memCache = { data: disk.data, fetchedAt: disk.fetchedAt };
      return disk.data;
    }

    // Disk is also gone/corrupt. If we ever validated a list this session,
    // keep enforcing it (stale) rather than dropping to no-blocklist — a
    // kill-switch should not forget a known-bad plugin just because the TTL
    // lapsed and the network is down.
    return this.memCache?.data ?? null;
  }

  private async refresh(): Promise<ParsedPluginBlocklist | null> {
    const disk = await this.readDisk();
    if (disk && this.now() - disk.fetchedAt < PLUGIN_BLOCKLIST_TTL_MS) {
      this.memCache = { data: disk.data, fetchedAt: disk.fetchedAt };
      return disk.data;
    }

    const fetched = await this.fetchRemote();
    if (fetched) {
      this.memCache = { data: fetched.parsed, fetchedAt: fetched.fetchedAt };
      // Best-effort persist; a write failure must never block enforcement.
      void this.writeDisk(fetched.fetchedAt, fetched.raw).catch((err) => {
        console.warn("[PluginBlocklistService] disk write failed", err);
      });
      return fetched.parsed;
    }

    // Network failed but a stale cache exists — enforce the last-known list.
    if (disk) {
      this.memCache = { data: disk.data, fetchedAt: disk.fetchedAt };
      return disk.data;
    }

    return null;
  }

  private async fetchRemote(): Promise<{
    parsed: ParsedPluginBlocklist;
    raw: unknown;
    fetchedAt: number;
  } | null> {
    const fetchImpl = this.deps.fetchImpl ?? (await getElectronNetFetch());
    if (!fetchImpl) return null;

    try {
      const res = await fetchImpl(PLUGIN_BLOCKLIST_URL, {
        signal: AbortSignal.timeout(PLUGIN_BLOCKLIST_FETCH_TIMEOUT_MS),
        headers: {
          Accept: "application/json",
          "User-Agent": "Daintree-Electron",
        },
      });
      if (!res.ok) {
        console.warn(`[PluginBlocklistService] HTTP ${res.status} from ${PLUGIN_BLOCKLIST_URL}`);
        return null;
      }
      const raw = await res.json();
      const parsed = PluginBlocklistSchema.safeParse(raw);
      if (!parsed.success) {
        console.warn("[PluginBlocklistService] blocklist schema rejected", parsed.error.message);
        return null;
      }
      return { parsed: parsed.data, raw, fetchedAt: this.now() };
    } catch (err) {
      // `AbortSignal.timeout()` surfaces inconsistently across Chromium
      // versions — sometimes `TimeoutError`, sometimes `AbortError`. Both, and
      // any other network error, are fail-open cases.
      console.warn("[PluginBlocklistService] blocklist fetch failed", err);
      return null;
    }
  }

  private async readDisk(): Promise<{ data: ParsedPluginBlocklist; fetchedAt: number } | null> {
    const cachePath = await this.resolveCachePath();
    if (!cachePath) return null;
    try {
      const text = await fs.readFile(cachePath, "utf-8");
      const payload = JSON.parse(text) as Partial<DiskPayload>;
      if (typeof payload.fetchedAt !== "number") return null;
      const parsed = PluginBlocklistSchema.safeParse(payload.raw);
      if (!parsed.success) return null;
      return { data: parsed.data, fetchedAt: payload.fetchedAt };
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === "ENOENT") return null;
      console.warn("[PluginBlocklistService] disk read failed", err);
      return null;
    }
  }

  private async writeDisk(fetchedAt: number, raw: unknown): Promise<void> {
    const cachePath = await this.resolveCachePath();
    if (!cachePath) return;
    const dir = path.dirname(cachePath);
    await fs.mkdir(dir, { recursive: true });
    const payload: DiskPayload = { fetchedAt, raw };
    await fs.writeFile(cachePath, JSON.stringify(payload), "utf-8");
  }

  private async resolveCachePath(): Promise<string | null> {
    if (this.deps.cachePath) return this.deps.cachePath;
    try {
      const { app } = await import("electron");
      return path.join(app.getPath("userData"), PLUGIN_BLOCKLIST_CACHE_FILENAME);
    } catch {
      // Outside Electron (tests without override) — skip disk cache.
      return null;
    }
  }
}

/**
 * Pure matcher — kept exported and side-effect-free so the semver / malformed
 * -range / prerelease / jti-scoping behavior can be unit-tested directly.
 *
 * A candidate matches an entry when the `name` is exactly equal AND at least
 * one of the entry's `ranges` covers `candidate.version` via
 * `semver.satisfies(..., { includePrerelease: true })` — the `includePrerelease`
 * flag is mandatory (matching the existing `engines.daintree` check) or a
 * prerelease-tagged version silently slips a `<x.y.z`-style range. Malformed
 * ranges are ignored entry-locally rather than treated as a match or a whole
 * -blocklist failure.
 *
 * `jti` scoping is reserved for a future signed-identity model: an entry that
 * declares `jti` only matches when the candidate carries one of those ids.
 * Today plugins expose no `jti`, so `jti`-scoped entries never over-block.
 */
export function findPluginBlocklistMatch(
  blocklist: ParsedPluginBlocklist | null,
  candidate: { name: string; version: string; jti?: string }
): PluginBlocklistMatch | null {
  if (!blocklist) return null;

  for (const entry of blocklist.entries) {
    if (entry.name !== candidate.name) continue;

    if (entry.jti && entry.jti.length > 0) {
      if (!candidate.jti || !entry.jti.includes(candidate.jti)) continue;
    }

    const versionMatches = entry.ranges.some((range) => {
      if (!semver.validRange(range, { includePrerelease: true })) return false;
      return semver.satisfies(candidate.version, range, { includePrerelease: true });
    });
    if (!versionMatches) continue;

    return { reason: entry.reason, message: entry.message ?? entry.reason };
  }

  return null;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/**
 * Resolve Electron's `net.fetch` lazily so this module can be imported in
 * Node-only test runners. Returns a `fetch`-compatible function, or null when
 * `net.fetch` is unavailable.
 */
async function getElectronNetFetch(): Promise<BlocklistDeps["fetchImpl"] | null> {
  try {
    const { net } = await import("electron");
    if (typeof net?.fetch !== "function") return null;
    return (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) =>
      net.fetch(url, init).then((res) => ({
        ok: res.ok,
        status: res.status,
        json: () => res.json() as Promise<unknown>,
      }));
  } catch {
    return null;
  }
}
