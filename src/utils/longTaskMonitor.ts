import { logWarn } from "./logger";
import { isRendererPerfCaptureEnabled, markRendererPerformance, RENDERER_T0 } from "./performance";
import { pluginViewMetrics, type PluginViewMetrics } from "@/services/plugin/pluginViewMetrics";
import { PLUGIN_STYLE_OWNER_ATTRIBUTE } from "@/services/plugin/pluginStyleContract";
import type { PluginLongFrameSource } from "@shared/types/pluginMetrics";

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
 * Host pushes delivered to plugin listeners in this renderer whose dispatch
 * overlapped `[start, end]` (performance.now() clock), as the preload recorded
 * them. Absent outside Electron.
 */
export type PushDeliveryReader = (start: number, end: number) => readonly string[];

function defaultPushDeliveries(start: number, end: number): readonly string[] {
  try {
    return window.electron?.plugin?.pluginsWithPushDeliveriesDuring?.(start, end) ?? [];
  } catch {
    return [];
  }
}

/**
 * Record a long animation frame against every plugin that was active in it.
 *
 * Plugin view code runs through the host's React, so the frame's `scripts`
 * almost never name a `plugin://` URL, and production React never calls the
 * `Profiler`. So four observations are checked, strongest first, and a plugin
 * is recorded once per frame under the first that matches:
 *   - `script`: a script from the plugin's `plugin://` origin ran in the frame;
 *   - `commit`: one of its views committed in it (development builds);
 *   - `input`: a UI event was dispatched inside one of its style roots in it;
 *   - `push`: a host push was delivered to its listeners in it.
 * Each is "the plugin was active", never the cause. Every frame the browser
 * reports is considered (Blink's floor is 50ms); the warning threshold below
 * is about log noise, not about what counts as a long frame.
 */
export function attributeLongFrameToPlugins(
  entry: PerformanceLongAnimationFrameTiming,
  metrics: PluginViewMetrics = pluginViewMetrics,
  pushDeliveries: PushDeliveryReader = defaultPushDeliveries
): void {
  if (!metrics.isTracking()) return;

  const at = Math.round(
    (typeof performance.timeOrigin === "number"
      ? performance.timeOrigin
      : Date.now() - performance.now()) + entry.startTime
  );
  const durationMs = entry.duration;
  const blockingMs = entry.blockingDuration ?? 0;

  const recorded: string[] = [];
  const record = (pluginId: string, source: PluginLongFrameSource): void => {
    if (recorded.includes(pluginId)) return;
    recorded.push(pluginId);
    metrics.recordLongFrame(pluginId, { durationMs, blockingMs, source, at });
  };

  for (const script of entry.scripts ?? []) {
    const pluginId = script.sourceURL ? metrics.pluginIdForScriptUrl(script.sourceURL) : undefined;
    if (pluginId) record(pluginId, "script");
  }

  const start = entry.startTime;
  const end = entry.startTime + entry.duration;
  for (const pluginId of metrics.pluginsCommittingDuring(start, end)) record(pluginId, "commit");
  for (const pluginId of metrics.pluginsWithInputDuring(start, end)) record(pluginId, "input");
  for (const pluginId of pushDeliveries(start, end)) {
    if (typeof pluginId === "string" && pluginId.length > 0) record(pluginId, "push");
  }
}

/** UI events whose dispatch inside a plugin style root places the plugin in that frame. */
const PLUGIN_INPUT_EVENTS = ["pointerdown", "keydown", "input", "wheel", "click"] as const;
const OWNER_SELECTOR = `[${PLUGIN_STYLE_OWNER_ATTRIBUTE}]`;

/**
 * Note UI events dispatched inside plugin style roots, for
 * {@link attributeLongFrameToPlugins}. One passive capture listener per event
 * type on the document, not one per view, so a portal the view tagged counts
 * too. The capture phase runs at the start of the event's dispatch, which is
 * inside the frame that handles it; with no plugin view open it returns before
 * touching the DOM.
 */
export function startPluginInputTracking(
  target: Pick<Document, "addEventListener" | "removeEventListener"> = document,
  metrics: PluginViewMetrics = pluginViewMetrics
): () => void {
  const onEvent = (event: Event): void => {
    if (!metrics.isTracking()) return;
    const node = event.target;
    if (!(node instanceof Element)) return;
    const owner = node.closest(OWNER_SELECTOR)?.getAttribute(PLUGIN_STYLE_OWNER_ATTRIBUTE);
    if (owner) metrics.recordInput(owner, performance.now());
  };
  const options: AddEventListenerOptions = { capture: true, passive: true };
  for (const type of PLUGIN_INPUT_EVENTS) target.addEventListener(type, onEvent, options);
  return () => {
    for (const type of PLUGIN_INPUT_EVENTS) target.removeEventListener(type, onEvent, options);
  };
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
  let stopInputTracking: () => void = () => {};

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
    if (typeof document !== "undefined") stopInputTracking = startPluginInputTracking();
  } catch {
    observer?.disconnect();
    stopInputTracking();
    return () => {};
  }

  return () => {
    observer?.disconnect();
    stopInputTracking();
  };
}
