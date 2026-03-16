import v8 from "node:v8";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { app } from "electron";
import { logDebug, logWarn } from "../utils/logger.js";

const POLL_INTERVAL_MS = 30_000;
const SNAPSHOT_COOLDOWN_MS = 5 * 60 * 1000;

const WARN_THRESHOLDS_MB: Record<string, number> = {
  Browser: 300,
  Tab: 1536,
  Utility: 500,
};

const SNAPSHOT_THRESHOLD_MB = 600;

const MONITORED_TYPES = new Set(["Browser", "Tab", "Utility"]);

const BUCKET_TICKS = 2;
const BUCKET_WINDOW = 30;
const EMA_ALPHA = 2 / (BUCKET_WINDOW + 1);
const STARTUP_SUPPRESSION_MS = 15 * 60 * 1000;
const TREND_WARN_MB_PER_HOUR = 5;

interface PidTrendState {
  startedAt: number;
  tickInBucket: number;
  bucketMin: number;
  ema: number;
  emaHistory: number[];
}

function getProcessMemoryMb(proc: Electron.ProcessMetric): number {
  return (proc.memory.privateBytes ?? proc.memory.workingSetSize) / 1024;
}

export function startAppMetricsMonitor(): () => void {
  const snapshotCooldowns = new Map<number, number>();
  const trendState = new Map<number, PidTrendState>();

  const timer = setInterval(() => {
    try {
      const metrics = app.getAppMetrics();
      const activePids = new Set<number>();

      for (const proc of metrics) {
        if (!MONITORED_TYPES.has(proc.type)) continue;

        activePids.add(proc.pid);
        const mb = getProcessMemoryMb(proc);
        logDebug("process-memory-sample", { pid: proc.pid, type: proc.type, mb: Math.round(mb) });

        const threshold = WARN_THRESHOLDS_MB[proc.type];
        if (threshold !== undefined && mb > threshold) {
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
    } catch (err) {
      logWarn("process-memory-poll-failed", { error: String(err) });
    }
  }, POLL_INTERVAL_MS);

  timer.unref();
  return () => clearInterval(timer);
}
