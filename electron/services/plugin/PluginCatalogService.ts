import * as path from "node:path";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import * as semver from "semver";

import {
  PLUGIN_CATALOG_URL,
  PLUGIN_CATALOG_CACHE_FILENAME,
  PLUGIN_CATALOG_SOURCE_CACHE_DIR,
  PLUGIN_CATALOG_BROWSE_TTL_MS,
  PLUGIN_CATALOG_FETCH_TIMEOUT_MS,
  PLUGIN_CATALOG_MAX_BYTES,
} from "../../../shared/config/pluginCatalog.js";
import type {
  PluginCatalogBrowseResult,
  PluginCatalogFailure,
  PluginCatalogListing,
} from "../../../shared/types/plugin.js";
import { resilientAtomicWriteFile } from "../../utils/fs.js";
import { createLogger } from "../../utils/logger.js";
import {
  createManualRedirectFetch,
  type ManualRedirectFetch,
} from "../../utils/netManualRedirectFetch.js";
import { fetchWithPrivateHostGuard } from "../../utils/pluginDownloadPolicy.js";
import {
  parsePluginCatalog,
  type PluginCatalog,
  type PluginCatalogEntry,
} from "./pluginCatalogSchema.js";

const logger = createLogger("main:PluginCatalogService");

export type { PluginCatalogFailure };

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

/**
 * What a fresh catalog says about an installed release (#16781). `update` is
 * the release to offer; `current` means the installed release is still listed
 * and nothing newer is; `delisted` means nothing newer is listed and neither is
 * the plugin (`plugin`) or the installed release (`release`).
 */
export type PluginCatalogUpdateLookup =
  | { readonly status: "update"; readonly entry: PluginCatalogEntry; readonly fetchedAt: number }
  | { readonly status: "current"; readonly fetchedAt: number }
  | {
      readonly status: "delisted";
      readonly scope: "plugin" | "release";
      readonly fetchedAt: number;
    }
  | PluginCatalogBlocked;

/**
 * Where an update check reads its releases: the shared service, which fetches
 * a catalog for every lookup, or a batch opened for one background pass, which
 * fetches once for all of them (#17805).
 */
export interface PluginCatalogUpdateSource {
  lookupUpdate(id: string, installedVersion: string): Promise<PluginCatalogUpdateLookup>;
}

type CatalogFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface PluginCatalogDeps {
  /**
   * The catalog the person added that this client reads (#17434), as its
   * canonical URL; absent for Daintree's own.
   */
  sourceUrl?: string;
  /**
   * Defaults to `userData/plugin-catalog.json` for Daintree's own catalog and
   * `userData/plugin-catalogs/<sha256 of the URL>.json` for an added one;
   * `null` disables the disk cache.
   */
  cachePath?: string | null;
  /** Daintree's own catalog only. Defaults to Electron's `net.fetch`. */
  fetchImpl?: CatalogFetch;
  /**
   * An added catalog only: the fetch each guarded hop makes. Defaults to a
   * manual-redirect fetch on Electron's `net.request`.
   */
  manualFetch?: ManualRedirectFetch;
  now?: () => number;
}

interface CatalogSnapshot {
  catalog: PluginCatalog;
  fetchedAt: number;
}

interface IndexedCatalog {
  byId: ReadonlyMap<string, readonly PluginCatalogEntry[]>;
  fetchedAt: number;
}

type RemoteOutcome =
  { ok: true; snapshot: CatalogSnapshot } | { ok: false; failure: PluginCatalogFailure };

interface DiskPayload {
  fetchedAt: number;
  /** An added catalog's URL, checked on read so a cache file can't stand in for another. */
  sourceUrl?: string;
  catalog: unknown;
}

/**
 * Fetches, validates and caches one plugin catalog (#16777,
 * `docs/plugins/catalog.md`): Daintree's own, or one the person added
 * (#17434), held to the same schema. Nothing happens until a caller asks: the
 * constructor does no I/O, and the disk cache is read on the first request.
 * Concurrent callers share one fetch, but each gets the answer its own mode
 * allows, so a browse caller never decides what an install caller may use.
 */
export class PluginCatalogService implements PluginCatalogUpdateSource {
  private snapshot: CatalogSnapshot | null = null;
  private diskLoad: Promise<void> | null = null;
  private inFlight: Promise<RemoteOutcome> | null = null;
  /** Writes run in order, so an older catalog never lands over a newer one. */
  private diskWrites: Promise<void> = Promise.resolve();
  private pendingWrites = 0;
  private activeReads = 0;
  private batchHolds = 0;
  private cachePath: Promise<string | null> | null = null;

