import v8 from "node:v8";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { app } from "electron";
import { logDebug, logInfo, logWarn } from "../utils/logger.js";
import { setAlignedInterval } from "../utils/setAlignedInterval.js";
import { getSystemSleepService } from "./SystemSleepService.js";

const POLL_INTERVAL_MS = 30_000;
const SNAPSHOT_COOLDOWN_MS = 5 * 60 * 1000;

const WARN_THRESHOLDS_MB: Record<string, number> = {
  Browser: 300,
  Tab: 768,
  Utility: 500,
};

const SNAPSHOT_THRESHOLD_MB = 600;

const MONITORED_TYPES = new Set(["Browser", "Tab", "Utility"]);

const BUCKET_TICKS = 2;
const BUCKET_WINDOW = 30;
const EMA_ALPHA = 2 / (BUCKET_WINDOW + 1);
const STARTUP_SUPPRESSION_MS = 15 * 60 * 1000;
const TREND_WARN_MB_PER_HOUR = 5;

export const WARMUP_INTERVALS = 5;
export const PRESSURE_COUNT_TIER2 = 3;
export const MITIGATION_COOLDOWN_MS = 10 * 60 * 1000;

interface PidTrendState {
  startedAt: number;
  tickInBucket: number;
  bucketMin: number;
  ema: number;
  emaHistory: number[];
}

export interface BlinkMemorySample {
  /**
   * process.getBlinkMemoryInfo().allocated — kilobytes currently in use by
   * Blink. Note: the Electron API reports KB, not bytes (electron.d.ts:
   * BlinkMemoryInfo).
   */
  allocated: number;
  /** Reserved for future Electron versions; not populated on Electron 41. */
  marked?: number;
  /**
   * process.getBlinkMemoryInfo().total — total reserved kilobytes (allocated
   * + free) when the renderer reports it.
   */
  total?: number;
  /** Reserved for future Electron versions; not populated on Electron 41. */
  partitionAlloc?: number;
  /** Wall-clock time the sample was recorded. */
  timestamp: number;
}

const blinkSamples = new Map<number, BlinkMemorySample>();

/**
 * Called by the IPC handler when a renderer reports its Blink memory snapshot.
 * Keyed by webContents id; cleared on view eviction via `forgetBlinkSample`.
 * Logs at debug level — issue #6272 is about visibility, not alerting.
 */
export function recordBlinkSample(
  webContentsId: number,
  sample: Omit<BlinkMemorySample, "timestamp">
): void {
  const stored: BlinkMemorySample = { ...sample, timestamp: Date.now() };
  blinkSamples.set(webContentsId, stored);
  logDebug("blink-memory-sample", {
    webContentsId,
    // sample.allocated/total are in kilobytes per Electron's BlinkMemoryInfo.
    allocatedMb: Math.round(sample.allocated / 1024),
    totalMb: typeof sample.total === "number" ? Math.round(sample.total / 1024) : undefined,
  });
}

/** Drop a renderer's last Blink sample (call from ProjectViewManager onViewEvicted). */
export function forgetBlinkSample(webContentsId: number): void {
  blinkSamples.delete(webContentsId);
}

/** Read-only view for diagnostics / tests. */
export function getBlinkSamples(): ReadonlyMap<number, BlinkMemorySample> {
  return blinkSamples;
}

/** Ratio (blocking / sample window) considered "saturated" for a single sample. */
export const RENDERER_ELU_HIGH_RATIO = 0.85;

/**
 * Number of consecutive saturated samples required before logging a
 * sustained-high warning. POLL_INTERVAL_MS is 30s, so 6 samples = 3 minutes
 * of continuous saturation. A single sub-threshold sample resets the streak.
 */
export const RENDERER_ELU_HIGH_SAMPLE_COUNT = 6;

export interface RendererEluSample {
  /** Total LoAF blockingDuration accumulated by the preload over the window, in ms. */
  blockingDurationMs: number;
  /** Wall-clock width of the sample window the preload measured against, in ms. */
  sampleWindowMs: number;
  /** Derived ratio = blockingDurationMs / sampleWindowMs, clamped to [0, 1]. */
  ratio: number;
  /** Wall-clock time the sample was recorded. */
  timestamp: number;
}

const eluSamples = new Map<number, RendererEluSample>();
const eluHighStreak = new Map<number, number>();

/**
 * Called by the IPC handler when a renderer reports its accumulated long-
 * animation-frame blocking time. Keyed by webContents id; cleared on view
 * eviction via `forgetEluSample`. Logs at debug level for every sample;
 * emits exactly one `renderer-elu-sustained-high` warn when the per-view
 * streak first hits {@link RENDERER_ELU_HIGH_SAMPLE_COUNT}. The streak
 * continues incrementing past the threshold, but only the boundary crossing
 * is logged to avoid flooding.
 */
