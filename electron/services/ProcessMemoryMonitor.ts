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

export function startAppMetricsMonitor(): () => void {
  const snapshotCooldowns = new Map<number, number>();

  const timer = setInterval(() => {
    try {
      const metrics = app.getAppMetrics();

      for (const proc of metrics) {
        if (!MONITORED_TYPES.has(proc.type)) continue;

        const mb = proc.memory.workingSetSize / 1024;
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
    } catch (err) {
      logWarn("process-memory-poll-failed", { error: String(err) });
    }
  }, POLL_INTERVAL_MS);

  timer.unref();
  return () => clearInterval(timer);
}
