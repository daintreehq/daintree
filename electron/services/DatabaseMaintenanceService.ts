// eager-import-allow: performs sync fs checks during database maintenance
import { powerMonitor } from "electron";
import fs from "node:fs";
import {
  getDbPath,
  getBackupPath,
  getSharedSqlite,
  probeDb,
  probeDbFile,
  attemptRecovery,
} from "./persistence/db.js";
import { runDbWork } from "./persistence/dbWorkerClient.js";
import { getSystemSleepService } from "./SystemSleepService.js";
import { tightenFilePermissionsSync, OWNER_RW_FILE_MODE } from "../utils/fs.js";
import type { DbProbeResult } from "./persistence/dbWorkerProtocol.js";
import type { DatabaseRecovery } from "../../shared/types/ipc/app.js";

const TICK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const IDLE_THRESHOLD_S = 60; // 60 seconds of system idle
// Shutdown has a 10s hard timeout, but a wedged DB worker only fails its request
// after 30s (dbWorkerClient's REQUEST_TIMEOUT_MS) — so the wait for an in-flight
// check has to be bounded well inside both. Timing out is safe: the candidate
// probe in runBackup() still refuses to promote an unverified copy.
const QUICK_CHECK_DRAIN_TIMEOUT_MS = 2000;
// Verification failures are not proof the database is bad (a faulty write can
// mangle only the copy), so a single one re-checks the live DB rather than
// latching. Repeated ones mean something is durably wrong — stop rewriting the
// backup and keep the last good one.
const MAX_BACKUP_VERIFY_FAILURES = 3;

