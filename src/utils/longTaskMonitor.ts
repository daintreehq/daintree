import { logWarn } from "./logger";
import { isRendererPerfCaptureEnabled, markRendererPerformance, RENDERER_T0 } from "./performance";

const STARTUP_SUPPRESSION_MS = 5_000;
const WARN_RATE_LIMIT_MS = 10_000;

export function startLongTaskMonitor(thresholdMs = 100): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  if (typeof PerformanceObserver === "undefined") {
    return () => {};
  }

  let observer: PerformanceObserver | null = null;
  let lastWarnTime = 0;

  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration < thresholdMs) continue;

        const now = performance.now();
        const elapsed = now - RENDERER_T0;
        if (elapsed > STARTUP_SUPPRESSION_MS && now - lastWarnTime >= WARN_RATE_LIMIT_MS) {
          lastWarnTime = now;
          logWarn("Renderer long task detected", {
            durationMs: Number(entry.duration.toFixed(3)),
            name: entry.name,
          });
        }

        if (isRendererPerfCaptureEnabled()) {
          markRendererPerformance("renderer_long_task", {
            name: entry.name,
            startTimeMs: Number(entry.startTime.toFixed(3)),
            durationMs: Number(entry.duration.toFixed(3)),
          });
        }
      }
    });

    observer.observe({ entryTypes: ["longtask"] });
  } catch {
    return () => {};
  }

  return () => {
    observer?.disconnect();
  };
}
