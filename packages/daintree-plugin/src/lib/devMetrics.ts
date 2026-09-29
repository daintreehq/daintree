import {
  PLUGIN_PERF_BUDGETS,
  type PluginPerfBudgetKey,
} from "../../../../shared/config/pluginBudgets.js";
import type {
  PluginPerfSnapshot,
  PluginViewLoadSample,
} from "../../../../shared/types/pluginMetrics.js";

/**
 * The `daintree-plugin dev` performance table: what the running Daintree
 * measured for the plugin, each value beside its budget. Budgets are
 * observational — the table says where a value sits, never what to do about it.
 */

export const DEV_METRICS_POLL_MS = 2_000;
export const DEV_METRICS_METHOD = "plugin.dev.metrics";

type Unit = "ms" | "bytes" | "perSecond" | "bytesPerSecond";

const BUDGET_UNITS: Record<PluginPerfBudgetKey, Unit> = {
  activationMs: "ms",
  viewLoadMs: "ms",
  viewFirstPaintMs: "ms",
  viewCommitP95Ms: "ms",
  invokeP95Ms: "ms",
  pushesPerSecond: "perSecond",
  pushBytesPerSecond: "bytesPerSecond",
  workerRssBytes: "bytes",
};

export function formatMs(ms: number): string {
  return ms < 10 ? `${ms.toFixed(1)}ms` : `${Math.round(ms)}ms`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRate(perSecond: number): string {
  return `${perSecond.toFixed(1)}/s`;
}

function formatUnit(value: number, unit: Unit): string {
  switch (unit) {
    case "ms":
      return formatMs(value);
    case "bytes":
      return formatBytes(value);
    case "perSecond":
      return formatRate(value);
    case "bytesPerSecond":
      return `${formatBytes(value)}/s`;
  }
}

/** Mirrors the host: activation runs first, then import and style preparation overlap. */
function viewLoadMsOf(sample: PluginViewLoadSample): number {
  return sample.activateMs + Math.max(sample.importMs, sample.stylesMs);
}

/** "✓", or "over budget: 612ms > 500ms", judged by the host's own `overBudget`. */
function mark(snapshot: PluginPerfSnapshot, key: PluginPerfBudgetKey, value: number): string {
  const unit = BUDGET_UNITS[key];
  const budget = formatUnit(PLUGIN_PERF_BUDGETS[key], unit);
  if (snapshot.overBudget.includes(key)) {
    return `over budget: ${formatUnit(value, unit)} > ${budget}`;
  }
  return `✓ (budget ${budget})`;
}

interface Row {
  label: string;
  value: string;
  note: string;
}

const NONE = "—";

/** A compact, stable table: the same measurements always print the same text. */
export function formatDevMetrics(snapshot: PluginPerfSnapshot): string {
  const rows: Row[] = [];

  const activation = snapshot.activation;
  rows.push(
    activation
      ? {
          label: "activation",
          value: formatMs(activation.lastMs),
          note: mark(snapshot, "activationMs", activation.lastMs),
        }
      : { label: "activation", value: NONE, note: "" }
  );

  const load = snapshot.viewLoads[snapshot.viewLoads.length - 1];
  if (load) {
    const loadMs = viewLoadMsOf(load);
    rows.push({
      label: "view load",
      value: `${formatMs(loadMs)} (${load.kindId})`,
      note: mark(snapshot, "viewLoadMs", loadMs),
    });
    rows.push({
      label: "view first paint",
      value: formatMs(load.firstPaintMs),
      note: mark(snapshot, "viewFirstPaintMs", load.firstPaintMs),
    });
  } else {
    rows.push({ label: "view load", value: NONE, note: "" });
    rows.push({ label: "view first paint", value: NONE, note: "" });
  }

  const commits = snapshot.viewCommits;
  rows.push(
    commits
      ? {
          label: "view commits p95",
          value: `${formatMs(commits.p95Ms)} (${commits.count})`,
          note: mark(snapshot, "viewCommitP95Ms", commits.p95Ms),
        }
      : {
          label: "view commits p95",
          value: NONE,
          // Production React skips Profiler callbacks, so absence is not zero.
          note: "none observed (production builds do not report commits)",
        }
  );

  const invokes = snapshot.invokes;
  if (invokes.count > 0) {
    const failures: string[] = [];
    if (invokes.errors > 0) failures.push(`${invokes.errors} failed`);
    if (invokes.timeouts > 0) failures.push(`${invokes.timeouts} timed out`);
    if (invokes.oversized > 0) failures.push(`${invokes.oversized} oversized`);
    rows.push({
      label: "invokes p50/p95",
      value:
        `${formatMs(invokes.p50Ms)} / ${formatMs(invokes.p95Ms)} (${invokes.count}` +
        (failures.length > 0 ? `, ${failures.join(", ")})` : ")"),
      note: mark(snapshot, "invokeP95Ms", invokes.p95Ms),
    });
  } else {
    rows.push({ label: "invokes p50/p95", value: NONE, note: "" });
  }

  const pushes = snapshot.pushes;
  if (pushes.messages > 0) {
    const notes = [
      mark(snapshot, "pushesPerSecond", pushes.perSecond),
      mark(snapshot, "pushBytesPerSecond", pushes.bytesPerSecond),
    ];
    rows.push({
      label: "pushes/s",
      value: `${formatRate(pushes.perSecond)}, ${formatBytes(pushes.bytesPerSecond)}/s`,
      note: notes.every((n) => n.startsWith("✓"))
        ? "✓"
        : notes.filter((n) => !n.startsWith("✓")).join("; "),
    });
  } else {
    rows.push({ label: "pushes/s", value: NONE, note: "" });
  }

  const longFrames = snapshot.longFrames;
  rows.push({
    label: "long frames",
    value:
      longFrames.count > 0
        ? `${longFrames.count} (${formatMs(longFrames.totalBlockingMs)} blocking)`
        : "0",
    // Overlap, not blame: the plugin was active during the stall.
    note: longFrames.count > 0 ? "plugin activity observed during these frames" : "",
  });

  const memory = snapshot.workerMemory;
  if (snapshot.isolation === "worker") {
    rows.push(
      memory
        ? {
            label: "worker RSS",
            value: formatBytes(memory.rssBytes),
            note: mark(snapshot, "workerRssBytes", memory.rssBytes),
          }
        : { label: "worker RSS", value: NONE, note: "no memory sample" }
    );
  }

  const labelWidth = Math.max(...rows.map((r) => r.label.length));
  const valueWidth = Math.max(...rows.map((r) => r.value.length));
  const lines = rows.map((r) =>
    `  ${r.label.padEnd(labelWidth)}  ${r.note ? r.value.padEnd(valueWidth) : r.value}${r.note ? `  ${r.note}` : ""}`.trimEnd()
  );
  return [`Performance — ${snapshot.pluginId} (${snapshot.isolation})`, ...lines].join("\n");
}

export type DevMetricsRequest = (
  method: string,
  params: unknown,
  options: { signal: AbortSignal }
) => Promise<unknown>;

export interface DevMetricsPollerOptions {
  pluginId: string;
  request: DevMetricsRequest;
  print: (text: string) => void;
  intervalMs?: number;
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface DevMetricsPoller {
  start(): void;
  stop(): void;
  /** Run one poll now; resolves when it has been handled. Test seam. */
  pollOnce(): Promise<void>;
}

function isUnknownMethodError(err: unknown): boolean {
  return err instanceof Error && /unknown method/i.test(err.message);
}

function snapshotOf(result: unknown): PluginPerfSnapshot | null {
  if (!result || typeof result !== "object") return null;
  const snapshot = (result as { snapshot?: unknown }).snapshot;
  if (!snapshot || typeof snapshot !== "object") return null;
  const candidate = snapshot as Partial<PluginPerfSnapshot>;
  if (typeof candidate.pluginId !== "string" || !Array.isArray(candidate.overBudget)) return null;
  return snapshot as PluginPerfSnapshot;
}

/**
 * Poll the running Daintree for the dev plugin's snapshot and print the table
 * whenever what it would show changes. Never throws into the dev session: an
 * app too old to know the method is reported once and polling stops; any other
 * failure (Daintree restarting, a rebuild mid-swap) just waits for the next poll.
 */
export function createDevMetricsPoller(options: DevMetricsPollerOptions): DevMetricsPoller {
  const intervalMs = options.intervalMs ?? DEV_METRICS_POLL_MS;
  const schedule = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = options.clearTimeout ?? ((handle) => clearTimeout(handle));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  let stopped = false;
  let unavailable = false;
  let lastPrinted: string | null = null;
  // Aborted on stop, so an in-flight poll cannot hold the process open.
  const inFlight = new AbortController();

  const pollOnce = async (): Promise<void> => {
    if (unavailable || stopped) return;
    let result: unknown;
    try {
      result = await options.request(
        DEV_METRICS_METHOD,
        { pluginId: options.pluginId },
        { signal: inFlight.signal }
      );
    } catch (err) {
      if (isUnknownMethodError(err) && !stopped) {
        unavailable = true;
        options.print(
          "Performance metrics unavailable: this Daintree version does not report them. Update Daintree to see them here."
        );
      }
      return;
    }
    if (stopped) return;
    const snapshot = snapshotOf(result);
    if (!snapshot) return;
    let text: string;
    try {
      text = formatDevMetrics(snapshot);
    } catch {
      return;
    }
    if (text === lastPrinted) return;
    lastPrinted = text;
    options.print(text);
  };

  const scheduleNext = (): void => {
    if (stopped || unavailable) return;
    timer = schedule(tick, intervalMs);
    // The watchers keep the session alive; a pending poll must not.
    (timer as { unref?: () => void }).unref?.();
  };

  const tick = (): void => {
    timer = null;
    void pollOnce().finally(scheduleNext);
  };

  return {
    start() {
      if (started) return;
      started = true;
      scheduleNext();
    },
    stop() {
      stopped = true;
      inFlight.abort();
      if (timer !== null) cancel(timer);
      timer = null;
    },
    pollOnce,
  };
}
