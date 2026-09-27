// eager-import-allow: reads performance markers via sync fs
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { PerfMarkName } from "../../shared/perf/marks.js";
import { logWarn } from "./logger.js";

interface MarkPayload {
  mark: PerfMarkName | string;
  timestamp: string;
  elapsedMs: number;
  meta?: Record<string, unknown>;
}

interface IpcSampleMeta {
  traceId?: string;
  requestPayload?: unknown;
  responsePayload?: unknown;
  errored?: boolean;
}

export const APP_BOOT_T0 = performance.now();
export const mainTimeOrigin = performance.timeOrigin;
/**
 * Wall-clock (Unix epoch ms, float) at which the main process recorded
 * `APP_BOOT_T0`. Forwarded to utility-process hosts as
 * `DAINTREE_PERF_MAIN_BOOT_ABS_MS` so the host's `elapsedMs` can be rebased
 * onto the same boot-relative timeline that the main process uses,
 * unblocking cross-process phase-pair analysis.
 */
export const mainBootAbsMs = mainTimeOrigin + APP_BOOT_T0;
const SHOULD_CAPTURE = process.env.DAINTREE_PERF_CAPTURE === "1";
const METRICS_FILE = process.env.DAINTREE_PERF_METRICS_FILE
  ? path.resolve(process.cwd(), process.env.DAINTREE_PERF_METRICS_FILE)
  : null;
const CAPTURE_ENABLED = SHOULD_CAPTURE && Boolean(METRICS_FILE);

// `os_to_app_boot_ms` measures the wall-clock gap between the spawning
// process (e.g. Playwright in the cold-start harness) calling `electron.launch`
// and the main process module load that captures `APP_BOOT_T0`. This window
// hides Gatekeeper / Defender / notarization scans that `APP_BOOT_START`
// cannot see. The spawning process injects a `Date.now()` snapshot via env
// because `performance.now()` clocks are per-process and cannot be subtracted.
const SPAWN_WALL_MS_RAW = Number(process.env.DAINTREE_PERF_SPAWN_WALL_MS ?? "0");
const SPAWN_WALL_MS =
  Number.isFinite(SPAWN_WALL_MS_RAW) && SPAWN_WALL_MS_RAW > 0 ? SPAWN_WALL_MS_RAW : null;

/**
 * OS-to-app-boot wall-clock gap (ms), or `null` when no spawn anchor was
 * injected (production launches, project-switch restores, manual `electron .`).
 * Computed once at module load: `(mainTimeOrigin + APP_BOOT_T0) - spawnWallMs`.
 * The result is a Unix-epoch delta so cross-process subtraction is valid.
 */
export const osToAppBootMs: number | null =
  SPAWN_WALL_MS !== null ? mainTimeOrigin + APP_BOOT_T0 - SPAWN_WALL_MS : null;

export function getOsToAppBootMs(): number | null {
  return osToAppBootMs;
}

function appendPayload(payload: MarkPayload): void {
  if (!CAPTURE_ENABLED || !METRICS_FILE) return;

  try {
    fs.mkdirSync(path.dirname(METRICS_FILE), { recursive: true });
    fs.appendFileSync(METRICS_FILE, `${JSON.stringify(payload)}\n`, "utf-8");
  } catch {
    // Never fail app flow because of performance logging.
  }
}

export function markPerformance(mark: PerfMarkName | string, meta?: Record<string, unknown>): void {
  if (!CAPTURE_ENABLED) {
    return;
  }

  const payload: MarkPayload = {
    mark,
    timestamp: new Date().toISOString(),
    elapsedMs: performance.now() - APP_BOOT_T0,
    meta,
  };

  appendPayload(payload);
}

export function isPerformanceCaptureEnabled(): boolean {
  return CAPTURE_ENABLED;
}

export function startPerformanceSpan(
  mark: PerfMarkName | string,
  meta?: Record<string, unknown>
): () => void {
  const startedAt = performance.now();
  markPerformance(`${mark}:start`, meta);

  return () => {
    const durationMs = performance.now() - startedAt;
    markPerformance(`${mark}:end`, {
      ...(meta ?? {}),
      durationMs,
    });
  };
}

export async function withPerformanceSpan<T>(
  mark: PerfMarkName | string,
  task: () => Promise<T>,
  meta?: Record<string, unknown>
): Promise<T> {
  const done = startPerformanceSpan(mark, meta);
  try {
    return await task();
  } finally {
    done();
  }
}

function estimatePayloadBytes(payload: unknown): number | null {
  if (payload === undefined) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(payload), "utf8");
  } catch {
    return null;
  }
}

