import { logWarn } from "./logger";
import { isRendererPerfCaptureEnabled, markRendererPerformance, RENDERER_T0 } from "./performance";

const STARTUP_SUPPRESSION_MS = 5_000;
const WARN_RATE_LIMIT_MS = 10_000;
const MAX_TOP_SCRIPTS = 3;

declare global {
  interface PerformanceScriptTiming extends PerformanceEntry {
    readonly invoker: string;
    readonly invokerType: string;
    readonly executionStart: number;
    readonly sourceURL: string;
    readonly sourceFunctionName: string;
    readonly sourceCharPosition: number;
    readonly forcedStyleAndLayoutDuration: number;
    readonly pauseDuration: number;
    readonly windowAttribution: string;
  }

  interface PerformanceLongAnimationFrameTiming extends PerformanceEntry {
    readonly blockingDuration: number;
    readonly renderStart: number;
    readonly styleAndLayoutStart: number;
    readonly firstUIEventTimestamp: number;
    readonly presentationTime: number;
    readonly paintTime: number;
    readonly scripts: PerformanceScriptTiming[];
  }

  interface PerformanceObserverInit {
    durationThreshold?: number;
  }
}

type ScriptSummary = {
  invoker: string;
  invokerType: string;
  sourceURL: string;
  sourceFunctionName: string;
  durationMs: number;
  forcedStyleAndLayoutDurationMs: number;
};

function summarizeScripts(scripts: PerformanceScriptTiming[]): ScriptSummary[] {
  return [...scripts]
    .sort((a, b) => b.duration - a.duration)
    .slice(0, MAX_TOP_SCRIPTS)
    .map((s) => ({
      invoker: s.invoker,
      invokerType: s.invokerType,
      sourceURL: s.sourceURL,
      sourceFunctionName: s.sourceFunctionName,
      durationMs: Number(s.duration.toFixed(3)),
      forcedStyleAndLayoutDurationMs: Number(s.forcedStyleAndLayoutDuration.toFixed(3)),
    }));
}

export function startLongTaskMonitor(thresholdMs = 100): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  if (typeof PerformanceObserver === "undefined") {
    return () => {};
  }

  let observer: PerformanceObserver | null = null;
  let lastWarnTime = -Infinity;

  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as PerformanceLongAnimationFrameTiming[]) {
        const topScripts = summarizeScripts(entry.scripts ?? []);
        const topScript = topScripts[0];

        const now = performance.now();
        const elapsed = now - RENDERER_T0;
        if (elapsed > STARTUP_SUPPRESSION_MS && now - lastWarnTime >= WARN_RATE_LIMIT_MS) {
          lastWarnTime = now;
          logWarn("Renderer long animation frame detected", {
            durationMs: Number(entry.duration.toFixed(3)),
            blockingDurationMs: Number(entry.blockingDuration.toFixed(3)),
            scriptCount: entry.scripts?.length ?? 0,
            ...(topScript
              ? {
                  invoker: topScript.invoker,
                  invokerType: topScript.invokerType,
                  sourceURL: topScript.sourceURL,
                  sourceFunctionName: topScript.sourceFunctionName,
                }
              : {}),
          });
        }

        if (isRendererPerfCaptureEnabled()) {
          markRendererPerformance("renderer_long_animation_frame", {
            startTimeMs: Number(entry.startTime.toFixed(3)),
            durationMs: Number(entry.duration.toFixed(3)),
            blockingDurationMs: Number(entry.blockingDuration.toFixed(3)),
            renderStartMs: Number(entry.renderStart.toFixed(3)),
            styleAndLayoutStartMs: Number(entry.styleAndLayoutStart.toFixed(3)),
            firstUIEventTimestampMs: Number(entry.firstUIEventTimestamp.toFixed(3)),
            presentationTimeMs: Number(entry.presentationTime.toFixed(3)),
            paintTimeMs: Number(entry.paintTime.toFixed(3)),
            scriptCount: entry.scripts?.length ?? 0,
            topScripts,
          });
        }
      }
    });

    observer.observe({ type: "long-animation-frame", durationThreshold: thresholdMs });
  } catch {
    observer?.disconnect();
    return () => {};
  }

  return () => {
    observer?.disconnect();
  };
}
