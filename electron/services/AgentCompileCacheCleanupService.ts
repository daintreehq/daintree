/**
 * Bounds the per-agent V8 compile cache that Node-based agent CLIs write to
 * `<userData>/agent-compile-cache/<agentId>/<nodeVersionDir>/` (#11699).
 *
 * Node has no eviction of its own — every runtime it has ever run under keeps a
 * directory forever, and the runtime currently in use gains a full fresh blob
 * set each time the agent CLI updates. One report reached 9.3 GB across 890K
 * files. Both halves need answering, so the sweep runs two passes:
 *
 *   Pass 1 (TTL): a version directory whose own mtime predates
 *   `AGENT_COMPILE_CACHE_TTL_MS` is removed outright. Node writes blobs
 *   directly into that directory, so its mtime tracks the last compile under
 *   that runtime — one `stat` stands in for walking its contents.
 *
 *   Pass 2 (budget): survivors are ranked newest-first and admitted while they
 *   fit the root-wide byte and entry budgets. The first directory that does not
 *   fit is removed along with every older one, without measuring those. This is
 *   deliberately a newest-prefix policy, not an optimal packing: finding a
 *   smaller older directory that would fit means sizing the whole tree, which
 *   is the cost the mtime signal exists to avoid.
 *
 * Bounded work is the point. Measuring stops the moment a budget is exceeded,
 * so a sweep inspects at most roughly `AGENT_COMPILE_CACHE_MAX_ENTRIES` files
 * however large the cache has grown. `fs.rm` still traverses what it deletes,
 * but that work buys back the disk.
 *
 * Every deletion is isolated and best-effort. Windows can refuse a blob a live
 * agent still holds open (`EBUSY`/`EPERM`); that directory is counted, logged,
 * and left for the next sweep rather than aborting the pass. Deleting a cache
 * is always safe — Node silently recompiles on a miss, so the worst case of
 * over-eviction is one slower agent launch, never incorrect behaviour.
 *
 * Silent by design: reclamation is not something the user needs to act on, so
 * this logs a summary and never calls `notify()` — matching `ScratchCleanupService`
 * and the log prunes.
 */
import fs from "fs/promises";
import path from "path";
import { app } from "electron";
import { logError, logInfo } from "../utils/logger.js";
import {
  AGENT_COMPILE_CACHE_TTL_MS,
  AGENT_COMPILE_CACHE_MAX_BYTES,
  AGENT_COMPILE_CACHE_MAX_ENTRIES,
} from "../../shared/config/agentCompileCache.js";
import { getAgentCompileCacheRoot } from "./agentCompileCachePaths.js";

export interface AgentCompileCacheCleanupPolicy {
  ttlMs: number;
  maxBytes: number;
  maxEntries: number;
}

export interface AgentCompileCacheCleanupResult {
  /** Version directories discovered across every agent. */
  candidates: number;
  /** Removed by the TTL pass. */
  expiredRemoved: number;
  /** Removed by the budget pass. */
  budgetRemoved: number;
  /** Directories whose removal failed (logged, not rethrown). */
  failed: number;
  /**
   * Files stat'd while measuring. The headline bounded-work figure: it stays
   * near the entry budget no matter how many files the cache actually holds,
   * because TTL-evicted directories are never opened and measuring stops at
   * the first budget overrun.
   */
  entriesInspected: number;
}

export const DEFAULT_AGENT_COMPILE_CACHE_POLICY: AgentCompileCacheCleanupPolicy = {
  ttlMs: AGENT_COMPILE_CACHE_TTL_MS,
  maxBytes: AGENT_COMPILE_CACHE_MAX_BYTES,
  maxEntries: AGENT_COMPILE_CACHE_MAX_ENTRIES,
};

interface VersionDir {
  path: string;
  agentDir: string;
  mtimeMs: number;
}

/**
 * Why a directory was or was not admitted. A three-way status rather than a
 * boolean because "vanished" must not be conflated with "too big": treating a
 * concurrently-removed directory as over budget would latch the budget pass and
 * evict every older cache behind it.
 */
type MeasurementStatus = "fits" | "too-big" | "gone";

interface Measurement {
  bytes: number;
  entries: number;
  inspected: number;
  status: MeasurementStatus;
}

