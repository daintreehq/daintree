import { mean, percentile, round, stdDev } from "./stats";
import { PERF_MARKS } from "../../../shared/perf/marks";

export interface MarkRecord {
  mark: string;
  timestamp: string;
  elapsedMs: number;
  meta?: Record<string, unknown>;
}

export interface RunData {
  index: number;
  durationMs: number;
  notes?: string;
  marks: MarkRecord[];
  failed?: boolean;
  error?: string;
  degraded?: boolean;
}

export interface MarkStats {
  runs: number;
  p50Ms: number;
  p95Ms: number;
  meanMs: number;
  stdDevMs: number;
}

export interface IpcChannelStats extends MarkStats {
  samples: number;
  errorCount: number;
}

export interface LoafSourceStats {
  frames: number;
  p50BlockingMs: number;
  p95BlockingMs: number;
  totalBlockingMs: number;
  meanBlockingMs: number;
}

export interface ClsStats {
  runs: number;
  p50: number;
  p95: number;
  mean: number;
  max: number;
}

export interface OsToAppBootStats {
  runs: number;
  p50Ms: number;
  p95Ms: number;
  meanMs: number;
  maxMs: number;
}

export interface EventLoopLagStats {
  samples: number;
  p50Ms: number;
  p95Ms: number;
  meanMs: number;
  maxMs: number;
  totalAccumulatedMs: number;
}

export interface Aggregate {
  marks: Record<string, MarkStats>;
  phaseDurations: Record<string, MarkStats>;
  ipc: Record<string, IpcChannelStats>;
  loaf: Record<string, LoafSourceStats>;
  cls: ClsStats | null;
  osToAppBoot: OsToAppBootStats | null;
  eventLoopLag: EventLoopLagStats | null;
}

// Vite/Rolldown default chunkFileNames is `[name]-[hash].js`. The hash is 8
// chars by default and uses one of the supported alphabets — `base64`
// (URL-safe: A-Z, a-z, 0-9, _, -), `base36` (a-z, 0-9), or `hex` (a-f, 0-9).
// We accept the union so we don't have to special-case the build mode. The
// lookahead anchors at the file extension so we only ever strip the trailing
// hash, never a hash-shaped substring elsewhere in the path. Query strings
// are preserved. Without normalization, every rebuild rotates the LoAF
// source key and prevents build-to-build comparison.
const LOAF_VITE_HASH_RE = /-[A-Za-z0-9_-]{8}(?=\.(?:js|css)(?:\?.*)?$)/;

export function normalizeLoafSourceURL(sourceURL: string): string {
  if (!sourceURL) return sourceURL;
  return sourceURL.replace(LOAF_VITE_HASH_RE, "");
}

export const PHASE_PAIRS: Array<[string, string, string]> = [
  // Headline metric: boot → first_interactive. This is what users perceive as
  // "the app is usable". renderer_ready (DOM did-finish-load, pre-hydration)
  // is kept as a sub-phase signal to distinguish hydration cost.
  [PERF_MARKS.APP_BOOT_START, PERF_MARKS.RENDERER_FIRST_INTERACTIVE, "boot → first_interactive"],
  [PERF_MARKS.APP_BOOT_START, PERF_MARKS.RENDERER_READY, "boot → renderer_ready (pre-hydration)"],
  [PERF_MARKS.SERVICE_INIT_START, PERF_MARKS.SERVICE_INIT_COMPLETE, "service_init"],
  [PERF_MARKS.HYDRATE_START, PERF_MARKS.HYDRATE_COMPLETE, "hydrate"],
  [
    PERF_MARKS.HYDRATE_RESTORE_PANELS_START,
    PERF_MARKS.HYDRATE_RESTORE_PANELS_END,
    "hydrate_restore_panels",
  ],
];

