import type { PerfMarkName } from "@shared/perf/marks";

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

const RENDERER_T0 = typeof performance !== "undefined" ? performance.now() : Date.now();

function isRendererPerfCaptureEnabled(): boolean {
  return (
    typeof process !== "undefined" &&
    typeof process.env !== "undefined" &&
    process.env.CANOPY_PERF_CAPTURE === "1"
  );
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
