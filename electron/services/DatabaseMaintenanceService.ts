import { powerMonitor } from "electron";
import fs from "node:fs";
import {
  getDbPath,
  getBackupPath,
  getSharedSqlite,
  probeDb,
  attemptRecovery,
} from "./persistence/db.js";
import { getSystemSleepService } from "./SystemSleepService.js";

const TICK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const IDLE_THRESHOLD_S = 60; // 60 seconds of system idle

class DatabaseMaintenanceService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private removeSuspendListener: (() => void) | null = null;
  private backupPromise: Promise<void> | null = null;
  private disposed = false;

  initialize(): void {
    if (this.timer) return; // already initialized

    const dbPath = getDbPath();

    if (!probeDb(dbPath)) {
      console.error("[DatabaseMaintenance] Database corruption detected, attempting recovery");
      const recovered = attemptRecovery(dbPath);
      if (recovered) {
        console.log("[DatabaseMaintenance] Recovery successful — restored from backup");
      } else {
        console.warn("[DatabaseMaintenance] No backup to restore — fresh database will be created");
      }
    }

    this.timer = setInterval(() => this.tick(), TICK_INTERVAL_MS);

    try {
      this.removeSuspendListener = getSystemSleepService().onSuspend(() => {
        this.checkpoint("PASSIVE");
      });
    } catch {
      // SystemSleepService may not be initialized yet at early startup.
      // The suspend hook is best-effort — periodic timer covers the gap.
    }

    console.log("[DatabaseMaintenance] Initialized");
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
    this.checkpoint("TRUNCATE");
    console.log("[DatabaseMaintenance] Disposed — final backup + checkpoint complete");
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

    this.checkpoint("PASSIVE");
    this.backupPromise = this.runBackup();
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

  private async runBackup(): Promise<void> {
    if (this.backupPromise && !this.disposed) {
      // Another backup is already in flight from a tick — skip
      return;
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

export function initializeDatabaseMaintenance(): DatabaseMaintenanceService {
  const service = getDatabaseMaintenanceService();
  service.initialize();
  return service;
}

export { DatabaseMaintenanceService };