  constructor(private readonly deps: PluginCatalogDeps = {}) {}

  /**
   * Nothing is being read, fetched or written. Only an idle client is let go
   * (#17434), so a client built again for the same catalog never runs beside
   * one whose write could still land over its newer copy.
   */
  isIdle(): boolean {
    return (
      this.activeReads === 0 &&
      this.inFlight === null &&
      this.pendingWrites === 0 &&
      this.batchHolds === 0
    );
  }

  async getCatalog(mode: PluginCatalogMode): Promise<PluginCatalogResult> {
    this.activeReads += 1;
    try {
      return await this.readCatalog(mode);
    } finally {
      this.activeReads -= 1;
    }
  }

  private async readCatalog(mode: PluginCatalogMode): Promise<PluginCatalogResult> {
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
   * One release, read the way an install reads: `not-listed` only ever comes
   * from a catalog fetched for this call. With a `version` the match is exact;
   * without one it is the plugin's newest release (see {@link newestRelease}).
   */
  async lookup(id: string, version?: string): Promise<PluginCatalogLookup> {
    const result = await this.getCatalog("install");
    if (result.status !== "available") return result;
    const entry =
      version === undefined
        ? newestRelease(result.catalog.entries.filter((e) => e.id === id))
        : result.catalog.entries.find((e) => e.id === id && e.version === version);
    return entry
      ? { status: "listed", entry, fetchedAt: result.fetchedAt }
      : { status: "not-listed", fetchedAt: result.fetchedAt };
  }

  /**
   * What Browse lists (#16782): each plugin's newest release, by the same rule
   * an unversioned install link uses, in id order. Answers from the cache the
   * way any browse read does; installing still resolves the release afresh.
   */
  async browse(): Promise<PluginCatalogBrowseResult> {
    const result = await this.getCatalog("browse");
    if (result.status !== "available") return { status: "unavailable", failure: result.failure };
    const listings: PluginCatalogListing[] = [];
    const { sourceUrl } = this.deps;
    for (const releases of releasesById(result.catalog.entries).values()) {
      const newest = newestRelease(releases);
      if (!newest) continue;
      listings.push({
        id: newest.id,
        version: newest.version,
        repo: newest.repo,
        capabilities: [...newest.capabilities],
        ...(sourceUrl === undefined ? {} : { sourceUrl }),
      });
    }
    listings.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const { fetchedAt } = result;
    return result.fresh
      ? { status: "available", listings, fetchedAt, stale: false }
      : { status: "available", listings, fetchedAt, stale: true, failure: result.failure };
  }

  /**
   * The update for an installed release, read from a catalog fetched for this
   * call like an install's. The installed version is never offered again and
   * an older one never is, so a catalog that lists only older releases can't
   * downgrade anyone (see {@link newestUpdate}).
   */
  async lookupUpdate(id: string, installedVersion: string): Promise<PluginCatalogUpdateLookup> {
    const result = await this.getCatalog("install");
    if (result.status !== "available") return result;
    const releases = result.catalog.entries.filter((e) => e.id === id);
    return updateFor(releases, installedVersion, result.fetchedAt);
  }

  /**
   * Update lookups for one background pass (#17805). The first lookup fetches
   * a catalog the way {@link lookupUpdate} does, and every lookup in the batch
   * answers from that fetch, its releases indexed by plugin id. A catalog that
   * couldn't be fetched answers the whole batch the same way, and the next
   * batch fetches again. Installing still resolves its release afresh.
   */
  openUpdateBatch(): PluginCatalogUpdateSource {
    let read: Promise<IndexedCatalog | PluginCatalogBlocked> | null = null;
    // Held from opening until its one read settles, so the client can't be
    // let go in between and rebuilt beside the one this batch reads (#17434).
    this.batchHolds += 1;
    let held = true;
    const release = () => {
      if (!held) return;
      held = false;
      this.batchHolds -= 1;
    };
    return {
      lookupUpdate: async (id, installedVersion) => {
        read ??= this.getCatalog("install")
          .then((result): IndexedCatalog | PluginCatalogBlocked =>
            result.status === "available"
              ? { byId: releasesById(result.catalog.entries), fetchedAt: result.fetchedAt }
              : result
          )
          .finally(release);
        const catalog = await read;
        if ("status" in catalog) return catalog;
        return updateFor(catalog.byId.get(id) ?? [], installedVersion, catalog.fetchedAt);
      },
    };
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
          this.pendingWrites += 1;
          this.diskWrites = this.diskWrites
            .then(() => this.writeDisk(snapshot))
            .finally(() => {
              this.pendingWrites -= 1;
            });
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
    const init: RequestInit = {
      // Covers the body read as well as the headers.
      signal: AbortSignal.timeout(PLUGIN_CATALOG_FETCH_TIMEOUT_MS),
      cache: "no-store",
      credentials: "omit",
      headers: { Accept: "application/json" },
    };
    const response = await this.request(init);
    if (!response) return { ok: false, failure: "unreachable" };
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

  /**
   * Daintree's own catalog is a constant on its own CDN. An added one is a URL
   * the person typed, so it is held to what a URL install is (#17434): every
   * redirect hop is checked for https and a public host, by name and by what
   * the name resolves to, before anything connects.
   */
  private async request(init: RequestInit): Promise<Response | null> {
    const { sourceUrl } = this.deps;
    if (sourceUrl === undefined) {
      const fetchImpl = this.deps.fetchImpl ?? (await loadNetFetch());
      return fetchImpl ? fetchImpl(PLUGIN_CATALOG_URL, init) : null;
    }
    const manualFetch = this.deps.manualFetch ?? (await loadManualFetch());
    if (!manualFetch) return null;
    const guarded = await fetchWithPrivateHostGuard(manualFetch, sourceUrl, init);
    if (!guarded.ok) {
      logger.warn("Added catalog fetch refused", { reason: guarded.reason });
      return null;
    }
    return guarded.response;
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
    if (payload.sourceUrl !== this.deps.sourceUrl) return null;
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
    const { sourceUrl } = this.deps;
    const payload: DiskPayload = {
      fetchedAt: snapshot.fetchedAt,
      ...(sourceUrl === undefined ? {} : { sourceUrl }),
      catalog: snapshot.catalog,
    };
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
      const userData = await loadUserDataPath();
      if (userData === null) return null;
      const { sourceUrl } = this.deps;
      return sourceUrl === undefined
        ? path.join(userData, PLUGIN_CATALOG_CACHE_FILENAME)
        : path.join(userData, PLUGIN_CATALOG_SOURCE_CACHE_DIR, sourceCacheFileName(sourceUrl));
    })();
    return this.cachePath;
  }
}

