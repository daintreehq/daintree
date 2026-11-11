import * as path from "node:path";
import * as fs from "node:fs/promises";

import {
  PLUGIN_CATALOG_URL,
  PLUGIN_CATALOG_CACHE_FILENAME,
  PLUGIN_CATALOG_BROWSE_TTL_MS,
  PLUGIN_CATALOG_FETCH_TIMEOUT_MS,
  PLUGIN_CATALOG_MAX_BYTES,
} from "../../../shared/config/pluginCatalog.js";
import { resilientAtomicWriteFile } from "../../utils/fs.js";
import { createLogger } from "../../utils/logger.js";
import {
  parsePluginCatalog,
  type PluginCatalog,
  type PluginCatalogEntry,
} from "./pluginCatalogSchema.js";

const logger = createLogger("main:PluginCatalogService");

/**
 * Why no catalog could be fetched: `not-published` is a 404 (expected until
 * the catalog repository exists), `unreachable` covers the network, a timeout
 * and any other HTTP status, and `invalid` a body that isn't a valid catalog.
 */
export type PluginCatalogFailure = "not-published" | "unreachable" | "invalid";

/**
 * `browse` may answer from a cached catalog. `install` (and update) always
 * revalidates online, so a pulled release is never installed from a cached
 * copy and nothing installs from the catalog while offline.
 */
export type PluginCatalogMode = "browse" | "install";

/** The catalog can't be used for this read; `stale` means a cached copy exists. */
export type PluginCatalogBlocked =
  | { readonly status: "stale"; readonly fetchedAt: number; readonly failure: PluginCatalogFailure }
  | { readonly status: "unavailable"; readonly failure: PluginCatalogFailure };

export type PluginCatalogResult =
  | {
      readonly status: "available";
      readonly catalog: PluginCatalog;
      readonly fetchedAt: number;
      readonly fresh: true;
    }
  | {
      /** Browse only: the cached copy, after revalidation failed. */
      readonly status: "available";
      readonly catalog: PluginCatalog;
      readonly fetchedAt: number;
      readonly fresh: false;
      readonly failure: PluginCatalogFailure;
    }
  | PluginCatalogBlocked;

export type PluginCatalogLookup =
  | {
      readonly status: "listed";
      readonly entry: PluginCatalogEntry;
      readonly fetchedAt: number;
    }
  | { readonly status: "not-listed"; readonly fetchedAt: number }
  | PluginCatalogBlocked;

type CatalogFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface PluginCatalogDeps {
  /** Defaults to `userData/plugin-catalog.json`; `null` disables the disk cache. */
  cachePath?: string | null;
  /** Defaults to Electron's `net.fetch`. */
  fetchImpl?: CatalogFetch;
  now?: () => number;
}

interface CatalogSnapshot {
  catalog: PluginCatalog;
  fetchedAt: number;
}

type RemoteOutcome =
  { ok: true; snapshot: CatalogSnapshot } | { ok: false; failure: PluginCatalogFailure };

interface DiskPayload {
  fetchedAt: number;
  catalog: unknown;
}

/**
 * Fetches, validates and caches the community plugin catalog (#16777,
 * `docs/plugins/catalog.md`). Nothing happens until a caller asks: the
 * constructor does no I/O, and the disk cache is read on the first request.
 * Concurrent callers share one fetch, but each gets the answer its own mode
 * allows, so a browse caller never decides what an install caller may use.
 */
export class PluginCatalogService {
  private snapshot: CatalogSnapshot | null = null;
  private diskLoad: Promise<void> | null = null;
  private inFlight: Promise<RemoteOutcome> | null = null;
  /** Writes run in order, so an older catalog never lands over a newer one. */
  private diskWrites: Promise<void> = Promise.resolve();
  private cachePath: Promise<string | null> | null = null;

  constructor(private readonly deps: PluginCatalogDeps = {}) {}

  async getCatalog(mode: PluginCatalogMode): Promise<PluginCatalogResult> {
    await this.loadDiskOnce();
    const cached = this.snapshot;
    if (mode === "browse" && cached && this.isFresh(cached)) {
      return { status: "available", ...cached, fresh: true };
    }

    const outcome = await this.revalidate();
    if (outcome.ok) return { status: "available", ...outcome.snapshot, fresh: true };

    const fallback = this.snapshot;
    if (!fallback) return { status: "unavailable", failure: outcome.failure };
    if (mode === "browse") {
      return { status: "available", ...fallback, fresh: false, failure: outcome.failure };
    }
    return { status: "stale", fetchedAt: fallback.fetchedAt, failure: outcome.failure };
  }

  /**
   * One exact release, read the way an install reads: `not-listed` only ever
   * comes from a catalog fetched for this call.
   */
  async lookup(id: string, version: string): Promise<PluginCatalogLookup> {
    const result = await this.getCatalog("install");
    if (result.status !== "available") return result;
    const entry = result.catalog.entries.find((e) => e.id === id && e.version === version);
    return entry
      ? { status: "listed", entry, fetchedAt: result.fetchedAt }
      : { status: "not-listed", fetchedAt: result.fetchedAt };
  }

