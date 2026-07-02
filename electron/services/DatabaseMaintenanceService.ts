// eager-import-allow: performs sync fs checks during database maintenance
import { powerMonitor } from "electron";
import fs from "node:fs";
import {
  getDbPath,
  getBackupPath,
  getSharedSqlite,
  probeDb,
  attemptRecovery,
} from "./persistence/db.js";
import { runDbWork } from "./persistence/dbWorkerClient.js";
import { getSystemSleepService } from "./SystemSleepService.js";

const TICK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const IDLE_THRESHOLD_S = 60; // 60 seconds of system idle

class DatabaseMaintenanceService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private removeSuspendListener: (() => void) | null = null;
  private backupPromise: Promise<void> | null = null;
  private disposed = false;
  private initialized = false;
  private deferredQuickCheckPending = false;

  initialize(wasCleanExit = false): void {
    if (this.initialized) return;
    this.initialized = true;

    const dbPath = getDbPath();

    // On clean-exit boots corruption is impossible — skip the O(size) page scan
    // and do a cheap open instead. The full quick_check runs from the idle
    // maintenance tick. On unclean exits (crash, power loss, SIGKILL) run the
    // full scan immediately so recovery happens before getSharedDb() opens the file.
    if (!probeDb(dbPath, !wasCleanExit)) {
      console.error("[DatabaseMaintenance] Database corruption detected, attempting recovery");
      const recovered = attemptRecovery(dbPath);
      if (recovered) {
        console.log("[DatabaseMaintenance] Recovery successful — restored from backup");
      } else {
        console.warn("[DatabaseMaintenance] No backup to restore — fresh database will be created");
      }
    } else if (wasCleanExit) {
      // Clean-exit boots skip the O(size) quick_check; run it once from the
      // first idle tick on the DB worker thread instead.
      this.deferredQuickCheckPending = true;
    }

    console.log("[DatabaseMaintenance] Initialized (probe complete)");
  }

  startMaintenance(): void {
    // Defensive: dispose() may run before startMaintenance() drains from the
    // deferred queue (window closed before first-interactive). The timer/listener
    // installation must not happen post-dispose.
    if (this.disposed) return;
    if (this.timer) return;

    this.timer = setInterval(() => this.tick(), TICK_INTERVAL_MS);

    try {
      this.removeSuspendListener = getSystemSleepService().onSuspend(() => {
        void runDbWork({ op: "checkpoint", mode: "PASSIVE" }, () => this.checkpoint("PASSIVE"));
      });
    } catch {
      // SystemSleepService may not be initialized yet at early startup.
      // The suspend hook is best-effort — periodic timer covers the gap.
    }

    console.log("[DatabaseMaintenance] Maintenance started");
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.removeSuspendListener) {
      this.removeSuspendListener();
      this.removeSuspendListener = null;
    }

    // Wait for any in-flight backup from a tick before proceeding
    if (this.backupPromise) {
      try {
        await this.backupPromise;
      } catch {
        // ignore — backup errors already logged
      }
    }

    // Final backup + TRUNCATE checkpoint (DB is NOT closed here —
    // shutdown.ts may still need it for project state saves afterward)
    await this.runBackup();
    this.optimize();
    this.checkpoint("TRUNCATE");
    console.log("[DatabaseMaintenance] Disposed — optimize + checkpoint complete");
  }

  private tick(): void {
    try {
      const idleTime = powerMonitor.getSystemIdleTime();
      if (idleTime < IDLE_THRESHOLD_S) return;
    } catch {
      // powerMonitor may not be ready; skip this tick
      return;
    }

    const sqlite = getSharedSqlite();
    if (!sqlite) return;

    // PASSIVE at runtime: a TRUNCATE/RESTART checkpoint from the worker
    // connection blocks concurrent writers while it waits out readers, which
    // would spin a main-thread write on its busy_timeout. The full TRUNCATE
    // runs once, on main, from dispose() at shutdown.
    void runDbWork({ op: "checkpoint", mode: "PASSIVE" }, () => this.checkpoint("PASSIVE"));
    this.runDeferredQuickCheck();
    this.backupPromise = this.runBackup();
  }

  private runDeferredQuickCheck(): void {
    if (!this.deferredQuickCheckPending) return;
    this.deferredQuickCheckPending = false;
    // Advisory only, and never on main — when the worker is unavailable the
    // fallback skips the scan rather than stalling the event loop for it.
    void runDbWork<string | null>({ op: "quickCheck" }, () => null).then((result) => {
      if (result === null) {
        console.warn("[DatabaseMaintenance] Deferred quick_check skipped — DB worker unavailable");
      } else if (result !== "ok") {
        console.error(
          `[DatabaseMaintenance] Deferred quick_check reported corruption in ${getDbPath()}:`,
          result
        );
      }
    });
  }

  private checkpoint(mode: "PASSIVE" | "TRUNCATE"): void {
    const sqlite = getSharedSqlite();
    if (!sqlite) return;

    try {
      sqlite.pragma(`wal_checkpoint(${mode})`);
    } catch (error) {
      console.warn(`[DatabaseMaintenance] WAL checkpoint (${mode}) failed:`, error);
    }
  }

  private optimize(): void {
    const sqlite = getSharedSqlite();
    if (!sqlite) return;

    try {
      sqlite.pragma("optimize");
    } catch (error) {
      console.warn("[DatabaseMaintenance] PRAGMA optimize failed:", error);
    }
  }

  private async runBackup(): Promise<void> {
    if (this.backupPromise && !this.disposed) {
      // Another backup is already in flight from a tick — skip
      return this.backupPromise;
    }

    const sqlite = getSharedSqlite();
    if (!sqlite) return;

    const backupPath = getBackupPath();
    const tmpPath = backupPath + ".tmp";

    try {
      await sqlite.backup(tmpPath);
      fs.renameSync(tmpPath, backupPath);
    } catch (error) {
      console.warn("[DatabaseMaintenance] Backup failed:", error);
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // ignore cleanup failure
      }
    } finally {
      this.backupPromise = null;
    }
  }
}

let instance: DatabaseMaintenanceService | null = null;

export function getDatabaseMaintenanceService(): DatabaseMaintenanceService {
  if (!instance) {
    instance = new DatabaseMaintenanceService();
  }
  return instance;
}

export function initializeDatabaseMaintenance(wasCleanExit = false): DatabaseMaintenanceService {
  const service = getDatabaseMaintenanceService();
  service.initialize(wasCleanExit);
  return service;
}

export { DatabaseMaintenanceService };