/**
 * The release an unversioned install gets: the highest stable version, or the
 * highest prerelease when the plugin has no stable one, so a link that names no
 * version never moves someone onto a prerelease they didn't ask for. Ordered by
 * semver precedence, never by catalog order, with build metadata breaking ties
 * so the choice is deterministic.
 */
function newestRelease(releases: readonly PluginCatalogEntry[]): PluginCatalogEntry | undefined {
  const stable = releases.filter((e) => semver.prerelease(e.version) === null);
  const pool = stable.length > 0 ? stable : releases;
  return [...pool].sort((a, b) => semver.compareBuild(b.version, a.version))[0];
}

/** A version semver can compare: canonical spelling alone admits numbers it can't hold. */
export function isComparableVersion(version: string): boolean {
  return semver.valid(version) !== null;
}

/**
 * The release an update offers: the highest stable version above the installed
 * one, or when there is none and the installed version is itself a prerelease,
 * the highest prerelease above it, so a stable install never moves onto a
 * prerelease. Build metadata alone is never newer: precedence ignores it.
 */
function newestUpdate(
  releases: readonly PluginCatalogEntry[],
  installedVersion: string
): PluginCatalogEntry | undefined {
  const newer = releases.filter((e) => semver.gt(e.version, installedVersion));
  const allowPrerelease = semver.prerelease(installedVersion) !== null;
  return newestRelease(
    allowPrerelease ? newer : newer.filter((e) => semver.prerelease(e.version) === null)
  );
}

/** What a catalog's releases of one plugin say about its installed release. */
function updateFor(
  releases: readonly PluginCatalogEntry[],
  installedVersion: string,
  fetchedAt: number
): PluginCatalogUpdateLookup {
  const entry = newestUpdate(releases, installedVersion);
  if (entry) return { status: "update", entry, fetchedAt };
  if (releases.length === 0) return { status: "delisted", scope: "plugin", fetchedAt };
  return releases.some((e) => e.version === installedVersion)
    ? { status: "current", fetchedAt }
    : { status: "delisted", scope: "release", fetchedAt };
}

function releasesById(entries: readonly PluginCatalogEntry[]): Map<string, PluginCatalogEntry[]> {
  const byId = new Map<string, PluginCatalogEntry[]>();
  for (const entry of entries) {
    const releases = byId.get(entry.id);
    if (releases) releases.push(entry);
    else byId.set(entry.id, [entry]);
  }
  return byId;
}