class DatabaseMaintenanceService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private removeSuspendListener: (() => void) | null = null;
  private backupPromise: Promise<void> | null = null;
  private disposed = false;
  private initialized = false;
  private deferredQuickCheckPending = false;
  private deferredQuickCheckInFlight: Promise<boolean> | null = null;
  private pendingRecovery: DatabaseRecovery | null = null;
  // Latched when the live database is confirmed corrupt, or when candidates keep
  // failing verification. Recovery cannot run mid-session (the DB is open), so
  // the safe move is to stop backing up entirely and preserve the last good
  // backup for the next boot's probe to restore from.
  private backupsSuspended = false;
  private consecutiveVerifyFailures = 0;

  initialize(wasCleanExit = false): void {
    if (this.initialized) return;
    this.initialized = true;

    const dbPath = getDbPath();

    // Retroactively tighten a legacy .backup written by a pre-fix version before
    // recovery reads or copies it. runBackup rewrites it 0o600 on every tick, but
    // this closes the boot→first-tick window and the corruption-recovery path.
    tightenFilePermissionsSync(getBackupPath());

    // On clean-exit boots corruption is impossible — skip the O(size) page scan
    // and do a cheap open instead. The full quick_check runs from the idle
    // maintenance tick. On unclean exits (crash, power loss, SIGKILL) run the
    // full scan immediately so recovery happens before getSharedDb() opens the file.
    if (!probeDb(dbPath, !wasCleanExit)) {
      console.error("[DatabaseMaintenance] Database corruption detected, attempting recovery");
      const recovery = attemptRecovery(dbPath);
      if (recovery === null) {
        console.error(
          "[DatabaseMaintenance] Recovery failed — corrupt database may still be in place"
        );
      } else {
        this.pendingRecovery = recovery;
        if (recovery.kind === "restored-from-backup") {
          console.log("[DatabaseMaintenance] Recovery successful — restored from backup");
        } else {
          console.warn(
            "[DatabaseMaintenance] No usable backup to restore — fresh database will be created"
          );
        }
      }
    } else if (wasCleanExit) {
      // Clean-exit boots skip the O(size) quick_check; run it once from the
      // first idle tick on the DB worker thread instead.
      this.deferredQuickCheckPending = true;
    }

    console.log("[DatabaseMaintenance] Initialized (probe complete)");
  }

  /**
   * One-shot read of the boot-time recovery outcome, consumed by the first
   * `app:hydrate` so the renderer can tell the user exactly once. Mirrors
   * `consumePendingSettingsRecovery()` in store.ts.
   */
  consumeRecovery(): DatabaseRecovery | null {
    const recovery = this.pendingRecovery;
    this.pendingRecovery = null;
    return recovery;
  }

  /**
   * Hand a consumed recovery back when its payload is about to be thrown away.
   * `app:boot` is fired before the crash-recovery gate resolves, and the renderer
   * discards that payload and re-hydrates whenever a crash was pending — which is
   * precisely the boot where the database gets corrupted, so without this the
   * notification would be lost exactly when it matters most.
   */
  restoreRecovery(recovery: DatabaseRecovery): void {
    this.pendingRecovery ??= recovery;
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

    // Let an outstanding integrity check finish first — if it is about to report
    // corruption, the final backup must not run at all. Bounded: a wedged worker
    // would otherwise hold this for the client's 30s request timeout, blowing
    // past shutdown's own 10s cap. Giving up early is safe — the candidate probe
    // below still refuses to promote an unverified copy.
    if (this.deferredQuickCheckInFlight) {
      await Promise.race([
        this.deferredQuickCheckInFlight.catch(() => undefined),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, QUICK_CHECK_DRAIN_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
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
    // shutdown.ts may still need it for project state saves afterward).
    // A DB already known to be corrupt is never backed up: the existing backup
    // is the only good copy left and the next boot's probe will restore from it.
    if (this.backupsSuspended) {
      console.warn(
        "[DatabaseMaintenance] Skipping final backup — database corruption was detected this session"
      );
    } else {
      await this.runBackup(true);
    }
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

    // Confirmed corruption: never overwrite the last good backup with it.
    if (this.backupsSuspended) return;

    // Gate the backup on the deferred integrity check, but only while one is
    // actually outstanding. Once the DB has passed (or on unclean-exit boots,
    // where initialize() already ran the full scan), the backup fires
    // synchronously from this tick exactly as before — no added latency.
    const quickCheck = this.runDeferredQuickCheck();
    if (quickCheck) {
      void quickCheck.then((ok) => {
        if (ok && !this.disposed && !this.backupsSuspended) {
          this.backupPromise = this.runBackup();
        }
      });
      return;
    }

    this.backupPromise = this.runBackup();
  }

  /**
   * Runs the deferred full quick_check, at most one at a time. Resolves to
   * whether the backup may proceed; returns null when no check is outstanding.
   *
   * The pending flag only clears on an exact "ok" — a check that never succeeded
   * must never look like one that did, so a worker-unavailable result leaves it
   * set for a later idle tick to retry. That case still allows the backup: the
   * candidate probe in runBackup() is the real guard against promoting a corrupt
   * copy, and it catches on main exactly what the worker could not check here.
   * Only confirmed corruption stops backups, via `backupsSuspended`.
   */
  private runDeferredQuickCheck(): Promise<boolean> | null {
    if (this.deferredQuickCheckInFlight) return this.deferredQuickCheckInFlight;
    if (!this.deferredQuickCheckPending) return null;

    // Never on main — when the worker is unavailable the fallback skips the scan
    // rather than stalling the event loop for it.
    const inFlight = runDbWork<string | null>({ op: "quickCheck" }, () => null)
      .then((result) => {
        if (result === "ok") {
          this.deferredQuickCheckPending = false;
          return true;
        }
        if (result === null) {
          console.warn(
            "[DatabaseMaintenance] Deferred quick_check skipped — DB worker unavailable; will retry next idle tick"
          );
          return true;
        }
        this.backupsSuspended = true;
        console.error(
          `[DatabaseMaintenance] Deferred quick_check reported corruption in ${getDbPath()} — backups suspended to preserve the existing backup:`,
          result
        );
        return false;
      })
      .catch((error: unknown) => {
        console.warn("[DatabaseMaintenance] Deferred quick_check failed; will retry:", error);
        return true;
      })
      .finally(() => {
        this.deferredQuickCheckInFlight = null;
      });

    this.deferredQuickCheckInFlight = inFlight;
    return inFlight;
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

  /**
   * `probeOnMain` is set by dispose(): shutdown.ts drains the DB worker before
   * it calls us, so going through runDbWork there would spawn a fresh worker
   * purely to tear it down. Probe directly instead — dispose() already accepts
   * synchronous optimize + TRUNCATE on main.
   */
  private async runBackup(probeOnMain = false): Promise<void> {
    if (this.backupPromise && !this.disposed) {
      // Another backup is already in flight from a tick — skip
      return this.backupPromise;
    }

    const sqlite = getSharedSqlite();
    if (!sqlite) return;

    const backupPath = getBackupPath();
    const tmpPath = backupPath + ".tmp";

    try {
      // Pre-create the candidate owner-only so it is never world-readable during
      // the (potentially slow) page copy — the temp is a verbatim copy of the
      // whole database. "w" truncates any stale temp from a crashed run; better-
      // sqlite3 backs up correctly into a pre-existing empty file. POSIX-only.
      if (process.platform !== "win32") {
        try {
          fs.closeSync(fs.openSync(tmpPath, "w", OWNER_RW_FILE_MODE));
        } catch {
          // best-effort; the post-backup chmod below still tightens the result
        }
      }

      await sqlite.backup(tmpPath);

      // Re-assert owner-only after the copy (exactness + covers the win32/no-
      // precreate path) before the rename promotes it to the final .backup path.
      tightenFilePermissionsSync(tmpPath);

      // sqlite.backup() copies pages verbatim and never validates them, so a
      // corrupt source yields a corrupt copy with no error at all. Probe the
      // candidate before it replaces the last known-good backup. Note this uses
      // probeDbFile, NOT probeDb: probeDb is fail-open on unreadable files, and
      // promoting an unverifiable candidate over the only good backup is exactly
      // the destruction this guards against.
      const verdict = probeOnMain
        ? probeDbFile(tmpPath)
        : await runDbWork<DbProbeResult>({ op: "probePath", dbPath: tmpPath }, () =>
            probeDbFile(tmpPath)
          );

      if (verdict !== "ok") {
        this.discardTempBackup(tmpPath);
        this.onBackupVerifyFailed(verdict, backupPath);
        return;
      }

      fs.renameSync(tmpPath, backupPath);
      this.consecutiveVerifyFailures = 0;
    } catch (error) {
      console.warn("[DatabaseMaintenance] Backup failed:", error);
      this.discardTempBackup(tmpPath);
    } finally {
      this.backupPromise = null;
    }
  }

  /**
   * A candidate that failed verification tells us the COPY is unusable — not, on
   * its own, that the live database is. A faulty write can mangle only the temp
   * file. So re-run the full check against the live DB and let THAT decide
   * whether to stop backing up, rather than condemning a healthy database on
   * indirect evidence. Repeated failures give up regardless: something is
   * durably wrong, and rewriting the backup from a suspect source is not worth
   * the risk to the last good copy.
   */
  private onBackupVerifyFailed(verdict: DbProbeResult, backupPath: string): void {
    this.consecutiveVerifyFailures += 1;

    if (verdict === "corrupt") {
      this.deferredQuickCheckPending = true;
      console.error(
        `[DatabaseMaintenance] New backup failed its integrity check — discarding it, keeping the existing backup at ${backupPath}, and re-checking the live database`
      );
    } else {
      console.warn(
        `[DatabaseMaintenance] Could not verify the new backup — discarding it and keeping the existing backup at ${backupPath}; will retry`
      );
    }

    if (this.consecutiveVerifyFailures >= MAX_BACKUP_VERIFY_FAILURES) {
      this.backupsSuspended = true;
      console.error(
        `[DatabaseMaintenance] ${this.consecutiveVerifyFailures} backups in a row failed verification — suspending backups to preserve the existing backup at ${backupPath}`
      );
    }
  }

  private discardTempBackup(tmpPath: string): void {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (error) {
      console.warn(`[DatabaseMaintenance] Failed to remove temp backup ${tmpPath}:`, error);
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
