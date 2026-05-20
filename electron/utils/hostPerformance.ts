import fs from "node:fs";
import { getCompileCacheDir } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { PerfMarkName } from "../../shared/perf/marks.js";

// Utility-process-safe perf helper. Mirrors the env-gated NDJSON-append pattern
// in electron/utils/performance.ts but is safe to import from pty-host.ts and
// workspace-host.ts — those run in their own UtilityProcess with a distinct
// `performance.timeOrigin`, so they cannot reuse the main-process `APP_BOOT_T0`
// constant for elapsed-time math. Instead, `elapsedMs` is measured from the
// parent's `utilityProcess.fork()` call, anchored via `DAINTREE_PERF_FORK_ABS_MS`
// (parent's `performance.timeOrigin + performance.now()` at fork time).

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

const FORK_ABS_MS_RAW = Number(process.env.DAINTREE_PERF_FORK_ABS_MS ?? "0");
const FORK_ABS_MS =
  Number.isFinite(FORK_ABS_MS_RAW) && FORK_ABS_MS_RAW > 0 ? FORK_ABS_MS_RAW : null;

const PROCESS_KIND = process.env.DAINTREE_UTILITY_PROCESS_KIND ?? null;

/**
 * Compute a Unix-epoch ms wall-clock now() in this utility process. The result
 * matches the parent's `mainTimeOrigin + APP_BOOT_T0 + elapsedSinceBoot` so
 * cross-process subtraction against `DAINTREE_PERF_FORK_ABS_MS` is valid.
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
 * unset, matching the gating in `electron/utils/performance.ts`. The
 * `elapsedMs` field is the wall-clock delta since the parent dispatched
 * `utilityProcess.fork()`, so host marks land on the same timeline as the
 * parent's `pty_host_fork_dispatched` / `workspace_host_fork_dispatched`
 * marks.
 */
export function markHostPerformance(
  mark: PerfMarkName | string,
  meta?: Record<string, unknown>
): void {
  if (!CAPTURE_ENABLED) return;

  const now = nowAbsMs();
  const elapsedMs = FORK_ABS_MS !== null ? now - FORK_ABS_MS : performance.now();

  const baseMeta: Record<string, unknown> = {};
  if (PROCESS_KIND) baseMeta.processKind = PROCESS_KIND;
  if (FORK_ABS_MS !== null) baseMeta.sinceForkMs = now - FORK_ABS_MS;

  const mergedMeta = { ...baseMeta, ...(meta ?? {}) };

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
 * count files — there's no programmatic API for cache hit/miss in Node 22+
 * (`--trace-compile-cache-statistics` is CLI-only).
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
