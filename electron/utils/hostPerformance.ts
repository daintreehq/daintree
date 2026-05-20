import fs from "node:fs";
import { getCompileCacheDir } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { PerfMarkName } from "../../shared/perf/marks.js";

// Utility-process-safe perf helper. Mirrors the env-gated NDJSON-append pattern
// in electron/utils/performance.ts but is safe to import from pty-host.ts and
// workspace-host.ts — those run in their own UtilityProcess with a distinct
// `performance.timeOrigin`, so they cannot reuse the main-process `APP_BOOT_T0`
// constant directly. The parent injects two anchor env vars at fork time:
//   * DAINTREE_PERF_FORK_ABS_MS — `performance.timeOrigin + performance.now()`
//     captured immediately before `utilityProcess.fork()`. Used for the
//     fork-relative `sinceForkMs` field.
//   * DAINTREE_PERF_MAIN_BOOT_ABS_MS — `mainTimeOrigin + APP_BOOT_T0` from the
//     main process. Used to compute `elapsedMs` on the same boot-relative
//     timeline as the parent's marks, so cross-process phase analysis (e.g.
//     `pty_host_fork_dispatched.elapsedMs` vs `pty_host_ready_posted.elapsedMs`)
//     produces meaningful deltas. Falls back to fork-relative or
//     `performance.now()` when the anchor is missing.

interface HostMarkPayload {
  mark: PerfMarkName | string;
  timestamp: string;
  elapsedMs: number;
  meta?: Record<string, unknown>;
}

const SHOULD_CAPTURE = process.env.DAINTREE_PERF_CAPTURE === "1";
const METRICS_FILE = process.env.DAINTREE_PERF_METRICS_FILE
  ? path.resolve(process.cwd(), process.env.DAINTREE_PERF_METRICS_FILE)
  : null;
const CAPTURE_ENABLED = SHOULD_CAPTURE && Boolean(METRICS_FILE);

function readPositiveFiniteEnv(name: string): number | null {
  const raw = Number(process.env[name] ?? "0");
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

const FORK_ABS_MS = readPositiveFiniteEnv("DAINTREE_PERF_FORK_ABS_MS");
const MAIN_BOOT_ABS_MS = readPositiveFiniteEnv("DAINTREE_PERF_MAIN_BOOT_ABS_MS");

const PROCESS_KIND = process.env.DAINTREE_UTILITY_PROCESS_KIND ?? null;
const WORKSPACE_SERVICE_NAME = process.env.DAINTREE_WORKSPACE_SERVICE_NAME ?? null;

/**
 * Compute a Unix-epoch ms wall-clock now() in this utility process. The result
 * matches the parent's `mainTimeOrigin + APP_BOOT_T0 + elapsedSinceBoot` so
 * cross-process subtraction against the env-injected anchors is valid.
 */
function nowAbsMs(): number {
  return performance.timeOrigin + performance.now();
}

function appendPayload(payload: HostMarkPayload): void {
  if (!CAPTURE_ENABLED || !METRICS_FILE) return;

  try {
    fs.mkdirSync(path.dirname(METRICS_FILE), { recursive: true });
    fs.appendFileSync(METRICS_FILE, `${JSON.stringify(payload)}\n`, "utf-8");
  } catch {
    // Never fail host flow because of performance logging.
  }
}

/**
 * Emit a perf mark from a utility-process host. Silently no-ops when
 * `DAINTREE_PERF_CAPTURE` is not enabled or `DAINTREE_PERF_METRICS_FILE` is
 * unset, matching the gating in `electron/utils/performance.ts`. When the
 * parent injects `DAINTREE_PERF_MAIN_BOOT_ABS_MS`, `elapsedMs` is the ms
 * since main-process boot — directly comparable to parent marks. Callers
 * cannot override the env-derived `processKind`, `sinceForkMs`, or
 * `workspaceServiceName` meta keys (base wins).
 */
export function markHostPerformance(
  mark: PerfMarkName | string,
  meta?: Record<string, unknown>
): void {
  if (!CAPTURE_ENABLED) return;

  const now = nowAbsMs();

  let elapsedMs: number;
  if (MAIN_BOOT_ABS_MS !== null) {
    elapsedMs = now - MAIN_BOOT_ABS_MS;
  } else if (FORK_ABS_MS !== null) {
    elapsedMs = now - FORK_ABS_MS;
  } else {
    elapsedMs = performance.now();
  }

  const baseMeta: Record<string, unknown> = {};
  if (PROCESS_KIND) baseMeta.processKind = PROCESS_KIND;
  if (WORKSPACE_SERVICE_NAME) baseMeta.workspaceServiceName = WORKSPACE_SERVICE_NAME;
  if (FORK_ABS_MS !== null) baseMeta.sinceForkMs = now - FORK_ABS_MS;

  // Caller meta spreads FIRST so base meta keys (processKind, sinceForkMs,
  // workspaceServiceName) are non-overridable — protects the cross-process
  // identity fields from accidental clobbering.
  const mergedMeta = { ...(meta ?? {}), ...baseMeta };

  const payload: HostMarkPayload = {
    mark,
    timestamp: new Date().toISOString(),
    elapsedMs,
    meta: Object.keys(mergedMeta).length > 0 ? mergedMeta : undefined,
  };

  appendPayload(payload);
}

export function isHostPerformanceCaptureEnabled(): boolean {
  return CAPTURE_ENABLED;
}

/**
 * Snapshot of the V8 compile-cache state for inclusion in `module_eval_complete`
 * marks. `cacheFileCount > 0` on a second launch confirms `enableCompileCache()`
 * is populating the cache directory; `0` on every launch indicates the cache is
 * silently failing (e.g. directory churn from auto-update or packaged-build path
 * changes). The directory uses opaque content-hash filenames so we can only
 * count directory entries — there's no programmatic API for cache hit/miss in
 * Node 22+ (`--trace-compile-cache-statistics` is CLI-only).
 */
export function getCompileCacheMeta(): Record<string, unknown> {
  try {
    const dir = getCompileCacheDir();
    if (!dir) return { compileCacheEnabled: false };

    let cacheFileCount = 0;
    try {
      const entries = fs.readdirSync(dir);
      cacheFileCount = entries.length;
    } catch {
      // Directory might not exist yet on first launch — that's a 0 count.
    }

    return {
      compileCacheEnabled: true,
      compileCacheDir: dir,
      cacheFileCount,
    };
  } catch {
    return { compileCacheEnabled: false };
  }
}
