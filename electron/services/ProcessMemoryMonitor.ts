import v8 from "node:v8";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { app } from "electron";
import { logDebug, logInfo, logWarn } from "../utils/logger.js";

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
}

function getProcessMemoryMb(proc: Electron.ProcessMetric): number {
  return (proc.memory.privateBytes ?? proc.memory.workingSetSize) / 1024;
}

export function startAppMetricsMonitor(actions?: MemoryPressureActions): () => void {
  const snapshotCooldowns = new Map<number, number>();
  const trendState = new Map<number, PidTrendState>();
  let pollCount = 0;
  let consecutivePressureCount = 0;
  let lastTier2At = 0;
  let mitigationInFlight = false;

  const timer = setInterval(() => {
    try {
      pollCount++;
      // Kick off a Blink-memory sample fan-out for this tick. Renderer replies
      // arrive asynchronously via the SYSTEM_REPORT_BLINK_MEMORY handler and
      // populate `blinkSamples` for the next poll's diagnostics.
      try {
        actions?.sampleBlinkMemory?.();
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

        // Trend detection: bucket-minimum + EMA
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

          // Evaluate trend with dual suppression
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

      // Prune stale PID state
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
  }, POLL_INTERVAL_MS);

  timer.unref();
  return () => clearInterval(timer);
}