  /** A clock that went backwards must not make an old catalog look fresh. */
  private isFresh(snapshot: CatalogSnapshot): boolean {
    const age = this.now() - snapshot.fetchedAt;
    return age >= 0 && age < PLUGIN_CATALOG_BROWSE_TTL_MS;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private loadDiskOnce(): Promise<void> {
    this.diskLoad ??= this.readDisk().then((disk) => {
      if (disk && !this.snapshot) this.snapshot = disk;
    });
    return this.diskLoad;
  }

  /**
   * The shared fetch ends once the catalog is in memory, not when the disk
   * write does: a caller arriving during a slow write starts its own request
   * instead of being handed a fetch that finished before it asked.
   */
  private async revalidate(): Promise<RemoteOutcome> {
    this.inFlight ??= this.fetchRemote()
      .catch((err: unknown): RemoteOutcome => {
        logger.warn("Catalog fetch failed", { error: describeError(err) });
        return { ok: false, failure: "unreachable" };
      })
      .then((outcome) => {
        if (outcome.ok) {
          // A successful fetch replaces the cache outright, so a delisted
          // release disappears rather than lingering from an older copy.
          this.snapshot = outcome.snapshot;
          const snapshot = outcome.snapshot;
          this.diskWrites = this.diskWrites.then(() => this.writeDisk(snapshot));
        }
        return outcome;
      })
      .finally(() => {
        this.inFlight = null;
      });
    const outcome = await this.inFlight;
    await this.diskWrites;
    return outcome;
  }

  private async fetchRemote(): Promise<RemoteOutcome> {
    const fetchImpl = this.deps.fetchImpl ?? (await loadNetFetch());
    if (!fetchImpl) return { ok: false, failure: "unreachable" };

    const response = await fetchImpl(PLUGIN_CATALOG_URL, {
      // Covers the body read as well as the headers.
      signal: AbortSignal.timeout(PLUGIN_CATALOG_FETCH_TIMEOUT_MS),
      cache: "no-store",
      credentials: "omit",
      headers: { Accept: "application/json" },
    });
    if (response.status === 404) {
      await discardBody(response);
      logger.debug("Catalog not published");
      return { ok: false, failure: "not-published" };
    }
    if (!response.ok) {
      await discardBody(response);
      logger.warn("Catalog fetch returned an error status", { status: response.status });
      return { ok: false, failure: "unreachable" };
    }

    const bytes = await readBoundedBody(response, PLUGIN_CATALOG_MAX_BYTES);
    if (!bytes) {
      logger.warn("Catalog body exceeds the size limit", { limit: PLUGIN_CATALOG_MAX_BYTES });
      return { ok: false, failure: "invalid" };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      logger.warn("Catalog body is not valid JSON");
      return { ok: false, failure: "invalid" };
    }
    const parsed = parsePluginCatalog(raw);
    if (!parsed.ok) {
      logger.warn("Catalog rejected", { error: parsed.error });
      return { ok: false, failure: "invalid" };
    }
    return { ok: true, snapshot: { catalog: parsed.catalog, fetchedAt: this.now() } };
  }

  /** The cache is revalidated on every read: a local file is no trust root. */
  private async readDisk(): Promise<CatalogSnapshot | null> {
    const cachePath = await this.resolveCachePath();
    if (!cachePath) return null;
    let payload: Partial<DiskPayload> | null;
    try {
      payload = JSON.parse(await fs.readFile(cachePath, "utf-8")) as Partial<DiskPayload> | null;
    } catch (err) {
      if (!isNodeError(err) || err.code !== "ENOENT") {
        logger.warn("Catalog cache unreadable", { error: describeError(err) });
      }
      return null;
    }
    if (typeof payload?.fetchedAt !== "number" || !Number.isFinite(payload.fetchedAt)) return null;
    const parsed = parsePluginCatalog(payload.catalog);
    if (!parsed.ok) {
      logger.warn("Catalog cache rejected", { error: parsed.error });
      return null;
    }
    return { catalog: parsed.catalog, fetchedAt: payload.fetchedAt };
  }

  /** Best effort: a failed write leaves the fetched catalog in memory. */
  private async writeDisk(snapshot: CatalogSnapshot): Promise<void> {
    const cachePath = await this.resolveCachePath();
    if (!cachePath) return;
    const payload: DiskPayload = { fetchedAt: snapshot.fetchedAt, catalog: snapshot.catalog };
    try {
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await resilientAtomicWriteFile(cachePath, JSON.stringify(payload));
    } catch (err) {
      logger.warn("Catalog cache write failed", { error: describeError(err) });
    }
  }

  private resolveCachePath(): Promise<string | null> {
    this.cachePath ??= (async () => {
      if (this.deps.cachePath !== undefined) return this.deps.cachePath;
      try {
        const { app } = await import("electron");
        return path.join(app.getPath("userData"), PLUGIN_CATALOG_CACHE_FILENAME);
      } catch {
        return null;
      }
    })();
    return this.cachePath;
  }
}

let sharedService: PluginCatalogService | null = null;

/** The process-wide service, built by its first caller rather than at startup. */
export function getPluginCatalogService(): PluginCatalogService {
  sharedService ??= new PluginCatalogService();
  return sharedService;
}

/**
 * Reads at most `maxBytes`, checking the declared length first and the
 * streamed bytes after, since a chunked response declares none. Returns
 * `null` when the body is larger.
 */
async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discardBody(response);
    return null;
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

async function loadNetFetch(): Promise<CatalogFetch | null> {
  try {
    const { net } = await import("electron");
    if (typeof net?.fetch !== "function") return null;
    return (url, init) => net.fetch(url, init);
  } catch {
    return null;
  }
}
