import type { PluginPerfBudgetKey } from "../config/pluginBudgets.js";

/**
 * Per-plugin performance observations. These are measurements, not verdicts:
 * the UI and the dev CLI show them next to the budgets in
 * `shared/config/pluginBudgets.ts` and let the reader draw the conclusion.
 */

/** What placed a plugin in a long animation frame; see {@link PluginRendererMetricsReport.longFrames}. */
export type PluginLongFrameSource = "script" | "commit" | "input" | "push";

/** Rolling summary of a stream of durations. */
export interface PluginDurationStats {
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  lastMs: number;
}

/** One view's load, measured in the renderer that opened it. */
export interface PluginViewLoadSample {
  /** Panel kind id the view belongs to. */
  kindId: string;
  /** `activateForView` resolved (worker plugins: includes worker boot). */
  activateMs: number;
  /** View module `import()` resolved. */
  importMs: number;
  /** Plugin Tailwind styles prepared. */
  stylesMs: number;
  /**
   * Open → view module imported and styles ready, measured directly rather
   * than rebuilt from the phases above (style preparation starts before
   * activation, so `activate + max(import, styles)` overstates it). This is
   * the figure the `viewLoadMs` budget is compared with.
   */
  loadMs: number;
  /**
   * Open → the start of the animation frame after the view's first commit:
   * the first frame that can show it. The frame's timestamp precedes that
   * frame's style, layout and paint, so this is the first frame opportunity,
   * not a measured paint; the name is historical. A view whose first commit is
   * its own loading state reports that frame, not the one its data arrived in.
   */
  firstPaintMs: number;
  /** A retry after a failed load rather than a cold open. */
  retry: boolean;
  /** `Date.now()` when the sample was taken. */
  at: number;
}

/**
 * Renderer-side observations for one plugin, reported to main in batches.
 * Counters are deltas since the previous report; main accumulates them.
 */
export interface PluginRendererMetricsReport {
  pluginId: string;
  viewLoads: PluginViewLoadSample[];
  /**
   * React `Profiler` actualDuration of view commits since the last report. A
   * bounded sample when the view committed more often than the registry keeps;
   * `commitCount` is then the true number observed.
   */
  commitDurationsMs: number[];
  /** Commits observed since the last report, including any not in the sample. */
  commitCount: number;
  /** Long frames observed but not listed, because the per-report cap was reached. */
  longFramesDropped: { count: number; blockingMs: number };
  /**
   * Long animation frames during which this plugin was observed doing
   * something. An overlap is an observation that the plugin was active during
   * the stall, not proof that it caused it. `source` says what was observed,
   * checked in this order and recorded once per frame:
   *   - `script`: a script served from the plugin's `plugin://` origin ran;
   *   - `commit`: one of its views committed (React `Profiler`, so only in
   *     development and profiling builds);
   *   - `input`: a pointer, key, input, wheel or click event was dispatched
   *     inside one of its style roots (its views and their portals);
   *   - `push`: a host push was delivered to its listeners in this renderer.
   */
  longFrames: Array<{
    durationMs: number;
    blockingMs: number;
    source: PluginLongFrameSource;
    at: number;
  }>;
}

/** Everything the host knows about one plugin's cost, as served to the UI and the dev CLI. */
export interface PluginPerfSnapshot {
  pluginId: string;
  /** In a forked worker (third-party) vs in-process (builtin). */
  isolation: "worker" | "in-process";
  activation: { lastMs: number; count: number; at: number } | null;
  viewLoads: PluginViewLoadSample[];
  /**
   * Null when no commit durations were observed. Production React builds do not
   * run `Profiler` callbacks, so this is populated only in development and
   * profiling builds; the UI says so rather than showing zero.
   */
  viewCommits: PluginDurationStats | null;
  /**
   * `count` is every invoke observed. The latency figures cover only those
   * that did not overlap a host prompt (quick pick, input box, confirm, send
   * to agent) the plugin had open: those spent their time waiting on the user,
   * so they are counted in `promptWaits` instead of skewing p50/p95/max. Any
   * prompt the plugin had open during the call counts, including one opened by
   * a concurrent handler; the error counters still include them.
   */
  invokes: PluginDurationStats & {
    errors: number;
    timeouts: number;
    oversized: number;
    promptWaits: number;
  };
  pushes: {
    messages: number;
    bytes: number;
    /**
     * Sustained rate: the trailing window (ten one-second buckets) divided by
     * its span. This is what the push budgets are compared with.
     */
    perSecond: number;
    bytesPerSecond: number;
    /**
     * The busiest one-second bucket in that same window. Buckets are aligned
     * to wall-clock seconds, so a sub-second burst that straddles a boundary
     * reads as two smaller buckets. Shown beside the sustained rate, never
     * judged against a budget.
     */
    peakPerSecond: number;
    peakBytesPerSecond: number;
    oversized: number;
  };
  longFrames: { count: number; totalBlockingMs: number; lastAt: number | null };
  /**
   * Worker process resident memory. Sampled every few seconds while a
   * snapshot subscriber or CLI lease is active, and on demand (at most every
   * couple of seconds) when snapshots are read. Null when the plugin runs
   * in-process, when its worker is not running, or when no sample has been
   * taken yet.
   */
  workerMemory: { rssBytes: number; at: number } | null;
  /** Budgets this plugin's measurements currently sit above. */
  overBudget: PluginPerfBudgetKey[];
  /** `Date.now()` when main began recording for this plugin. */
  since: number;
}