let sharedService: PluginCatalogService | null = null;
/** Added catalogs' clients, least recently used first. */
const addedSourceServices = new Map<string, PluginCatalogService>();

/**
 * How many added catalogs' clients and cache files are kept. A host serves
 * whatever list each attached machine sends, so this bounds what every
 * catalog anyone ever browsed there can hold (#17434), without one machine's
 * Browse dropping another's.
 */
export const PLUGIN_CATALOG_SOURCES_KEPT = 16;

/** Let go of the least recently used idle clients past the limit, never `keep`. */
function trimAddedSourceServices(keep?: string): void {
  for (const [url, candidate] of addedSourceServices) {
    if (addedSourceServices.size <= PLUGIN_CATALOG_SOURCES_KEPT) break;
    if (url !== keep && candidate.isIdle()) addedSourceServices.delete(url);
  }
}

/**
 * The process-wide client for one catalog, built by its first caller rather
 * than at startup: Daintree's own when `sourceUrl` is omitted, otherwise the
 * added catalog at that canonical URL (#17434). Callers pass a URL already
 * through `pluginCatalogSourceUrl`, so one catalog never gets two clients.
 * Past {@link PLUGIN_CATALOG_SOURCES_KEPT} added catalogs, the least recently
 * used idle one is let go; its cache file stays until
 * {@link settlePluginCatalogSources} sweeps the folder, so a client built
 * again for it still finds it. An install from a dropped catalog still checks
 * it for updates, since those reads always fetch afresh.
 */
export function getPluginCatalogService(sourceUrl?: string): PluginCatalogService {
  if (sourceUrl === undefined) {
    sharedService ??= new PluginCatalogService();
    return sharedService;
  }
  let service = addedSourceServices.get(sourceUrl);
  if (service) {
    addedSourceServices.delete(sourceUrl);
  } else {
    service = new PluginCatalogService({ sourceUrl });
  }
  addedSourceServices.set(sourceUrl, service);
  trimAddedSourceServices(sourceUrl);
  return service;
}

/**
 * After a Browse has read its catalogs: let go of idle clients past the limit
 * (ones busy while it read are idle now), then bound the cache folder to
 * {@link PLUGIN_CATALOG_SOURCES_KEPT} files, dropping the oldest that no live
 * client holds. Files outlive the process, so catalogs browsed in earlier runs
 * and never since would otherwise stay on disk for good. Liveness is checked
 * again right before each file goes, so a client built meanwhile keeps its own.
 */
export async function settlePluginCatalogSources(cacheDir?: string | null): Promise<void> {
  trimAddedSourceServices();
  const dir =
    cacheDir === undefined
      ? await loadUserDataPath().then((userData) =>
          userData === null ? null : path.join(userData, PLUGIN_CATALOG_SOURCE_CACHE_DIR)
        )
      : cacheDir;
  if (dir === null) return;
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((name) => name.endsWith(".json"));
  } catch {
    return;
  }
  if (names.length <= PLUGIN_CATALOG_SOURCES_KEPT) return;
  const liveNames = () => new Set([...addedSourceServices.keys()].map(sourceCacheFileName));
  const live = liveNames();
  const dated = await Promise.all(
    names
      .filter((name) => !live.has(name))
      .map(async (name) => {
        const stat = await fs.stat(path.join(dir, name)).catch(() => null);
        return { name, mtime: stat?.mtimeMs ?? 0 };
      })
  );
  dated.sort((a, b) => b.mtime - a.mtime);
  const room = Math.max(0, PLUGIN_CATALOG_SOURCES_KEPT - live.size);
  const stillLive = liveNames();
  await Promise.all(
    dated
      .slice(room)
      .filter(({ name }) => !stillLive.has(name))
      .map(({ name }) => fs.rm(path.join(dir, name), { force: true }).catch(() => {}))
  );
}

/** Test seam: forget every added catalog's client. */
export function resetPluginCatalogSourceServicesForTest(): void {
  addedSourceServices.clear();
}

/** One file per catalog URL, named so no URL can reach outside the folder. */
function sourceCacheFileName(sourceUrl: string): string {
  return `${createHash("sha256").update(sourceUrl).digest("hex")}.json`;
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

async function loadUserDataPath(): Promise<string | null> {
  try {
    const { app } = await import("electron");
    return app.getPath("userData");
  } catch {
    return null;
  }
}

async function loadManualFetch(): Promise<ManualRedirectFetch | null> {
  try {
    const { net } = await import("electron");
    if (typeof net?.request !== "function") return null;
    return createManualRedirectFetch((options) => net.request(options));
  } catch {
    return null;
  }
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
