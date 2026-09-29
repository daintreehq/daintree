import { logWarn } from "./logger";
import { isRendererPerfCaptureEnabled, markRendererPerformance, RENDERER_T0 } from "./performance";
import { pluginViewMetrics, type PluginViewMetrics } from "@/services/plugin/pluginViewMetrics";

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

/**
 * Record a long animation frame against every plugin that was active in it.
 *
 * A script served from a plugin's `plugin://` origin names that plugin
 * directly. React-scheduled render work runs from host chunks, though, so a
 * plugin view's own render shows up under the app's URL — for those the frame
 * is matched against the plugin's recent Profiler commit windows instead. Both
 * are recorded as "the plugin was active", never as the cause. Every frame the
 * browser reports is considered (Blink's floor is 50ms); the warning threshold
 * below is about log noise, not about what counts as a long frame.
 */
export function attributeLongFrameToPlugins(
  entry: PerformanceLongAnimationFrameTiming,
  metrics: PluginViewMetrics = pluginViewMetrics
): void {
  if (!metrics.isTracking()) return;

  const at = Math.round(
    (typeof performance.timeOrigin === "number"
      ? performance.timeOrigin
      : Date.now() - performance.now()) + entry.startTime
  );
  const durationMs = entry.duration;
  const blockingMs = entry.blockingDuration ?? 0;

  let scriptPlugins: string[] | undefined;
  for (const script of entry.scripts ?? []) {
    const pluginId = script.sourceURL ? metrics.pluginIdForScriptUrl(script.sourceURL) : undefined;
    if (!pluginId) continue;
    scriptPlugins ??= [];
    if (scriptPlugins.includes(pluginId)) continue;
    scriptPlugins.push(pluginId);
    metrics.recordLongFrame(pluginId, { durationMs, blockingMs, source: "script", at });
  }

  for (const pluginId of metrics.pluginsCommittingDuring(
    entry.startTime,
    entry.startTime + entry.duration
  )) {
    if (scriptPlugins?.includes(pluginId)) continue;
    metrics.recordLongFrame(pluginId, { durationMs, blockingMs, source: "commit", at });
  }
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
        attributeLongFrameToPlugins(entry);

        const topScripts = summarizeScripts(entry.scripts ?? []);
        const topScript = topScripts[0];

        const now = performance.now();
        const elapsed = now - RENDERER_T0;
        // Blink has no per-observer duration filter for long-animation-frame, so the
        // threshold has to be enforced here. The capture block below stays outside this
        // guard on purpose: it is opt-in and wants every frame the browser reported.
        if (
          entry.duration >= thresholdMs &&
          elapsed > STARTUP_SUPPRESSION_MS &&
          now - lastWarnTime >= WARN_RATE_LIMIT_MS
        ) {
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

    observer.observe({ type: "long-animation-frame" });
  } catch {
    observer?.disconnect();
    return () => {};
  }

  return () => {
    observer?.disconnect();
  };
}
