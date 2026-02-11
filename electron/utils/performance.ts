import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { PerfMarkName } from "../../shared/perf/marks.js";

interface MarkPayload {
  mark: PerfMarkName | string;
  timestamp: string;
  elapsedMs: number;
  meta?: Record<string, unknown>;
}

const APP_BOOT_T0 = performance.now();
const SHOULD_CAPTURE = process.env.CANOPY_PERF_CAPTURE === "1";
const METRICS_FILE = process.env.CANOPY_PERF_METRICS_FILE
  ? path.resolve(process.cwd(), process.env.CANOPY_PERF_METRICS_FILE)
  : null;
const CAPTURE_ENABLED = SHOULD_CAPTURE && Boolean(METRICS_FILE);

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

export function sampleIpcTiming(channel: string, durationMs: number): void {
  if (!CAPTURE_ENABLED) return;

  const sampleRateRaw = Number(process.env.CANOPY_PERF_IPC_SAMPLE_RATE ?? "0.1");
  const sampleRate = Number.isFinite(sampleRateRaw) ? Math.max(0, Math.min(1, sampleRateRaw)) : 0.1;

  if (sampleRate <= 0) return;
  if (Math.random() > sampleRate) return;

  markPerformance("ipc_request_sample", {
    channel,
    durationMs,
  });
}

export function startEventLoopLagMonitor(intervalMs = 1000, thresholdMs = 100): () => void {
  if (!CAPTURE_ENABLED) {
    return () => {};
  }

  let expected = performance.now() + intervalMs;

  const timer = setInterval(() => {
    const now = performance.now();
    const lagMs = Math.max(0, now - expected);
    expected = now + intervalMs;

    if (lagMs >= thresholdMs) {
      markPerformance("event_loop_lag", {
        lagMs,
        intervalMs,
      });
    }
  }, intervalMs);

  timer.unref?.();

  return () => {
    clearInterval(timer);
  };
}
