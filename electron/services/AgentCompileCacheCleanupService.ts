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

interface Measurement {
  bytes: number;
  entries: number;
  inspected: number;
  /** False when the directory blew a budget or could not be measured. */
  fits: boolean;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/** Immediate real subdirectories of `dir`; `[]` when it cannot be read. */
async function listSubdirectories(dir: string): Promise<string[]> {
  const names: string[] = [];
  try {
    const handle = await fs.opendir(dir);
    for await (const entry of handle) {
      // isDirectory() is false for symlinks, so a symlinked directory is never
      // followed — the cache holds no symlinks, and following one would put
      // `fs.rm` outside the cache root.
      if (entry.isDirectory()) names.push(entry.name);
    }
  } catch {
    // Absent or unreadable root/agent directory — nothing to reclaim here.
    return [];
  }
  return names;
}

/** Every version directory under every agent directory, with its own mtime. */
async function discoverVersionDirs(root: string): Promise<VersionDir[]> {
  const found: VersionDir[] = [];
  // Every agent directory is swept, not just the ones currently in
  // NODE_COMPILE_CACHE_AGENTS: dropping an agent from that allowlist would
  // otherwise strand its cache forever.
  for (const agentName of await listSubdirectories(root)) {
    const agentDir = path.join(root, agentName);
    for (const versionName of await listSubdirectories(agentDir)) {
      const versionDir = path.join(agentDir, versionName);
      try {
        const stats = await fs.stat(versionDir);
        found.push({ path: versionDir, agentDir, mtimeMs: stats.mtimeMs });
      } catch {
        // Vanished or unreadable between listing and stat — skip it.
      }
    }
  }
  return found;
}

/**
 * Size one version directory, stopping as soon as it cannot fit the remaining
 * budget. The layout is flat (Node writes blobs directly into the version
 * directory), so this never recurses; an unexpected subdirectory is
 * unmeasurable and reported as not fitting, which evicts the directory rather
 * than let an unmeasured subtree escape the budget.
 */
async function measureVersionDir(
  dir: string,
  remainingBytes: number,
  remainingEntries: number
): Promise<Measurement> {
  let bytes = 0;
  let entries = 0;
  let inspected = 0;

  try {
    const handle = await fs.opendir(dir);
    for await (const entry of handle) {
      if (!entry.isFile()) return { bytes, entries, inspected, fits: false };
      entries += 1;
      if (entries > remainingEntries) return { bytes, entries, inspected, fits: false };
      let size = 0;
      try {
        const stats = await fs.lstat(path.join(dir, entry.name));
        inspected += 1;
        size = stats.size;
      } catch {
        // A blob that vanished mid-measure contributes nothing; the directory
        // is still measurable.
        continue;
      }
      bytes += size;
      if (bytes > remainingBytes) return { bytes, entries, inspected, fits: false };
    }
  } catch {
    return { bytes, entries, inspected, fits: false };
  }

  return { bytes, entries, inspected, fits: true };
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

  const versionDirs = await discoverVersionDirs(root);
  result.candidates = versionDirs.length;
  if (versionDirs.length === 0) return result;

  const touchedAgentDirs = new Set<string>();
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
      if (measurement.fits) {
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

  // An agent directory emptied by this sweep is itself dead weight. ENOTEMPTY
  // just means a live agent repopulated it, which is not a failure.
  for (const agentDir of touchedAgentDirs) {
    try {
      await fs.rmdir(agentDir);
    } catch (error) {
      if (isNodeError(error) && (error.code === "ENOTEMPTY" || error.code === "ENOENT")) continue;
      logError(`[AgentCompileCacheCleanup] Failed to remove empty agent dir ${agentDir}`, error);
    }
  }

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
