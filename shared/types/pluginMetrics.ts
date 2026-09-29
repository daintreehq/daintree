import type { PluginPerfBudgetKey } from "../config/pluginBudgets.js";

/**
 * Per-plugin performance observations. These are measurements, not verdicts:
 * the UI and the dev CLI show them next to the budgets in
 * `shared/config/pluginBudgets.ts` and let the reader draw the conclusion.
 */

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
  /** Open → first committed frame painted. */
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
  /** React `Profiler` actualDuration of each view commit since the last report. */
  commitDurationsMs: number[];
  /**
   * Long animation frames that overlapped this plugin's view commits or ran a
   * script served from the plugin's origin. An overlap is an observation that
   * the plugin was active during the stall, not proof that it caused it.
   */
  longFrames: Array<{
    durationMs: number;
    blockingMs: number;
    source: "script" | "commit";
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
  viewCommits: PluginDurationStats | null;
  invokes: PluginDurationStats & { errors: number; timeouts: number; oversized: number };
  pushes: {
    messages: number;
    bytes: number;
    perSecond: number;
    bytesPerSecond: number;
    oversized: number;
  };
  longFrames: { count: number; totalBlockingMs: number; lastAt: number | null };
  /** Worker process memory, sampled; null for in-process plugins. */
  workerMemory: { rssBytes: number; at: number } | null;
  /** Budgets this plugin's measurements currently sit above. */
  overBudget: PluginPerfBudgetKey[];
  /** `Date.now()` when main began recording for this plugin. */
  since: number;
}