export function recordEluSample(
  webContentsId: number,
  payload: { blockingDurationMs: number; sampleWindowMs: number }
): void {
  const { blockingDurationMs, sampleWindowMs } = payload;
  if (sampleWindowMs <= 0) return;
  const rawRatio = blockingDurationMs / sampleWindowMs;
  const ratio = rawRatio < 0 ? 0 : rawRatio > 1 ? 1 : rawRatio;
  const stored: RendererEluSample = {
    blockingDurationMs,
    sampleWindowMs,
    ratio,
    timestamp: Date.now(),
  };
  eluSamples.set(webContentsId, stored);
  logDebug("renderer-elu-sample", {
    webContentsId,
    ratio: Math.round(ratio * 100) / 100,
    blockingDurationMs: Math.round(blockingDurationMs),
    sampleWindowMs,
  });

  if (ratio >= RENDERER_ELU_HIGH_RATIO) {
    const next = (eluHighStreak.get(webContentsId) ?? 0) + 1;
    eluHighStreak.set(webContentsId, next);
    if (next === RENDERER_ELU_HIGH_SAMPLE_COUNT) {
      logWarn("renderer-elu-sustained-high", {
        webContentsId,
        ratio: Math.round(ratio * 100) / 100,
        consecutiveSamples: next,
        windowMs: sampleWindowMs * next,
      });
    }
  } else {
    eluHighStreak.delete(webContentsId);
  }
}

/** Drop a renderer's last ELU sample and streak (call from view eviction). */
export function forgetEluSample(webContentsId: number): void {
  eluSamples.delete(webContentsId);
  eluHighStreak.delete(webContentsId);
}

/** Read-only view for diagnostics / tests. */
export function getEluSamples(): ReadonlyMap<number, RendererEluSample> {
  return eluSamples;
}

/** Read-only view of per-view consecutive saturated-sample counts (tests). */
export function getEluHighStreaks(): ReadonlyMap<number, number> {
  return eluHighStreak;
}

export interface MemoryPressureActions {
  clearCaches: () => Promise<void>;
  destroyHiddenWebviews: (tier: 1 | 2) => Promise<void>;
  hibernateIdleProjects: () => Promise<void>;
  trimPtyHostState?: () => void;
  /**
   * Optional Blink memory sampler. If wired, called once per poll BEFORE
   * pressure evaluation so renderer samples land alongside the metrics
   * snapshot. Implementations should fan a `window:sample-blink-memory`
   * push event out to live renderers; renderers reply via the
   * `system:report-blink-memory` IPC channel which calls `recordBlinkSample`.
   */
  sampleBlinkMemory?: () => void;
  /**
   * Optional renderer event-loop utilization sampler. If wired, fans a
   * `window:sample-renderer-elu` push event to every active renderer (cached
   * views are skipped — JS timer throttling makes their samples meaningless).
   * Renderers reply via `system:report-renderer-elu` which calls
   * `recordEluSample`. Failures are non-critical observability.
   */
  sampleRendererElu?: () => void;
}

function getProcessMemoryMb(proc: Electron.ProcessMetric): number {
  return (proc.memory.privateBytes ?? proc.memory.workingSetSize) / 1024;
}

let currentAppMetricsPollIntervalMs = POLL_INTERVAL_MS;
let rearmAppMetricsTimer: (() => void) | null = null;
let appMetricsPollFn: (() => void) | null = null;

export function setAppMetricsMonitorPollInterval(ms: number): void {
  if (ms === currentAppMetricsPollIntervalMs) return;
  currentAppMetricsPollIntervalMs = ms;
  rearmAppMetricsTimer?.();
}

export function refreshAppMetricsMonitor(): void {
  appMetricsPollFn?.();
}

