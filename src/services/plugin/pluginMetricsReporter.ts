import type { PluginRendererMetricsEnvelope } from "@shared/types/ipc/pluginMetrics";
import {
  pluginViewMetrics,
  type PluginViewMetrics,
  type TaggedPluginReport,
} from "./pluginViewMetrics";

/**
 * Drains this renderer's plugin view observations to main in batches.
 *
 * Lazy by construction: nothing runs until the registry reports its first
 * delta after a drain, so a project view with no plugin views open costs
 * three idle listeners. A view load drains after a short debounce, since it is
 * one sample per open and the number someone opening a view is waiting for.
 * The registry's early drain request (a buffer at 75% of its cap) and the page
 * going hidden or away drain immediately, so a report is neither sampled nor
 * lost with the page.
 */

/** Delay between the first delta after a drain and the drain itself. */
export const REPORT_DRAIN_DELAY_MS = 2_000;
/** Delay between a view load and the drain that carries it (and anything else pending). */
export const VIEW_LOAD_DRAIN_DELAY_MS = 250;

type DrainRegistry = Pick<
  PluginViewMetrics,
  "subscribe" | "onDrainRequested" | "drainTaggedReports"
> &
  Partial<Pick<PluginViewMetrics, "onViewLoadRecorded">>;

interface ListenerTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface PluginMetricsReporterOptions {
  registry?: DrainRegistry;
  send?: (reports: PluginRendererMetricsEnvelope[]) => void;
  /** Defaults to `document`; `null` opts out of visibility draining. */
  target?: (ListenerTarget & { readonly visibilityState: string }) | null;
  /** Defaults to `window`; `null` opts out of `pagehide` draining. */
  pageTarget?: ListenerTarget | null;
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
  queueMicrotask?: (fn: () => void) => void;
}

function defaultSend(reports: PluginRendererMetricsEnvelope[]): void {
  window.electron?.plugin?.reportViewMetrics?.(reports);
}

export function startPluginMetricsReporter(options: PluginMetricsReporterOptions = {}): () => void {
  const registry = options.registry ?? pluginViewMetrics;
  const send = options.send ?? defaultSend;
  const doc = options.target === undefined ? globalThis.document : options.target;
  const page = options.pageTarget === undefined ? globalThis.window : options.pageTarget;
  const schedule = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = options.clearTimeout ?? ((handle) => clearTimeout(handle));
  const microtask = options.queueMicrotask ?? ((fn) => queueMicrotask(fn));

  let timer: ReturnType<typeof setTimeout> | null = null;
  let viewLoadTimer: ReturnType<typeof setTimeout> | null = null;
  let microtaskQueued = false;
  let stopped = false;

  const drain = (): void => {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
    if (viewLoadTimer !== null) {
      cancel(viewLoadTimer);
      viewLoadTimer = null;
    }
    if (stopped) return;
    let tagged: TaggedPluginReport[];
    try {
      tagged = registry.drainTaggedReports();
    } catch {
      return;
    }
    // A report with no load could never match a live one in main; not sent.
    const envelopes: PluginRendererMetricsEnvelope[] = [];
    for (const { generation, report } of tagged) {
      if (generation !== null) envelopes.push({ generation, report });
    }
    if (envelopes.length === 0) return;
    try {
      send(envelopes);
    } catch {
      // Main may be mid-teardown; the observations are best-effort.
    }
  };

  const offSubscribe = registry.subscribe(() => {
    if (timer !== null || stopped) return;
    timer = schedule(drain, REPORT_DRAIN_DELAY_MS);
  });

  // A debounce rather than a drain per load, so several panels opening together
  // still go out as one message.
  const offViewLoad =
    registry.onViewLoadRecorded?.(() => {
      if (viewLoadTimer !== null || stopped) return;
      viewLoadTimer = schedule(drain, VIEW_LOAD_DRAIN_DELAY_MS);
    }) ?? (() => {});

  // Requested from inside the recording call (a React commit); leave that
  // stack before draining.
  const offDrainRequested = registry.onDrainRequested(() => {
    if (microtaskQueued || stopped) return;
    microtaskQueued = true;
    microtask(() => {
      microtaskQueued = false;
      drain();
    });
  });

  const onVisibilityChange = (): void => {
    if (doc?.visibilityState === "hidden") drain();
  };
  doc?.addEventListener("visibilitychange", onVisibilityChange);
  page?.addEventListener("pagehide", drain);

  return () => {
    // One last drain, so a monitor restart does not drop what was pending.
    drain();
    stopped = true;
    offSubscribe();
    offViewLoad();
    offDrainRequested();
    doc?.removeEventListener("visibilitychange", onVisibilityChange);
    page?.removeEventListener("pagehide", drain);
  };
}