// Warn-only thresholds for the new first-launch quality signals introduced
// alongside #7576. Hard budgets are deliberately deferred until a nightly
// week of warn-only data establishes baselines.
export const CLS_WARN_THRESHOLD = 0.05;
export const LOAF_SOURCE_P95_WARN_MS = 50;
export const LOAF_SOURCE_TOTAL_WARN_MS = 200;
export const OS_TO_APP_BOOT_WARN_MS: Record<string, number> = {
  darwin: 1500,
  win32: 3000,
  linux: 1000,
};

function statsFor(values: number[]): MarkStats {
  return {
    runs: values.length,
    p50Ms: round(percentile(values, 50)),
    p95Ms: round(percentile(values, 95)),
    meanMs: round(mean(values)),
    stdDevMs: round(stdDev(values)),
  };
}

export function aggregate(runs: RunData[]): Aggregate {
  // Degraded runs (wall-clock fallback — RENDERER_READY mark never arrived)
  // still produce useful IPC samples but must be excluded from mark/phase
  // aggregates to avoid contaminating p50/p95 with incomplete timelines.
  const successful = runs.filter((r) => !r.failed);
  const withMarks = successful.filter((r) => !r.degraded);

  const markElapsed = new Map<string, number[]>();
  const phaseElapsed = new Map<string, number[]>();
  const ipcByChannel = new Map<string, { durations: number[]; errors: number }>();
  const loafBySource = new Map<string, number[]>();
  const clsValuesPerRun: number[] = [];
  const osToAppBootValues: number[] = [];
  const eventLoopLagValues: number[] = [];

  for (const run of successful) {
    for (const record of run.marks) {
      if (record.mark !== "ipc_request_sample") continue;
      const channel = typeof record.meta?.channel === "string" ? record.meta.channel : "unknown";
      const durationMs =
        typeof record.meta?.durationMs === "number" ? record.meta.durationMs : null;
      if (durationMs === null) continue;
      const errored = Boolean(record.meta?.errored);
      const bucket = ipcByChannel.get(channel) ?? { durations: [], errors: 0 };
      bucket.durations.push(durationMs);
      if (errored) bucket.errors += 1;
      ipcByChannel.set(channel, bucket);
    }
  }

  for (const run of withMarks) {
    const firstByMark = new Map<string, MarkRecord>();
    let runFinalCls: number | null = null;

    for (const record of run.marks) {
      if (record.mark === "ipc_request_sample") continue;

      // event_loop_lag carries the lag amount in meta.lagMs (not elapsedMs).
      // We bucket the lag values directly and skip the generic markElapsed
      // path, since elapsedMs-since-boot tells us nothing about lag severity.
      if (record.mark === "event_loop_lag") {
        const rawLag = record.meta?.lagMs;
        if (typeof rawLag === "number" && Number.isFinite(rawLag) && rawLag >= 0) {
          eventLoopLagValues.push(rawLag);
        }
        continue;
      }

      // LoAF marks attribute blocking time to the top script's source URL.
      // Boot-window marks are captured (the suppression in longTaskMonitor
      // suppresses logWarn only, not mark emission), so this is full coverage.
      if (record.mark === "renderer_long_animation_frame") {
        const topScripts = record.meta?.topScripts;
        const top = Array.isArray(topScripts) && topScripts.length > 0 ? topScripts[0] : null;
        const rawSourceURL =
          top && typeof (top as Record<string, unknown>).sourceURL === "string"
            ? ((top as Record<string, unknown>).sourceURL as string) || "<unknown>"
            : "<unknown>";
        const sourceURL = normalizeLoafSourceURL(rawSourceURL);
        // `typeof NaN === "number"` is true, so a malformed mark could poison
        // mean/percentile stats. `Number.isFinite` excludes NaN and ±Infinity.
        const rawBlocking = record.meta?.blockingDurationMs;
        const blockingMs =
          typeof rawBlocking === "number" && Number.isFinite(rawBlocking) ? rawBlocking : 0;
        const list = loafBySource.get(sourceURL) ?? [];
        list.push(blockingMs);
        loafBySource.set(sourceURL, list);
      }

      // Track the latest renderer_cls_final per run — `flushFinalCls` may
      // emit more than once if the skeleton-removal path is re-entered.
      if (record.mark === PERF_MARKS.RENDERER_CLS_FINAL) {
        const cumulative = record.meta?.cumulativeCls;
        if (typeof cumulative === "number" && Number.isFinite(cumulative)) {
          runFinalCls = cumulative;
        }
      }

      // os_to_app_boot_ms is attached as meta on the APP_BOOT_START mark.
      if (record.mark === PERF_MARKS.APP_BOOT_START) {
        const value = record.meta?.osToAppBootMs;
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
          osToAppBootValues.push(value);
        }
      }

      if (!firstByMark.has(record.mark)) {
        firstByMark.set(record.mark, record);
        const list = markElapsed.get(record.mark) ?? [];
        list.push(record.elapsedMs);
        markElapsed.set(record.mark, list);
      }
    }

    if (runFinalCls !== null) {
      clsValuesPerRun.push(runFinalCls);
    }

    for (const [fromMark, toMark, label] of PHASE_PAIRS) {
      const from = firstByMark.get(fromMark);
      const to = firstByMark.get(toMark);
      if (!from || !to) continue;
      const delta = to.elapsedMs - from.elapsedMs;
      if (delta < 0) {
        console.error(
          `[cold-start] skipping negative phase delta for ${label} in run ${run.index + 1} (${delta.toFixed(1)}ms)`
        );
        continue;
      }
      const list = phaseElapsed.get(label) ?? [];
      list.push(delta);
      phaseElapsed.set(label, list);
    }
  }

  const marks: Record<string, MarkStats> = {};
  for (const [name, values] of markElapsed) {
    marks[name] = statsFor(values);
  }

  const phaseDurations: Record<string, MarkStats> = {};
  for (const [label, values] of phaseElapsed) {
    phaseDurations[label] = statsFor(values);
  }

  const ipc: Record<string, IpcChannelStats> = {};
  for (const [channel, bucket] of ipcByChannel) {
    ipc[channel] = {
      ...statsFor(bucket.durations),
      samples: bucket.durations.length,
      errorCount: bucket.errors,
    };
  }

  const loaf: Record<string, LoafSourceStats> = {};
  for (const [source, blockingValues] of loafBySource) {
    const totalBlockingMs = blockingValues.reduce((acc, v) => acc + v, 0);
    loaf[source] = {
      frames: blockingValues.length,
      p50BlockingMs: round(percentile(blockingValues, 50)),
      p95BlockingMs: round(percentile(blockingValues, 95)),
      meanBlockingMs: round(mean(blockingValues)),
      totalBlockingMs: round(totalBlockingMs),
    };
  }

  const cls: ClsStats | null =
    clsValuesPerRun.length > 0
      ? {
          runs: clsValuesPerRun.length,
          p50: round(percentile(clsValuesPerRun, 50), 4),
          p95: round(percentile(clsValuesPerRun, 95), 4),
          mean: round(mean(clsValuesPerRun), 4),
          max: round(Math.max(...clsValuesPerRun), 4),
        }
      : null;

  const osToAppBoot: OsToAppBootStats | null =
    osToAppBootValues.length > 0
      ? {
          runs: osToAppBootValues.length,
          p50Ms: round(percentile(osToAppBootValues, 50)),
          p95Ms: round(percentile(osToAppBootValues, 95)),
          meanMs: round(mean(osToAppBootValues)),
          maxMs: round(Math.max(...osToAppBootValues)),
        }
      : null;

  const eventLoopLag: EventLoopLagStats | null =
    eventLoopLagValues.length > 0
      ? {
          samples: eventLoopLagValues.length,
          p50Ms: round(percentile(eventLoopLagValues, 50)),
          p95Ms: round(percentile(eventLoopLagValues, 95)),
          meanMs: round(mean(eventLoopLagValues)),
          maxMs: round(Math.max(...eventLoopLagValues)),
          totalAccumulatedMs: round(eventLoopLagValues.reduce((a, b) => a + b, 0)),
        }
      : null;

  return { marks, phaseDurations, ipc, loaf, cls, osToAppBoot, eventLoopLag };
}