interface Discovery {
  versionDirs: VersionDir[];
  /** Agent directories that hold no version directories at all. */
  emptyAgentDirs: string[];
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/**
 * Immediate real subdirectories of `dir`; `[]` when it cannot be read. An
 * absent directory is the ordinary case and stays quiet, but a genuinely
 * unreadable one is logged — otherwise an EACCES on a 9 GB cache would report
 * a clean sweep forever.
 */
async function listSubdirectories(dir: string): Promise<string[]> {
  const names: string[] = [];
  try {
    const handle = await fs.opendir(dir);
    for await (const entry of handle) {
      // isDirectory() is false for a symlink, so a symlinked entry is never
      // descended into — following one would put `fs.rm` outside the cache.
      if (entry.isDirectory()) names.push(entry.name);
    }
  } catch (error) {
    if (!isNodeError(error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) {
      logError(`[AgentCompileCacheCleanup] Failed to read ${dir}`, error);
    }
    return [];
  }
  return names;
}

/**
 * Every version directory under every agent directory, with its own mtime.
 *
 * A relocated cache root (a symlink onto another volume) is followed
 * deliberately: the spawn path writes through that same symlink, so refusing
 * to sweep it would leave the cache unbounded for exactly the users who moved
 * it. Everything *below* the root must be a real directory, re-checked with
 * `lstat` here so an entry swapped for a symlink between listing and stat is
 * not handed to `fs.rm`.
 */
async function discoverVersionDirs(root: string): Promise<Discovery> {
  const versionDirs: VersionDir[] = [];
  const emptyAgentDirs: string[] = [];
  // Every agent directory is swept, not just the ones currently in
  // NODE_COMPILE_CACHE_AGENTS: dropping an agent from that allowlist would
  // otherwise strand its cache forever.
  for (const agentName of await listSubdirectories(root)) {
    const agentDir = path.join(root, agentName);
    // Re-check the agent component too, not just the version directory below
    // it: an agent directory swapped for a symlink after the root listing would
    // otherwise be an intermediate path component that both `lstat` and
    // `fs.rm` follow straight out of the cache.
    try {
      if (!(await fs.lstat(agentDir)).isDirectory()) continue;
    } catch {
      continue;
    }
    const versionNames = await listSubdirectories(agentDir);
    if (versionNames.length === 0) {
      emptyAgentDirs.push(agentDir);
      continue;
    }
    for (const versionName of versionNames) {
      const versionDir = path.join(agentDir, versionName);
      try {
        const stats = await fs.lstat(versionDir);
        if (!stats.isDirectory()) continue;
        versionDirs.push({ path: versionDir, agentDir, mtimeMs: stats.mtimeMs });
      } catch (error) {
        // A vanished entry is ordinary churn, but an unreadable one hides a
        // whole cache directory from the sweep — say so rather than let a
        // multi-gigabyte tree go silently unreclaimed.
        if (!isNodeError(error) || error.code !== "ENOENT") {
          logError(`[AgentCompileCacheCleanup] Failed to stat ${versionDir}`, error);
        }
      }
    }
  }
  return { versionDirs, emptyAgentDirs };
}

/**
 * Size one version directory, stopping as soon as it cannot fit the remaining
 * budget. The layout is flat (Node writes blobs directly into the version
 * directory), so this never recurses; an unexpected subdirectory is
 * unmeasurable and reported as not fitting, which evicts the directory rather
 * than let an unmeasured subtree escape the budget.
 *
 * Only a vanished blob (`ENOENT`) may be skipped. Any other stat failure means
 * the directory's true size is unknown, and treating unknown as zero would let
 * an arbitrarily large unreadable blob sit inside the budget.
 */
async function measureVersionDir(
  dir: string,
  remainingBytes: number,
  remainingEntries: number
): Promise<Measurement> {
  let bytes = 0;
  let entries = 0;
  let inspected = 0;
  const tooBig = (): Measurement => ({ bytes, entries, inspected, status: "too-big" });

  try {
    const handle = await fs.opendir(dir);
    for await (const entry of handle) {
      if (!entry.isFile()) return tooBig();
      entries += 1;
      if (entries > remainingEntries) return tooBig();
      inspected += 1;
      let stats;
      try {
        stats = await fs.lstat(path.join(dir, entry.name));
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") continue;
        return tooBig();
      }
      if (!stats.isFile()) return tooBig();
      bytes += stats.size;
      if (bytes > remainingBytes) return tooBig();
    }
  } catch (error) {
    // The directory itself disappearing is not evidence that it was too big —
    // reporting it as such would latch the budget pass and evict every older
    // cache behind it.
    if (isNodeError(error) && error.code === "ENOENT") {
      return { bytes, entries, inspected, status: "gone" };
    }
    return tooBig();
  }

  return { bytes, entries, inspected, status: "fits" };
}

/** Best-effort recursive removal. Returns false (logged) on failure. */
async function removeVersionDir(dir: string, reason: string): Promise<boolean> {
  try {
    // `force` absorbs the already-gone race; the retries cover a Windows lock
    // held briefly by an agent that is still writing.
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return true;
  } catch (error) {
    logError(`[AgentCompileCacheCleanup] Failed to remove ${dir} (${reason})`, error);
    return false;
  }
}

/**
 * Drop agent directories that hold nothing. ENOTEMPTY just means a live agent
 * repopulated one mid-sweep, which is not a failure.
 */
async function removeEmptyAgentDirs(agentDirs: Iterable<string>): Promise<void> {
  for (const agentDir of agentDirs) {
    try {
      await fs.rmdir(agentDir);
    } catch (error) {
      if (isNodeError(error) && (error.code === "ENOTEMPTY" || error.code === "ENOENT")) continue;
      logError(`[AgentCompileCacheCleanup] Failed to remove empty agent dir ${agentDir}`, error);
    }
  }
}

/**
 * Sweep the agent compile cache. Returns a summary for tests; production
 * callers go through {@link requestAgentCompileCacheCleanup}. `root` and
 * `policy` are injectable so tests drive real temp directories with tiny budgets.
 */
export async function runAgentCompileCacheCleanup(
  now: number = Date.now(),
  root: string = getAgentCompileCacheRoot(app.getPath("userData")),
  policy: AgentCompileCacheCleanupPolicy = DEFAULT_AGENT_COMPILE_CACHE_POLICY
): Promise<AgentCompileCacheCleanupResult> {
  const result: AgentCompileCacheCleanupResult = {
    candidates: 0,
    expiredRemoved: 0,
    budgetRemoved: 0,
    failed: 0,
    entriesInspected: 0,
  };

  const { versionDirs, emptyAgentDirs } = await discoverVersionDirs(root);
  result.candidates = versionDirs.length;

  // An agent directory left behind with no version directories is pure dead
  // weight — no sweep would otherwise ever visit it.
  const touchedAgentDirs = new Set<string>(emptyAgentDirs);
  if (versionDirs.length === 0) {
    await removeEmptyAgentDirs(touchedAgentDirs);
    return result;
  }

  const expiredBefore = now - policy.ttlMs;
  const survivors: VersionDir[] = [];

  // Pass 1: TTL. An expired directory is removed without ever being opened,
  // which is what keeps a 890K-file cache cheap to reclaim.
  for (const versionDir of versionDirs) {
    if (versionDir.mtimeMs >= expiredBefore) {
      survivors.push(versionDir);
      continue;
    }
    if (await removeVersionDir(versionDir.path, "expired")) {
      result.expiredRemoved += 1;
      touchedAgentDirs.add(versionDir.agentDir);
    } else {
      result.failed += 1;
    }
  }

  // Pass 2: budget. Newest first, so the caches most likely to be hit again
  // are the ones retained.
  survivors.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let remainingBytes = policy.maxBytes;
  let remainingEntries = policy.maxEntries;
  let overBudget = false;

  for (const versionDir of survivors) {
    if (!overBudget) {
      const measurement = await measureVersionDir(
        versionDir.path,
        remainingBytes,
        remainingEntries
      );
      result.entriesInspected += measurement.inspected;
      // Already gone (a concurrent sweep, or the user clearing the cache):
      // nothing to reclaim and, critically, no reason to latch.
      if (measurement.status === "gone") continue;
      if (measurement.status === "fits") {
        remainingBytes -= measurement.bytes;
        remainingEntries -= measurement.entries;
        continue;
      }
      // This directory does not fit, so neither can anything older: every
      // remaining candidate is removed unmeasured.
      overBudget = true;
    }
    if (await removeVersionDir(versionDir.path, "over-budget")) {
      result.budgetRemoved += 1;
      touchedAgentDirs.add(versionDir.agentDir);
    } else {
      result.failed += 1;
    }
  }

  await removeEmptyAgentDirs(touchedAgentDirs);

  if (result.expiredRemoved > 0 || result.budgetRemoved > 0 || result.failed > 0) {
    logInfo(
      `[AgentCompileCacheCleanup] sweep complete: ${result.expiredRemoved} expired, ` +
        `${result.budgetRemoved} over-budget, ${result.failed} failed, ` +
        `${result.entriesInspected} entries inspected of ${result.candidates} directories`
    );
  }

  return result;
}

let inFlight: Promise<AgentCompileCacheCleanupResult> | null = null;

/**
 * Single-flight entry point. Startup, the four-hour periodic tick, and the
 * disk-critical edge can all fire this; without coalescing, two sweeps would
 * race to delete the same directories and each count the other's work as a
 * failure.
 */
export function requestAgentCompileCacheCleanup(): Promise<AgentCompileCacheCleanupResult> {
  if (inFlight) return inFlight;
  inFlight = runAgentCompileCacheCleanup().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Fire-and-forget boot entry point. Never throws into the deferred queue. */
export function initializeAgentCompileCacheCleanup(): void {
  requestAgentCompileCacheCleanup().catch((err) => {
    logError("[AgentCompileCacheCleanup] sweep threw", err);
  });
}
