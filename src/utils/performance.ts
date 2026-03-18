import type { PerfMarkName } from "@shared/perf/marks";
import { isCanopyEnvEnabled } from "./env";

type PerfRecord = {
  mark: PerfMarkName | string;
  timestamp: string;
  elapsedMs: number;
  meta?: Record<string, unknown>;
};

declare global {
  interface Window {
    __CANOPY_PERF_MARKS__?: PerfRecord[];
  }
}

export const RENDERER_T0 = typeof performance !== "undefined" ? performance.now() : Date.now();

export function isRendererPerfCaptureEnabled(): boolean {
  return isCanopyEnvEnabled("CANOPY_PERF_CAPTURE");
}

export function markRendererPerformance(
  mark: PerfMarkName | string,
  meta?: Record<string, unknown>
): void {
  if (typeof window === "undefined") return;

  const captureEnabled = isRendererPerfCaptureEnabled();
  const hasConsumerBuffer = Array.isArray(window.__CANOPY_PERF_MARKS__);
  if (!captureEnabled && !hasConsumerBuffer) {
    return;
  }

  const elapsedMs =
    typeof performance !== "undefined" ? performance.now() - RENDERER_T0 : Date.now() - RENDERER_T0;

  const payload: PerfRecord = {
    mark,
    timestamp: new Date().toISOString(),
    elapsedMs,
    meta,
  };

  if (!window.__CANOPY_PERF_MARKS__) {
    window.__CANOPY_PERF_MARKS__ = [];
  }

  window.__CANOPY_PERF_MARKS__.push(payload);

  if (captureEnabled) {
    console.debug("[perf]", payload.mark, payload.meta ?? {});
  }
}

export function startRendererSpan(
  mark: PerfMarkName | string,
  meta?: Record<string, unknown>
): () => void {
  const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  markRendererPerformance(`${mark}:start`, meta);

  return () => {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    markRendererPerformance(`${mark}:end`, {
      ...(meta ?? {}),
      durationMs: now - startedAt,
    });
  };
}

export async function withRendererSpan<T>(
  mark: PerfMarkName | string,
  task: () => Promise<T>,
  meta?: Record<string, unknown>
): Promise<T> {
  const done = startRendererSpan(mark, meta);
  try {
    return await task();
  } finally {
    done();
  }
}

export function startRendererMemoryMonitor(intervalMs = 15000): () => void {
  if (typeof window === "undefined" || !isRendererPerfCaptureEnabled()) {
    return () => {};
  }

  const timer = window.setInterval(() => {
    const perfWithMemory = performance as Performance & {
      memory?: {
        usedJSHeapSize: number;
        totalJSHeapSize: number;
        jsHeapSizeLimit: number;
      };
    };
    const memory = perfWithMemory.memory;
    if (!memory) return;

    markRendererPerformance("renderer_memory_sample", {
      usedJsHeapBytes: memory.usedJSHeapSize,
      totalJsHeapBytes: memory.totalJSHeapSize,
      jsHeapLimitBytes: memory.jsHeapSizeLimit,
    });
  }, intervalMs);

  return () => {
    window.clearInterval(timer);
  };
}