export function sampleIpcTiming(channel: string, durationMs: number, meta?: IpcSampleMeta): void {
  if (!CAPTURE_ENABLED) return;

  const sampleRateRaw = Number(process.env.DAINTREE_PERF_IPC_SAMPLE_RATE ?? "0.1");
  const sampleRate = Number.isFinite(sampleRateRaw) ? Math.max(0, Math.min(1, sampleRateRaw)) : 0.1;

  if (sampleRate <= 0) return;
  if (Math.random() > sampleRate) return;

  const requestBytes = estimatePayloadBytes(meta?.requestPayload);
  const responseBytes = estimatePayloadBytes(meta?.responsePayload);

  markPerformance("ipc_request_sample", {
    channel,
    durationMs,
    traceId: meta?.traceId ?? null,
    requestBytes,
    responseBytes,
    errored: Boolean(meta?.errored),
  });
}

const STARTUP_SUPPRESSION_MS = 5_000;
const WARN_RATE_LIMIT_MS = 10_000;

/**
 * Power transitions, injected by the caller because this module is also
 * loaded by utility processes that have no powerMonitor.
 */
export interface EventLoopLagPowerEvents {
  onSuspend(callback: () => void): () => void;
  onResume(callback: () => void): () => void;
}

/**
 * performance.now() keeps running through system sleep on macOS, so the first
 * tick after a wake sees the whole sleep as lag. Resume and that overdue tick
 * arrive in no guaranteed order, and suspend can be missed entirely, so an
 * over-threshold sample is held for one interval and dropped if any power
 * transition lands before it is confirmed. A resume delivered later than that
 * can still let one sample through, and a resume that never arrives leaves the
 * monitor quiet until the next one: ticks while suspended may be dark wakes, so
 * they cannot be taken as proof the machine is awake.
 */
export function startEventLoopLagMonitor(
  intervalMs = 1000,
  thresholdMs = 100,
  powerEvents?: EventLoopLagPowerEvents
): () => void {
  let expected = performance.now() + intervalMs;
  let lastWarnTime = -Infinity;
  let suspended = false;
  let stopped = false;
  let pending: { lagMs: number; observedAt: number } | null = null;

  const emit = (sample: { lagMs: number; observedAt: number }): void => {
    const { lagMs, observedAt } = sample;
    if (
      observedAt - APP_BOOT_T0 > STARTUP_SUPPRESSION_MS &&
      observedAt - lastWarnTime >= WARN_RATE_LIMIT_MS
    ) {
      lastWarnTime = observedAt;
      logWarn("Event loop lag detected", { lagMs: Math.round(lagMs), intervalMs });
    }

    if (CAPTURE_ENABLED) {
      markPerformance("event_loop_lag", { lagMs, intervalMs });
    }
  };

  const timer = setInterval(() => {
    if (suspended) return;

    const now = performance.now();
    const lagMs = Math.max(0, now - expected);
    expected = now + intervalMs;

    if (pending) {
      emit(pending);
      pending = null;
    }

    if (lagMs >= thresholdMs) {
      pending = { lagMs, observedAt: now };
    }
  }, intervalMs);

  timer.unref?.();

  const unsubscribeSuspend = powerEvents?.onSuspend(() => {
    if (stopped) return;
    suspended = true;
    pending = null;
  });
  const unsubscribeResume = powerEvents?.onResume(() => {
    if (stopped) return;
    suspended = false;
    pending = null;
    expected = performance.now() + intervalMs;
  });

  return () => {
    if (stopped) return;
    stopped = true;
    pending = null;
    clearInterval(timer);
    unsubscribeSuspend?.();
    unsubscribeResume?.();
  };
}

export function startProcessMemoryMonitor(intervalMs = 15000): () => void {
  if (!CAPTURE_ENABLED) {
    return () => {};
  }

  const timer = setInterval(() => {
    const usage = process.memoryUsage();
    markPerformance("process_memory_sample", {
      rssBytes: usage.rss,
      heapTotalBytes: usage.heapTotal,
      heapUsedBytes: usage.heapUsed,
      externalBytes: usage.external,
      arrayBuffersBytes: usage.arrayBuffers,
    });
  }, intervalMs);

  timer.unref?.();

  return () => {
    clearInterval(timer);
  };
}

export function rebaseRendererElapsedMs(
  rendererTimeOrigin: number,
  rendererT0: number,
  elapsedMs: number
): number {
  return rendererTimeOrigin + rendererT0 + elapsedMs - (mainTimeOrigin + APP_BOOT_T0);
}

export { appendPayload };