export function startAppMetricsMonitor(actions?: MemoryPressureActions): () => void {
  const snapshotCooldowns = new Map<number, number>();
  const trendState = new Map<number, PidTrendState>();
  let removeSuspendListener: (() => void) | null = null;
  let removeWakeListener: (() => void) | null = null;
  let pollCount = 0;
  let consecutivePressureCount = 0;
  let lastTier2At = 0;
  let mitigationInFlight = false;

  const poll = () => {
    try {
      pollCount++;
      try {
        actions?.sampleBlinkMemory?.();
      } catch {
        /* non-critical */
      }
      try {
        actions?.sampleRendererElu?.();
      } catch {
        /* non-critical */
      }
      const metrics = app.getAppMetrics();
      const activePids = new Set<number>();
      let hasPressure = false;

      for (const proc of metrics) {
        if (!MONITORED_TYPES.has(proc.type)) continue;

        activePids.add(proc.pid);
        const mb = getProcessMemoryMb(proc);
        logDebug("process-memory-sample", { pid: proc.pid, type: proc.type, mb: Math.round(mb) });

        const threshold = WARN_THRESHOLDS_MB[proc.type];
        if (threshold !== undefined && mb > threshold) {
          hasPressure = true;
          logWarn("process-memory-threshold-exceeded", {
            pid: proc.pid,
            type: proc.type,
            mb: Math.round(mb),
            thresholdMb: threshold,
          });
        }

        let state = trendState.get(proc.pid);
        if (!state) {
          state = {
            startedAt: Date.now(),
            tickInBucket: 0,
            bucketMin: mb,
            ema: mb,
            emaHistory: [],
          };
          trendState.set(proc.pid, state);
        }

        state.bucketMin = Math.min(state.bucketMin, mb);
        state.tickInBucket++;

        if (state.tickInBucket === BUCKET_TICKS) {
          state.ema = EMA_ALPHA * state.bucketMin + (1 - EMA_ALPHA) * state.ema;
          state.emaHistory.push(state.ema);
          if (state.emaHistory.length > BUCKET_WINDOW) {
            state.emaHistory.shift();
          }

          if (
            Date.now() - state.startedAt >= STARTUP_SUPPRESSION_MS &&
            state.emaHistory.length === BUCKET_WINDOW
          ) {
            const oldest = state.emaHistory[0]!;
            const newest = state.emaHistory[BUCKET_WINDOW - 1]!;
            const windowHours = ((BUCKET_WINDOW - 1) * 60) / 3600;
            const growthMbPerHour = (newest - oldest) / windowHours;
            if (growthMbPerHour > TREND_WARN_MB_PER_HOUR) {
              logWarn("process-memory-trend-warning", {
                pid: proc.pid,
                type: proc.type,
                growthMbPerHour: Math.round(growthMbPerHour),
              });
            }
          }

          state.tickInBucket = 0;
          state.bucketMin = Infinity;
        }

        if (proc.type === "Browser" && mb > SNAPSHOT_THRESHOLD_MB && !app.isPackaged) {
          const now = Date.now();
          const last = snapshotCooldowns.get(proc.pid) ?? 0;
          if (now - last > SNAPSHOT_COOLDOWN_MS) {
            try {
              const dir = app.getPath("logs");
              mkdirSync(dir, { recursive: true });
              const file = path.join(dir, `heap-${proc.pid}-${now}.heapsnapshot`);
              const written = v8.writeHeapSnapshot(file);
              snapshotCooldowns.set(proc.pid, now);
              logWarn("heap-snapshot-written", { path: written });
            } catch (err) {
              logWarn("heap-snapshot-failed", { error: String(err) });
            }
          }
        }
      }

      for (const pid of trendState.keys()) {
        if (!activePids.has(pid)) trendState.delete(pid);
      }
      for (const pid of snapshotCooldowns.keys()) {
        if (!activePids.has(pid)) snapshotCooldowns.delete(pid);
      }

      if (pollCount <= WARMUP_INTERVALS || !actions) {
        consecutivePressureCount = 0;
        return;
      }

      if (hasPressure) {
        consecutivePressureCount++;
      } else {
        consecutivePressureCount = 0;
        return;
      }

      if (mitigationInFlight) return;

      mitigationInFlight = true;
      void (async () => {
        try {
          logInfo("memory-pressure-tier1-mitigation", {
            pollCount,
            consecutivePressureCount,
          });
          await actions.clearCaches();
          await actions.destroyHiddenWebviews(1);

          try {
            actions.trimPtyHostState?.();
          } catch {
            /* non-critical */
          }

          if (
            consecutivePressureCount >= PRESSURE_COUNT_TIER2 &&
            Date.now() - lastTier2At >= MITIGATION_COOLDOWN_MS
          ) {
            logInfo("memory-pressure-tier2-mitigation", {
              pollCount,
              consecutivePressureCount,
            });
            await actions.destroyHiddenWebviews(2);
            await actions.hibernateIdleProjects();
            lastTier2At = Date.now();
          }
        } catch (err) {
          logWarn("memory-pressure-mitigation-failed", { error: String(err) });
        } finally {
          mitigationInFlight = false;
        }
      })();
    } catch (err) {
      logWarn("process-memory-poll-failed", { error: String(err) });
    }
  };

  appMetricsPollFn = poll;

  let clearAlignedInterval: (() => void) | null = null;
  const armTimer = () => {
    clearAlignedInterval?.();
    clearAlignedInterval = setAlignedInterval(poll, currentAppMetricsPollIntervalMs);
  };
  rearmAppMetricsTimer = armTimer;

  armTimer();

  try {
    removeSuspendListener = getSystemSleepService().onSuspend(() => {
      clearAlignedInterval?.();
      clearAlignedInterval = null;
      trendState.clear();
      consecutivePressureCount = 0;
      lastTier2At = 0;
      mitigationInFlight = false;
    });
    removeWakeListener = getSystemSleepService().onWake(() => {
      if (clearAlignedInterval !== null) return;
      armTimer();
    });
  } catch {
    // SystemSleepService may not be initialized yet at early startup.
  }

  return () => {
    clearAlignedInterval?.();
    clearAlignedInterval = null;
    appMetricsPollFn = null;
    rearmAppMetricsTimer = null;
    removeSuspendListener?.();
    removeWakeListener?.();
  };
}
