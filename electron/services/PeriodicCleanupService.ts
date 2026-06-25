// eager-import-allow: re-runs the boot-time cleanup routines on a low-frequency timer
/**
 * Periodic on-disk reclamation for long-running sessions.
 *
 * The three boot-time cleanup routines — the scratch sweep
 * ({@link runScratchCleanup}), the assistant-scratch sweep
 * ({@link runAssistantScratchCleanup}), and the log prune
 * ({@link pruneOldLogs}) — run once at startup via deferred tasks and never
 * again, so a multi-day session steadily accumulates stale scratch dirs,
 * orphaned assistant scratch, and old logs that nothing reclaims until the
 * next launch (#9537). This service re-invokes all three on a low-frequency
 * timer, gated on system idle so the synchronous log prune never blocks an
 * active user.
 *
 * Mirrors {@link DatabaseMaintenanceService}: a 60s idle gate via
 * `powerMonitor.getSystemIdleTime()`, a `disposed` guard, and disposal wired
 * into the shutdown sequence (before the DB closes). Adds an `inFlight` guard
 * because the routines are async and a slow sweep must not overlap the next
 * tick — and because the disk-pressure critical-edge trigger in
 * `globalServicesInit` can fire the same routines concurrently.
 */
import { app, powerMonitor } from "electron";
import { runScratchCleanup } from "./ScratchCleanupService.js";
import { runAssistantScratchCleanup } from "./AssistantScratchService.js";
import {
  pruneOldLogs,
  pruneHeapSnapshotsAsync,
  MAX_HEAP_SNAPSHOTS,
  logError,
} from "../utils/logger.js";
import { store } from "../store.js";

const TICK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const IDLE_THRESHOLD_S = 60; // 60 seconds of system idle

class PeriodicCleanupService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private inFlightPromise: Promise<void> | null = null;
  private disposed = false;

  /** Idempotent. Installs the low-frequency tick; no-op once disposed. */
  start(): void {
    if (this.disposed) return;
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_INTERVAL_MS);
    console.log("[PeriodicCleanup] Started");
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Await any in-flight pass so shutdown doesn't close the DB while a sweep
    // is mid-`hardDeleteScratch` — mirrors DatabaseMaintenanceService.dispose().
    if (this.inFlightPromise) {
      try {
        await this.inFlightPromise;
      } catch {
        // already logged per-routine in runAll()
      }
    }
    console.log("[PeriodicCleanup] Disposed");
  }

  /**
   * One maintenance pass. Skips entirely when disposed, when a prior pass is
   * still in flight, or when the system isn't idle. Public so tests can drive
   * it directly without flushing fake timers.
   */
  async tick(): Promise<void> {
    if (this.disposed || this.inFlight) return;

    try {
      if (powerMonitor.getSystemIdleTime() < IDLE_THRESHOLD_S) return;
    } catch {
      // powerMonitor may not be ready (early startup / Wayland); skip the tick.
      return;
    }

    this.inFlight = true;
    this.inFlightPromise = this.runAll();
    try {
      await this.inFlightPromise;
    } finally {
      this.inFlight = false;
      this.inFlightPromise = null;
    }
  }

  /** Each routine is isolated so one failure never silences the others. */
  private async runAll(): Promise<void> {
    try {
      await runScratchCleanup();
    } catch (err) {
      logError("[PeriodicCleanup] scratch cleanup threw", err);
    }
    try {
      await runAssistantScratchCleanup();
    } catch (err) {
      logError("[PeriodicCleanup] assistant scratch cleanup threw", err);
    }
    try {
      // Re-read retention each pass — the user may change it mid-session.
      const retentionDays = store.get("privacy")?.logRetentionDays ?? 30;
      if (retentionDays > 0) {
        pruneOldLogs(app.getPath("userData"), retentionDays);
      }
    } catch (err) {
      logError("[PeriodicCleanup] log prune threw", err);
    }
    try {
      // Count-based prune of V8 heap snapshots in app.getPath("logs") — a
      // separate dir from userData/logs, bounded by count not retention age.
      await pruneHeapSnapshotsAsync(app.getPath("logs"), MAX_HEAP_SNAPSHOTS);
    } catch (err) {
      logError("[PeriodicCleanup] heap snapshot prune threw", err);
    }
    try {
      // Age out assistant audit-log records past the configured retention
      // window (helpAssistant.auditRetention, in days; 0 = Off → keep). Re-read
      // each pass — the user may change it mid-session. Lazy-import the MCP
      // singleton so this maintenance file never forces it to construct early.
      const retentionDays = store.get("helpAssistant")?.auditRetention ?? 7;
      if (retentionDays > 0) {
        const { mcpServerService } = await import("./McpServerService.js");
        mcpServerService.pruneAuditByRetention(retentionDays);
      }
    } catch (err) {
      logError("[PeriodicCleanup] audit retention prune threw", err);
    }
  }
}

let instance: PeriodicCleanupService | null = null;

export function getPeriodicCleanupService(): PeriodicCleanupService {
  if (!instance) {
    instance = new PeriodicCleanupService();
  }
  return instance;
}

export { PeriodicCleanupService };
