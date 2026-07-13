// eager-import-allow: reads/writes crash-recovery state via sync fs and store.get during early startup
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type {
  CrashCause,
  CrashLogEntry,
  CrashRecoveryConfig,
  PanelSummary,
  PendingCrash,
} from "../../shared/types/ipc/crashRecovery.js";
import { coerceAgentState } from "../../shared/types/agent.js";
import { store, windowStatesStore } from "../store.js";
import { isGpuDisabledByFlag } from "./GpuCrashMonitorService.js";
import { getSystemSleepService } from "./SystemSleepService.js";
import { getActionBreadcrumbService } from "./ActionBreadcrumbService.js";
import {
  resilientAtomicWriteFileSync,
  resilientRenameSync,
  tightenDirPermissionsSync,
  OWNER_RW_FILE_MODE,
  OWNER_RWX_DIR_MODE,
} from "../utils/fs.js";
import { WATCHDOG_KILL_FLAG_NAME } from "../watchdog-host-core.js";

const MAX_CRASH_LOGS = 10;
const MARKER_FILENAME = "running.lock";
const CRASHES_DIR = "crashes";
const BACKUP_DIR = "backups";
const BACKUP_FILENAME = "session-state.json";
const CRASHED_BACKUP_PREFIX = "session-state.crashed-";
// Previous-generation backup, kept as a Firefox-style rolling pair so a
// corrupt write (truncated, partial, or unparseable) doesn't destroy the only
// recovery snapshot. takeBackup() rotates current → previous before writing
// new current; restoreBackup()/readBackupInfo() fall back to previous when
// current is missing or fails to parse.
const PREVIOUS_BACKUP_FILENAME = "session-state.previous.json";
const BACKUP_INTERVAL_MS = 60_000;
const DEBOUNCE_BACKUP_MS = 1_500;
const BLUR_BACKUP_DEBOUNCE_MS = 100;
const SUSPECT_WINDOW_MS = 30_000;
// If the heartbeat field in the marker is older than this on next launch, the
// previous session was almost certainly killed externally (SIGKILL, OOM killer,
// force-quit) before its backup tick could refresh the stamp.
const HEARTBEAT_STALE_THRESHOLD_MS = 120_000;
// Negative margin on the watchdog flag's mtime check: filesystem mtime
// resolution (HFS+, ext3) can be up to ~1s, and a flag written in the
// current session will always be ≥ HEARTBEAT_INTERVAL_MS × MAX_MISSED (~15s)
// after sessionStartMs. 5s of grace safely absorbs clock drift and fs jitter
// without admitting any flag from a prior session.
const WATCHDOG_GRACE_MS = 5_000;

interface WatchdogKillAnnotation {
  killedAt: number;
  missedBeats: number;
  mainPid: number;
}

export class CrashRecoveryService {
  private userData: string;
  private markerPath: string;
  private crashesDir: string;
  private backupPath: string;
  private previousBackupPath: string;
  private sessionStartMs: number;
  private pendingCrash: PendingCrash | null = null;
  private backupTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private removeSuspendListener: (() => void) | null = null;
  private removeWakeListener: (() => void) | null = null;
  private blurDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private removeBlurListener: (() => void) | null = null;
  private removeFocusListener: (() => void) | null = null;
  private crashRecorded = false;
  private pendingPanelFilter: string[] | null = null;
  // Path of the renamed crashed-session backup file from the previous launch.
  // Populated in consumeMarker() when the live backup is moved aside so the
  // current session's backup tick cannot overwrite it. Null when there was
  // no pre-crash backup or after the file has been consumed/cleaned up.
  private crashedBackupPath: string | null = null;
  // In-memory snapshot captured during consumeMarker() so restoreBackup() and
  // getBackupPanelCount() can serve the pre-crash state even if the on-disk
  // files are deleted, rotated, or overwritten between marker consumption and
  // the user resolving the recovery dialog.
  private cachedBackupSnapshot: SessionSnapshot | null = null;
  // Memoized crash-recovery config — store.get re-reads and re-parses the
  // whole config.json on every call, which is sync main-thread work inside
  // the boot IPC handler. setConfig keeps the memo in sync with writes.
  private cachedConfig: CrashRecoveryConfig | null = null;
  // Serialized state-dependent snapshot fields (appState + windowStates,
  // excluding capturedAt which changes on every call) from the last successful
  // write. Used to skip the rotate+write on periodic timer ticks when state
  // hasn't changed. Explicit scheduleBackup() calls clear this field so
  // change-driven writes always go through.
  private lastWrittenStateJson: string | null = null;

  constructor() {
    this.userData = app.getPath("userData");
    this.markerPath = path.join(this.userData, MARKER_FILENAME);
    this.crashesDir = path.join(this.userData, CRASHES_DIR);
    this.backupPath = path.join(this.userData, BACKUP_DIR, BACKUP_FILENAME);
    this.previousBackupPath = path.join(this.userData, BACKUP_DIR, PREVIOUS_BACKUP_FILENAME);
    this.sessionStartMs = Date.now();
  }

  initialize(): void {
    this.pendingCrash = this.consumeMarker();
    this.writeMarker();
    console.log("[CrashRecovery] Initialized, pending crash:", this.pendingCrash !== null);
  }

  getPendingCrash(): PendingCrash | null {
    return this.pendingCrash;
  }

  // Drop the in-memory pending-crash record once the user has resolved the
  // recovery dialog. Without this, an LRU-evicted WebContentsView that
  // cold-reboots re-reads the stale record via app:boot and re-presents the
  // dialog on project switch-back (#10809). Disk cleanup is already done by
  // restoreBackup()/resetToFresh(); this only clears the cache, so it is safe
  // to call after those complete. Idempotent.
  clearPendingCrash(): void {
    this.pendingCrash = null;
  }

  getLastBackupTimestamp(): number | null {
    const info = this.readBackupInfo();
    return info.exists && typeof info.timestamp === "number" ? info.timestamp : null;
  }

  getBackupPanelCount(allowDiskFallback: boolean = false): number | null {
    // Cache wins unconditionally. It reflects the snapshot at the moment
    // consumeMarker() learned about the main-process crash, so later disk
    // state (rotations from a normal session tick) must not override it.
    // Without this guard, a "simplify to disk-first" refactor would silently
    // re-introduce the bleed-into-fresh-boot bug pinned by the test at
    // CrashRecoveryService.test.ts:1346.
    if (this.cachedBackupSnapshot) {
      const appState = this.cachedBackupSnapshot.appState as Record<string, unknown> | undefined;
      const terminals = appState?.terminals;
      return Array.isArray(terminals) ? terminals.length : null;
    }
    if (!allowDiskFallback) return null;
    // Renderer-crash mid-session: no marker was ever consumed, so the cache
    // is empty. readBackupInfo() resolves the parseable rotation file
    // (current → previous) and readBackupFile() returns null on torn
    // writes or non-restorable content. Both helpers are observation-only —
    // they never mutate marker or backup state.
    const info = this.readBackupInfo();
    if (!info.exists || !info.path) return null;
    const snapshot = this.readBackupFile(info.path);
    if (!snapshot) return null;
    // Freshness gate: a snapshot from a previous session must not surface a
    // panel count on the current session's recovery page. Mirrors the
    // watchdog freshness check at consumeWatchdogKillFlag (line 637).
    if (snapshot.capturedAt < this.sessionStartMs) return null;
    const fallbackState = snapshot.appState as Record<string, unknown> | undefined;
    const terminals = fallbackState?.terminals;
    return Array.isArray(terminals) ? terminals.length : null;
  }

  getConfig(): CrashRecoveryConfig {
    if (this.cachedConfig) return this.cachedConfig;
    const stored = store.get("crashRecovery");
    this.cachedConfig = {
      autoRestoreOnCrash:
        typeof stored?.autoRestoreOnCrash === "boolean" ? stored.autoRestoreOnCrash : true,
    };
    return this.cachedConfig;
  }

  setConfig(patch: Partial<CrashRecoveryConfig>): CrashRecoveryConfig {
    const current = this.getConfig();
    const updated: CrashRecoveryConfig = { ...current };
    // Drop non-boolean values so a stray `undefined` from a caller can't
    // erase an explicit opt-out and let getConfig() silently fall back to
    // the new `true` default.
    if (typeof patch.autoRestoreOnCrash === "boolean") {
      updated.autoRestoreOnCrash = patch.autoRestoreOnCrash;
    }
    store.set("crashRecovery", updated);
    this.cachedConfig = updated;
    return updated;
  }

  recordCrash(error?: Error | unknown): void {
    if (this.crashRecorded) return;
    this.crashRecorded = true;

    try {
      const entry = this.buildCrashEntry(error);
      // The only call site is the uncaughtException handler, so the cause is
      // always "uncaught-exception" — but the field is additive, default only
      // when absent so a future caller passing a more specific cause is honored.
      if (entry.crashCause === undefined) entry.crashCause = "uncaught-exception";
      const logPath = this.writeCrashLog(entry);
      this.writeMarker(entry);
      this.pruneOldLogs();
      console.log("[CrashRecovery] Crash recorded:", logPath);
    } catch (err) {
      console.error("[CrashRecovery] Failed to record crash:", err);
    }
  }

  /**
   * Persist a crash log to `crashesDir/crash-{id}.json` using the same
   * `resilientAtomicWriteFileSync` channel as `recordCrash` (handles Windows
   * AV/indexer lock retries). Shared by `recordCrash` and the marker-only
   * branch of `consumeMarker` so both call sites produce a real on-disk
   * artifact and the dialog's "Open log file" affordance always points at a
   * file that exists.
   */
  private writeCrashLog(entry: CrashLogEntry): string {
    fs.mkdirSync(this.crashesDir, { recursive: true, mode: OWNER_RWX_DIR_MODE });
    tightenDirPermissionsSync(this.crashesDir);
    const logPath = path.join(this.crashesDir, `crash-${entry.id}.json`);
    resilientAtomicWriteFileSync(logPath, JSON.stringify(entry, null, 2), "utf-8", {
      mode: OWNER_RW_FILE_MODE,
    });
    return logPath;
  }

  startBackupTimer(): void {
    if (this.backupTimer) return;
    this.takeBackup();
    this.updateMarkerHeartbeat();
    this.backupTimer = setInterval(() => {
      this.takeBackup();
      this.updateMarkerHeartbeat();
    }, BACKUP_INTERVAL_MS);
    this.registerSleepListeners();
    this.registerBlurListener();
  }

  stopBackupTimer(): void {
    if (this.backupTimer) {
      clearInterval(this.backupTimer);
      this.backupTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.unregisterSleepListeners();
    this.unregisterBlurListener();
  }

  private registerSleepListeners(): void {
    this.unregisterSleepListeners();
    try {
      this.removeSuspendListener = getSystemSleepService().onSuspend(() => {
        // Stamp the suspend start time so a power loss during sleep can be
        // attributed to "suspended-then-lost" on the next launch instead of
        // looking like a generic crash with a stale heartbeat.
        this.stampSuspend(Date.now());
        if (this.backupTimer) {
          clearInterval(this.backupTimer);
          this.backupTimer = null;
        }
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
          this.debounceTimer = null;
        }
      });
      this.removeWakeListener = getSystemSleepService().onWake(() => {
        this.clearSuspend();
        this.startBackupTimer();
      });
    } catch {
      // SystemSleepService may not be initialized yet at early startup.
    }
  }

  private unregisterSleepListeners(): void {
    if (this.removeSuspendListener) {
      this.removeSuspendListener();
      this.removeSuspendListener = null;
    }
    if (this.removeWakeListener) {
      this.removeWakeListener();
      this.removeWakeListener = null;
    }
  }

  private registerBlurListener(): void {
    this.unregisterBlurListener();

    const onBlur = () => {
      if (this.blurDebounceTimer) {
        clearTimeout(this.blurDebounceTimer);
      }
      this.blurDebounceTimer = setTimeout(() => {
        this.blurDebounceTimer = null;
        if (!BrowserWindow.getFocusedWindow()) {
          this.takeBackup();
        }
      }, BLUR_BACKUP_DEBOUNCE_MS);
    };

    const onFocus = () => {
      if (this.blurDebounceTimer) {
        clearTimeout(this.blurDebounceTimer);
        this.blurDebounceTimer = null;
      }
    };

    app.on("browser-window-blur", onBlur);
    app.on("browser-window-focus", onFocus);

    this.removeBlurListener = () => {
      app.removeListener("browser-window-blur", onBlur);
    };
    this.removeFocusListener = () => {
      app.removeListener("browser-window-focus", onFocus);
    };
  }

  private unregisterBlurListener(): void {
    if (this.removeBlurListener) {
      this.removeBlurListener();
      this.removeBlurListener = null;
    }
    if (this.removeFocusListener) {
      this.removeFocusListener();
      this.removeFocusListener = null;
    }
    if (this.blurDebounceTimer) {
      clearTimeout(this.blurDebounceTimer);
      this.blurDebounceTimer = null;
    }
  }

  scheduleBackup(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    // Clear the idempotency guard so the upcoming write goes through regardless
    // of what was written last — a scheduleBackup() call means state changed.
    this.lastWrittenStateJson = null;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.takeBackup();
    }, DEBOUNCE_BACKUP_MS);
  }

  takeBackup(): void {
    try {
      const backupDir = path.join(this.userData, BACKUP_DIR);
      fs.mkdirSync(backupDir, { recursive: true, mode: OWNER_RWX_DIR_MODE });
      tightenDirPermissionsSync(backupDir);

      const snapshot = this.captureSessionSnapshot();

      // Skip the rotate+write on periodic timer ticks when the state-bearing
      // fields are identical to the last write. capturedAt is excluded because
      // it changes on every call regardless of app state. Explicit
      // scheduleBackup() calls clear lastWrittenStateJson so change-driven
      // writes always go through.
      const stateJson = JSON.stringify({
        appState: snapshot.appState,
        windowStates: snapshot.windowStates,
      });
      if (stateJson === this.lastWrittenStateJson) {
        return;
      }

      // Rotate current → previous BEFORE writing new current. If a future
      // write produces corrupt JSON, the previous-generation file still holds
      // the last good snapshot. Rotation is best-effort: a rename failure on
      // Windows under transient lock contention is non-fatal — we proceed with
      // the write and the previous file just isn't refreshed this cycle.
      this.rotateBackup();

      resilientAtomicWriteFileSync(this.backupPath, JSON.stringify(snapshot), "utf-8", {
        mode: OWNER_RW_FILE_MODE,
      });
      this.lastWrittenStateJson = stateJson;
    } catch (err) {
      console.error("[CrashRecovery] Failed to take backup:", err);
    }
  }

  private rotateBackup(): void {
    if (!fs.existsSync(this.backupPath)) return;
    try {
      resilientRenameSync(this.backupPath, this.previousBackupPath);
    } catch (err) {
      // Rotation is best-effort; the new write below will still proceed and
      // overwrite the (possibly stale) previous file on the next cycle.
      console.warn("[CrashRecovery] Backup rotation rename failed:", err);
    }
  }

  restoreBackup(panelIds?: string[]): boolean {
    try {
      // Prefer the snapshot cached by consumeMarker — startBackupTimer can
      // overwrite the on-disk backup files between marker consumption and
      // the user clicking restore, and the renamed crashed-* file could be
      // unlinked concurrently. The cache holds the parsed pre-crash snapshot.
      // Fall back current → previous on disk for explicit user-driven
      // restores in a non-crash session (no cache populated).
      let snapshot: SessionSnapshot | null = this.cachedBackupSnapshot;
      if (!snapshot) {
        const sourcePath = this.crashedBackupPath ?? this.backupPath;
        snapshot = this.readBackupFile(sourcePath);
        if (!snapshot && sourcePath !== this.previousBackupPath) {
          const previous = this.readBackupFile(this.previousBackupPath);
          if (previous) {
            console.log("[CrashRecovery] Current backup unreadable; using previous generation");
            snapshot = previous;
          }
        }
      }
      if (!snapshot) return false;

      if (panelIds !== undefined && panelIds.length > 0 && snapshot.appState) {
        // Filter onto a shallow copy so we don't mutate the parsed snapshot.
        // If applySessionSnapshot below throws and the user retries the
        // restore (with or without a different filter), re-reading from
        // the crashed-* file gives the full pre-crash terminal list again.
        const appState = { ...(snapshot.appState as Record<string, unknown>) };
        if (Array.isArray(appState.terminals)) {
          const originalTerminals = appState.terminals as Array<{ id: string }>;
          const idSet = new Set(panelIds);
          const filtered = originalTerminals.filter((t) => idSet.has(t.id));
          // Stale or typo'd panel IDs would otherwise empty the filter and
          // succeed-then-unlink the crashed-* file, dropping the recovery
          // source the user might still want. Return false so they can
          // retry with the correct IDs or no filter at all.
          if (filtered.length === 0 && originalTerminals.length > 0) {
            return false;
          }
          appState.terminals = filtered;
        }
        snapshot = { ...snapshot, appState };
      }

      if (!hasRestorableSnapshotContent(snapshot)) {
        return false;
      }

      this.applySessionSnapshot(snapshot);
      this.unlinkCrashedBackup();
      console.log(
        "[CrashRecovery] Session restored from backup" +
          (panelIds && panelIds.length > 0 ? ` (${panelIds.length} panels selected)` : "")
      );
      return true;
    } catch (err) {
      console.error("[CrashRecovery] Failed to restore backup:", err);
      return false;
    }
  }

  setPanelFilter(panelIds: string[]): void {
    this.pendingPanelFilter = panelIds;
  }

  consumePanelFilter(): string[] | null {
    const filter = this.pendingPanelFilter;
    this.pendingPanelFilter = null;
    return filter;
  }

  resetToFresh(): void {
    try {
      store.set("appState", {
        sidebarWidth: 350,
        focusMode: false,
        terminals: [],
        hasSeenWelcome: true,
        panelGridConfig: { strategy: "automatic" as const, value: 3 },
      });
      this.unlinkCrashedBackup();
      console.log("[CrashRecovery] Reset to fresh state");
    } catch (err) {
      console.error("[CrashRecovery] Failed to reset to fresh:", err);
    }
  }

  cleanupOnExit(): void {
    this.stopBackupTimer();
    if (!this.crashRecorded) {
      this.takeBackup();
      this.deleteMarker();
      this.cleanupOrphanedCrashedBackups();
      console.log("[CrashRecovery] Clean exit — marker removed");
    }
    this.unlinkCrashedBackup();
  }

  private consumeMarker(): PendingCrash | null {
    if (!fs.existsSync(this.markerPath)) return null;

    try {
      const raw = fs.readFileSync(this.markerPath, "utf8");
      const marker = JSON.parse(raw) as MarkerFile;

      if (!isValidMarker(marker)) {
        console.warn("[CrashRecovery] Corrupt marker file, ignoring");
        this.deleteMarker();
        return null;
      }

      // Read the watchdog kill flag BEFORE the dev-mode discard branch — even
      // an orphaned dev marker may have a fresh flag (real watchdog kill in
      // dev). Consume it unconditionally so a stale flag can't linger across
      // dev restarts. The mtime guard inside consumeWatchdogKillFlag ensures
      // only a fresh flag is treated as an annotation.
      const watchdogAnnotation = this.consumeWatchdogKillFlag(marker);

      if (
        !app.isPackaged &&
        marker.isPackaged === false &&
        !marker.crashLogPath &&
        !watchdogAnnotation
      ) {
        console.log("[CrashRecovery] Orphaned dev-mode marker — discarding (not a crash)");
        this.deleteMarker();
        return null;
      }

      // Move the live backup aside BEFORE any state mutations. A kill
      // between the two operations would otherwise wipe the marker (and
      // skip crash detection on the next launch) while session-state.json
      // is still present and recoverable. preserveBackupForRecovery is
      // idempotent — if a crashed-{sessionStartMs}.json already exists
      // from a partially-completed prior attempt it is reused.
      this.crashedBackupPath = this.preserveBackupForRecovery(marker.sessionStartMs);

      // NOTE: deleteMarker() is called AFTER the synthesized crash log is
      // written below (per the #8728 preserve-before-delete ordering rule).
      // If a kill happens in the gap, the next launch re-runs consumeMarker
      // and surfaces the recovery dialog against the persisted log.
      // (Watchdog annotation rewrites for an existing logPath fire earlier
      // in this block and are unaffected.)

      // Gate hasBackup on parseability: a renamed crashed-* file that fails
      // to parse (corrupted write, partial flush) shouldn't surface a
      // restore option that would silently fail. Verify the crashed-* file
      // parses; if not, fall back to the rotated previous-generation file
      // (rotated by takeBackup before the crash). Cache the parsed snapshot
      // so the recovery dialog and getBackupPanelCount survive concurrent
      // file deletions/overwrites between marker consumption and resolve.
      let backupTimestamp: number | undefined;
      let parseableBackupPath: string | null = null;
      const fromCrashed = this.crashedBackupPath
        ? this.readBackupFile(this.crashedBackupPath)
        : null;
      if (fromCrashed) {
        this.cachedBackupSnapshot = fromCrashed;
        parseableBackupPath = this.crashedBackupPath;
      } else {
        // Crashed file unparseable or missing — drop the pointer so the
        // restoreBackup path doesn't try a known-bad read.
        this.crashedBackupPath = null;
        const fromPrevious = this.readBackupFile(this.previousBackupPath);
        if (fromPrevious) {
          this.cachedBackupSnapshot = fromPrevious;
          parseableBackupPath = this.previousBackupPath;
        }
      }
      if (parseableBackupPath) {
        // Read the timestamp from the parsed snapshot's `capturedAt` rather
        // than the file's disk mtime. On the Windows/EPERM copy-fallback
        // path in preserveBackupForRecovery, the new crashed-* file's mtime
        // is the relaunch time — feeding that into the priority chain
        // would win over the heartbeat and re-introduce the #10062 bug we
        // just fixed. `capturedAt` is the pre-crash write time stamped
        // by captureSessionSnapshot, which is exactly what we want.
        if (this.cachedBackupSnapshot) {
          backupTimestamp = this.cachedBackupSnapshot.capturedAt;
        } else {
          try {
            backupTimestamp = fs.statSync(parseableBackupPath).mtimeMs;
          } catch {
            // best-effort: backup timestamp is informational only
          }
        }
      }

      const logPath = marker.crashLogPath ?? null;
      // Compute the best available estimate of when the previous session
      // actually died. Marker-only entries (no crashLogPath) had no in-process
      // recorder to stamp a real crash time, so without this they'd inherit
      // the relaunch time and mislead the recovery dialog, GitHub crash
      // report, and 30s panel-suspect window. Existing crash logs already
      // carry their own timestamp from the recorder path and are unaffected.
      const nowMs = Date.now();
      const crashTimestamp = this.resolveMarkerCrashTimestamp(
        marker,
        watchdogAnnotation,
        backupTimestamp,
        nowMs
      );
      const entry = logPath
        ? this.readCrashLog(logPath)
        : this.buildCrashEntryFromMarker(marker, crashTimestamp);
      entry.crashCause = this.classifyCrashCause(marker);
      if (watchdogAnnotation) {
        entry.cause = "watchdog-deadlock";
        entry.watchdogKilledAt = watchdogAnnotation.killedAt;
        entry.watchdogMissedBeats = watchdogAnnotation.missedBeats;
        entry.watchdogMainPid = watchdogAnnotation.mainPid;
        // Persist the annotation onto the on-disk crash log too, so a user
        // who opens the JSON file directly (via the dialog's "open log file"
        // affordance, or for support) sees the watchdog attribution. Failure
        // is non-fatal — the in-memory entry is the source of truth.
        if (logPath) {
          try {
            resilientAtomicWriteFileSync(logPath, JSON.stringify(entry, null, 2), "utf-8", {
              mode: OWNER_RW_FILE_MODE,
            });
          } catch (err) {
            console.error("[CrashRecovery] Failed to persist watchdog annotation:", err);
          }
        }
      }

      // For marker-only crashes (no original crashLogPath — e.g. external kill,
      // power loss, native crash), synthesize a real on-disk log so the
      // recovery dialog's "Open log file" affordance points at a file that
      // actually exists. Persist BEFORE deleteMarker (per #8728's
      // preserve-before-delete ordering rule) so a kill in this window still
      // leaves the marker pointing at a real on-disk log, and the next
      // launch re-runs consumeMarker to surface the recovery dialog. Failure
      // is non-fatal — the in-memory entry is the source of truth and the
      // dialog falls back to a softer warning if the file later can't be
      // opened.
      let resolvedLogPath = logPath;
      if (!resolvedLogPath) {
        try {
          resolvedLogPath = this.writeCrashLog(entry);
          // Honor the same MAX_CRASH_LOGS retention as recordCrash so 25
          // consecutive external kills don't accumulate crash-{id}.json
          // files. recordCrash also calls pruneOldLogs; folding it here keeps
          // retention behavior consistent across both code paths.
          this.pruneOldLogs();
        } catch (writeErr) {
          console.error("[CrashRecovery] Failed to persist synthesized crash log:", writeErr);
          // Fall back to the synthetic path so PendingCrash.logPath is stable
          // for the renderer; the dialog's defensive openPath handler covers
          // the missing-file case.
          resolvedLogPath = path.join(this.crashesDir, `crash-${entry.id}.json`);
        }
      }

      // Marker is unlinked LAST — after the synthesized crash log is on disk.
      // A kill between preserveBackupForRecovery and this point still leaves
      // the marker on disk and the next launch re-detects the crash against
      // the persisted log.
      this.deleteMarker();

      const panels = parseableBackupPath
        ? this.extractPanelSummaries(entry.timestamp, parseableBackupPath)
        : undefined;

      return {
        logPath: resolvedLogPath,
        entry,
        hasBackup: parseableBackupPath !== null,
        backupTimestamp,
        panels,
      };
    } catch (err) {
      console.error("[CrashRecovery] Failed to consume marker:", err);
      this.deleteMarker();
      return null;
    }
  }

  /**
   * Renames `session-state.json` to a timestamped `session-state.crashed-*.json`
   * so the new session's backup tick cannot clobber it.
   *
   * On Windows the rename can transiently fail under antivirus or search-indexer
   * locks (EPERM/EBUSY/EACCES). `resilientRenameSync` retries for up to 500ms;
   * if it still fails we fall back to a copy-then-unlink path so the pre-crash
   * snapshot is never silently lost.
   *
   * Returns the path of the renamed (or copied) file, or null if no live
   * backup existed.
   */
  private preserveBackupForRecovery(markerSessionStartMs: number): string | null {
    const crashedBackupPath = path.join(
      this.userData,
      BACKUP_DIR,
      `${CRASHED_BACKUP_PREFIX}${markerSessionStartMs}.json`
    );

    // Idempotency: if a prior consumeMarker run completed the rename but
    // was killed before deleteMarker, the destination is already on disk
    // and the live backup is gone. Reuse the existing crashed-* file.
    if (fs.existsSync(crashedBackupPath)) return crashedBackupPath;

    if (!fs.existsSync(this.backupPath)) return null;

    try {
      resilientRenameSync(this.backupPath, crashedBackupPath);
      return crashedBackupPath;
    } catch (renameErr) {
      try {
        const content = fs.readFileSync(this.backupPath, "utf-8");
        resilientAtomicWriteFileSync(crashedBackupPath, content, "utf-8", {
          mode: OWNER_RW_FILE_MODE,
        });
        try {
          fs.unlinkSync(this.backupPath);
        } catch {
          // The duplicate at crashedBackupPath is the durable copy. If the
          // original still can't be unlinked, the next backup tick will
          // overwrite it — we won't keep reading stale content.
        }
        return crashedBackupPath;
      } catch (copyErr) {
        console.error(
          "[CrashRecovery] Failed to preserve crash backup via rename or copy:",
          renameErr,
          copyErr
        );
        return null;
      }
    }
  }

  /**
   * Best-effort unlink of any leftover `session-state.crashed-*.json` files in
   * the backup directory. Called on clean exit so a force-quit during a future
   * pending-crash dialog can't leak crashed-backup files indefinitely (the
   * orphan-cleanup pattern from #3762).
   */
  private cleanupOrphanedCrashedBackups(): void {
    try {
      const backupDir = path.join(this.userData, BACKUP_DIR);
      if (!fs.existsSync(backupDir)) return;
      const files = fs
        .readdirSync(backupDir)
        .filter((f) => f.startsWith(CRASHED_BACKUP_PREFIX) && f.endsWith(".json"));
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(backupDir, file));
        } catch {
          // best-effort
        }
      }
    } catch {
      // best-effort
    }
  }

  private unlinkCrashedBackup(): void {
    // Always clear the in-memory cache too — keeping it around after the
    // recovery decision is resolved would let a stale pre-crash snapshot
    // surface from getBackupPanelCount or a follow-up restoreBackup call.
    this.cachedBackupSnapshot = null;
    if (!this.crashedBackupPath) return;
    try {
      fs.unlinkSync(this.crashedBackupPath);
    } catch {
      // File may already be gone (multiple cleanup paths can race); ignore.
    }
    this.crashedBackupPath = null;
  }

  /**
   * Read and consume the sidecar flag the watchdog writes synchronously
   * before SIGKILLing main. Returns the annotation when the flag is fresh
   * (mtime >= sessionStartMs - GRACE_MS), or null when missing/stale/malformed.
   * The flag is unlinked unconditionally so a stale flag can't poison
   * subsequent launches.
   */
  private consumeWatchdogKillFlag(marker: MarkerFile): WatchdogKillAnnotation | null {
    const flagPath = path.join(this.userData, WATCHDOG_KILL_FLAG_NAME);
    if (!fs.existsSync(flagPath)) return null;

    let annotation: WatchdogKillAnnotation | null = null;
    try {
      const stat = fs.statSync(flagPath);
      const isFresh = stat.mtimeMs >= marker.sessionStartMs - WATCHDOG_GRACE_MS;
      if (isFresh) {
        const raw = fs.readFileSync(flagPath, "utf8");
        const parsed = JSON.parse(raw) as Partial<WatchdogKillAnnotation>;
        // Defensive range checks: a corrupted flag with all-zero numbers
        // would pass a bare `typeof === "number"` check and produce a
        // misleading attribution. Real values from buildWatchdogKillPayload
        // are always positive (killedAt = Date.now(), missedBeats >= 1,
        // mainPid > 0). `JSON.parse('{"killedAt":1e309}')` returns
        // `Infinity` which passes `> 0` but corrupts the report
        // ("Infinity" in the GitHub crash URL), so finiteness is required.
        if (
          typeof parsed.killedAt === "number" &&
          parsed.killedAt > 0 &&
          Number.isFinite(parsed.killedAt) &&
          typeof parsed.missedBeats === "number" &&
          parsed.missedBeats >= 1 &&
          Number.isFinite(parsed.missedBeats) &&
          typeof parsed.mainPid === "number" &&
          parsed.mainPid > 0 &&
          Number.isFinite(parsed.mainPid)
        ) {
          annotation = {
            killedAt: parsed.killedAt,
            missedBeats: parsed.missedBeats,
            mainPid: parsed.mainPid,
          };
        } else {
          console.warn("[CrashRecovery] Malformed watchdog kill flag, ignoring");
        }
      }
    } catch (err) {
      console.warn("[CrashRecovery] Failed to read watchdog kill flag:", err);
    }

    try {
      fs.unlinkSync(flagPath);
    } catch {
      // best-effort; a stuck flag will be re-evaluated next launch and the
      // mtime guard will reject it if it doesn't match the new session.
    }

    return annotation;
  }

  private extractPanelSummaries(crashTimestamp: number, sourcePath: string): PanelSummary[] {
    try {
      // Prefer the cached snapshot resolved by consumeMarker so concurrent
      // file deletion or backup-tick overwrites can't drop pre-crash panels.
      // Fall back to disk only when the cache wasn't populated.
      let snapshot: SessionSnapshot | null = this.cachedBackupSnapshot;
      if (!snapshot) {
        if (!fs.existsSync(sourcePath)) return [];
        const raw = fs.readFileSync(sourcePath, "utf8");
        snapshot = JSON.parse(raw) as SessionSnapshot;
      }
      if (!snapshot.appState) return [];

      const appState = snapshot.appState as Record<string, unknown>;
      const terminals = appState.terminals;
      if (!Array.isArray(terminals)) return [];

      // Per-item guard so one malformed entry (null, primitive, missing
      // fields) cannot drop the entire panel list. Returning fewer
      // summaries is acceptable; returning none when some were valid is not.
      const summaries: PanelSummary[] = [];
      for (const entry of terminals) {
        if (typeof entry !== "object" || entry === null) continue;
        const t = entry as Record<string, unknown>;
        const isSuspect =
          typeof t.createdAt === "number"
            ? Math.abs(crashTimestamp - t.createdAt) < SUSPECT_WINDOW_MS
            : false;
        summaries.push({
          id: String(t.id ?? ""),
          kind: String(t.kind ?? "terminal"),
          title: String(t.title ?? ""),
          cwd: t.cwd ? String(t.cwd) : undefined,
          worktreeId: t.worktreeId ? String(t.worktreeId) : undefined,
          location: (t.location === "dock" ? "dock" : "grid") as "grid" | "dock",
          isSuspect,
          suspectReason: isSuspect ? "crash-window" : undefined,
          agentState: coerceAgentState(t.agentState),
          lastStateChange: typeof t.lastStateChange === "number" ? t.lastStateChange : undefined,
        });
      }
      return summaries;
    } catch {
      return [];
    }
  }

  private writeMarker(crashEntry?: CrashLogEntry): void {
    try {
      const marker: MarkerFile = {
        sessionStartMs: this.sessionStartMs,
        appVersion: app.getVersion(),
        platform: process.platform,
        isPackaged: app.isPackaged,
        // Initialize the heartbeat to sessionStartMs so a launch that crashes
        // before the first backup tick can still be classified as such — an
        // undefined heartbeat would suppress external-kill detection entirely.
        lastHeartbeatMs: this.sessionStartMs,
        crashLogPath: crashEntry
          ? path.join(this.crashesDir, `crash-${crashEntry.id}.json`)
          : undefined,
      };
      resilientAtomicWriteFileSync(this.markerPath, JSON.stringify(marker), "utf-8", {
        mode: OWNER_RW_FILE_MODE,
      });
    } catch (err) {
      console.error("[CrashRecovery] Failed to write marker:", err);
    }
  }

  /**
   * Read-modify-write the marker so existing fields (crashLogPath,
   * lastSuspendStart) are preserved. The in-memory approach used previously
   * for the backup snapshot caused the very race this service is rewriting
   * to eliminate — we keep the marker as a single source of truth on disk.
   */
  private mutateMarker(mutate: (marker: MarkerFile) => void): void {
    try {
      if (!fs.existsSync(this.markerPath)) return;
      const raw = fs.readFileSync(this.markerPath, "utf8");
      const marker = JSON.parse(raw) as MarkerFile;
      if (!isValidMarker(marker)) return;
      mutate(marker);
      resilientAtomicWriteFileSync(this.markerPath, JSON.stringify(marker), "utf-8", {
        mode: OWNER_RW_FILE_MODE,
      });
    } catch (err) {
      console.warn("[CrashRecovery] Failed to mutate marker:", err);
    }
  }

  private updateMarkerHeartbeat(): void {
    this.mutateMarker((marker) => {
      marker.lastHeartbeatMs = Date.now();
    });
  }

  private stampSuspend(suspendStartMs: number): void {
    this.mutateMarker((marker) => {
      marker.lastSuspendStart = suspendStartMs;
    });
  }

  private clearSuspend(): void {
    this.mutateMarker((marker) => {
      delete marker.lastSuspendStart;
    });
  }

  private deleteMarker(): void {
    try {
      if (fs.existsSync(this.markerPath)) {
        fs.unlinkSync(this.markerPath);
      }
    } catch (err) {
      console.error("[CrashRecovery] Failed to delete marker:", err);
    }
  }

  private buildCrashEntry(error?: Error | unknown): CrashLogEntry {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const entry: CrashLogEntry = {
      id,
      timestamp: Date.now(),
      appVersion: app.getVersion(),
      platform: process.platform,
      osVersion: os.release(),
      arch: os.arch(),
      sessionDurationMs: Date.now() - this.sessionStartMs,
    };

    if (error instanceof Error) {
      entry.errorMessage = error.message;
      entry.errorStack = error.stack;
    } else if (error !== undefined) {
      entry.errorMessage = String(error);
    }

    this.enrichWithEnvironmentMetadata(entry);
    this.enrichWithPanelData(entry, store.get("appState"));
    this.enrichWithRecentActions(entry);

    return entry;
  }

  private buildCrashEntryFromMarker(marker: MarkerFile, crashTimestamp: number): CrashLogEntry {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const entry: CrashLogEntry = {
      id,
      timestamp: crashTimestamp,
      appVersion: marker.appVersion ?? app.getVersion(),
      platform: marker.platform ?? process.platform,
      osVersion: os.release(),
      arch: os.arch(),
      sessionDurationMs: marker.sessionStartMs
        ? Math.max(0, crashTimestamp - marker.sessionStartMs)
        : undefined,
    };

    this.enrichWithEnvironmentMetadata(entry);
    this.enrichWithPanelData(entry, this.readCrashedBackupAppState());
    this.enrichWithRecentActions(entry);

    return entry;
  }

  /**
   * Pick the best available estimate of when the previous session actually
   * died, for entries synthesized from a marker with no crash log.
   *
   * Priority chain (strongest signal first):
   *   1. watchdogAnnotation.killedAt — exact SIGKILL time the watchdog wrote
   *   2. marker.lastSuspendStart — power loss during sleep
   *   3. backupTimestamp — last parseable backup mtime, a floor on
   *      "what state was on disk when death occurred"
   *   4. marker.lastHeartbeatMs — the heartbeat we tick every backup
   *      interval; a marker with no heartbeat would have to be from a code
   *      path that pre-dates this service, so it's effectively unreachable.
   *
   * The chosen value is clamped to [sessionStartMs, nowMs] so it can never
   * precede the session (negative `sessionDurationMs` would break
   * `formatDuration` in the dialog) and never exceed the relaunch time
   * (would mislead the 30s suspect window and produce a future-dated crash
   * report). When no candidate is valid the fallback is the clamped
   * relaunch time — the only honest answer in that pathological case.
   */
  private resolveMarkerCrashTimestamp(
    marker: MarkerFile,
    watchdogAnnotation: WatchdogKillAnnotation | null,
    backupTimestamp: number | undefined,
    nowMs: number
  ): number {
    const candidates: Array<number | null | undefined> = [
      watchdogAnnotation?.killedAt,
      marker.lastSuspendStart,
      backupTimestamp,
      marker.lastHeartbeatMs,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
        return Math.max(marker.sessionStartMs, Math.min(candidate, nowMs));
      }
    }
    return Math.max(marker.sessionStartMs, nowMs);
  }

  private readCrashedBackupAppState(): unknown {
    if (!this.crashedBackupPath) return undefined;
    try {
      if (!fs.existsSync(this.crashedBackupPath)) return undefined;
      const raw = fs.readFileSync(this.crashedBackupPath, "utf-8");
      const snapshot = JSON.parse(raw) as SessionSnapshot;
      return snapshot.appState;
    } catch {
      return undefined;
    }
  }

  /**
   * Best-effort classification of why the previous session ended.
   *
   * Priority order matters: stronger signals override weaker ones. A
   * crashLogPath (set by recordCrash on uncaughtException) is the strongest
   * signal because it was written by our own code; we trust it. Crashpad
   * minidumps come from the OS-level handler and prove a native fault.
   * Suspend/heartbeat/uptime are heuristics that distinguish power loss
   * from external kills.
   */
  private classifyCrashCause(marker: MarkerFile): CrashCause {
    if (marker.crashLogPath) return "uncaught-exception";
    if (this.hasRecentCrashpadDump(marker.sessionStartMs)) return "native-crash";
    if (typeof marker.lastSuspendStart === "number") return "suspended-then-lost";
    if (this.didSystemReboot(marker.sessionStartMs)) return "power-loss";
    if (this.isHeartbeatStale(marker.lastHeartbeatMs)) return "external-kill";
    return "unknown";
  }

  /**
   * Scans Electron's Crashpad directories for `.dmp` files written after the
   * previous session started. Crashpad writes minidumps synchronously before
   * the process terminates, so a newer dump file is definitive evidence the
   * crash was a native fault (segfault, OOM, GPU process crash, etc.) rather
   * than a JS exception or external kill.
   */
  private hasRecentCrashpadDump(sessionStartMs: number): boolean {
    let dumpsDir: string;
    try {
      dumpsDir = app.getPath("crashDumps");
    } catch {
      return false;
    }
    // Crashpad shards dumps across these three subdirectories depending on
    // their lifecycle. A dump can appear in any of them at next launch.
    const subdirs = ["new", "pending", "completed"];
    for (const subdir of subdirs) {
      const fullPath = path.join(dumpsDir, subdir);
      try {
        if (!fs.existsSync(fullPath)) continue;
        const files = fs.readdirSync(fullPath);
        for (const file of files) {
          if (!file.endsWith(".dmp")) continue;
          try {
            const stat = fs.statSync(path.join(fullPath, file));
            if (stat.mtimeMs > sessionStartMs) return true;
          } catch {
            // best-effort
          }
        }
      } catch {
        // best-effort
      }
    }
    return false;
  }

  /**
   * True only when `os.uptime()` is shorter than the wall-clock time since
   * the previous session started — a definitive reboot signal. Reliable
   * positively only: sleep pauses uptime on macOS/Linux and Windows Fast
   * Startup hibernation does not reset it, so the absence of this signal
   * does NOT prove the system did not reboot.
   */
  private didSystemReboot(sessionStartMs: number, nowMs: number = Date.now()): boolean {
    try {
      const uptimeMs = os.uptime() * 1000;
      const elapsedMs = nowMs - sessionStartMs;
      if (elapsedMs <= 0) return false;
      return uptimeMs < elapsedMs;
    } catch {
      return false;
    }
  }

  private isHeartbeatStale(
    lastHeartbeatMs: number | undefined,
    nowMs: number = Date.now()
  ): boolean {
    if (typeof lastHeartbeatMs !== "number") return false;
    return nowMs - lastHeartbeatMs > HEARTBEAT_STALE_THRESHOLD_MS;
  }

  private enrichWithRecentActions(entry: CrashLogEntry): void {
    try {
      const recent = getActionBreadcrumbService().getRecentActions();
      if (recent.length > 0) {
        entry.recentActions = recent;
      }
    } catch {
      // best-effort
    }
  }

  private enrichWithEnvironmentMetadata(entry: CrashLogEntry): void {
    try {
      entry.electronVersion = process.versions.electron;
      entry.nodeVersion = process.versions.node;
      entry.chromeVersion = process.versions.chrome;
      entry.v8Version = process.versions.v8;
      entry.isPackaged = app.isPackaged;
    } catch {
      // best-effort
    }

    try {
      entry.totalMemory = os.totalmem();
      entry.freeMemory = os.freemem();
      const mem = process.memoryUsage();
      entry.heapUsed = mem.heapUsed;
      entry.heapTotal = mem.heapTotal;
      entry.rss = mem.rss;
    } catch {
      // best-effort
    }

    try {
      entry.processUptime = Math.round(process.uptime());
      entry.cpuCount = os.cpus().length;
    } catch {
      // best-effort
    }

    try {
      entry.windowCount = BrowserWindow.getAllWindows().length;
    } catch {
      // best-effort
    }

    try {
      entry.gpuAccelerationDisabled = isGpuDisabledByFlag(app.getPath("userData"));
    } catch {
      // best-effort
    }
  }

  private enrichWithPanelData(entry: CrashLogEntry, appState: unknown): void {
    try {
      const state = appState as Record<string, unknown> | undefined;
      const terminals = state?.terminals;
      if (!Array.isArray(terminals)) return;

      entry.panelCount = terminals.length;
      const kinds: Record<string, number> = Object.create(null);
      for (const t of terminals) {
        const kind =
          typeof (t as Record<string, unknown>).kind === "string"
            ? ((t as Record<string, unknown>).kind as string)
            : "unknown";
        kinds[kind] = (kinds[kind] ?? 0) + 1;
      }
      entry.panelKinds = kinds;
    } catch {
      // best-effort
    }
  }

  private readCrashLog(logPath: string): CrashLogEntry {
    try {
      const raw = fs.readFileSync(logPath, "utf8");
      const parsed = JSON.parse(raw) as CrashLogEntry;
      if (typeof parsed.id === "string" && typeof parsed.timestamp === "number") {
        return parsed;
      }
    } catch {
      // fall through
    }
    return this.buildCrashEntry();
  }

  private readBackupInfo(): { exists: boolean; timestamp?: number; path?: string } {
    // Prefer current; fall back to previous so the rotation pair is fully
    // observable. `path` lets callers (consumeMarker, extractPanelSummaries)
    // read from the file that readBackupInfo determined as usable.
    // Parseability is verified before reporting `exists: true` — a stat-able
    // but corrupt current would otherwise mislead the recovery UI into showing
    // a timestamp that points to an unrestorable file while restore silently
    // uses previous. The probe (readBackupFile) reads the whole file; this is
    // acceptable because readBackupInfo is only called during marker consumption
    // (startup) and when the user opens the recovery dialog.
    const currentParseable = this.readBackupFile(this.backupPath) !== null;
    if (currentParseable) {
      try {
        const stat = fs.statSync(this.backupPath);
        return { exists: true, timestamp: stat.mtimeMs, path: this.backupPath };
      } catch {
        // fall through to previous
      }
    }
    const previousParseable = this.readBackupFile(this.previousBackupPath) !== null;
    if (previousParseable) {
      try {
        const stat = fs.statSync(this.previousBackupPath);
        return { exists: true, timestamp: stat.mtimeMs, path: this.previousBackupPath };
      } catch {
        // ignore
      }
    }
    return { exists: false };
  }

  private readBackupFile(filePath: string): SessionSnapshot | null {
    try {
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as SessionSnapshot;
      if (!hasRestorableSnapshotContent(parsed)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private captureSessionSnapshot(): SessionSnapshot {
    return {
      capturedAt: Date.now(),
      appState: store.get("appState"),
      windowStates: windowStatesStore.get("windowStates"),
    };
  }

  private applySessionSnapshot(snapshot: SessionSnapshot): void {
    if (isValidAppStateSnapshot(snapshot.appState)) {
      store.set("appState", snapshot.appState);
    }
    if (isPlainObject(snapshot.windowStates)) {
      windowStatesStore.set("windowStates", snapshot.windowStates as Record<string, unknown>);
    }
  }

  private pruneOldLogs(): void {
    try {
      if (!fs.existsSync(this.crashesDir)) return;
      const files = fs
        .readdirSync(this.crashesDir)
        .filter((f) => f.startsWith("crash-") && f.endsWith(".json"))
        .map((f) => ({ name: f, path: path.join(this.crashesDir, f), mtime: 0 }));

      for (const file of files) {
        try {
          file.mtime = fs.statSync(file.path).mtimeMs;
        } catch {
          // ignore
        }
      }

      files.sort((a, b) => b.mtime - a.mtime);

      for (const file of files.slice(MAX_CRASH_LOGS)) {
        try {
          fs.unlinkSync(file.path);
        } catch {
          // ignore
        }
      }
    } catch (err) {
      console.error("[CrashRecovery] Failed to prune logs:", err);
    }
  }
}

interface MarkerFile {
  sessionStartMs: number;
  appVersion: string;
  platform: string;
  crashLogPath?: string;
  isPackaged?: boolean;
  /**
   * Wall-clock timestamp of the most recent backup-tick liveness write.
   * Refreshed every BACKUP_INTERVAL_MS while the app is running. Compared
   * at next launch against the staleness threshold to detect external
   * kills (heartbeat older than threshold AND system did not reboot).
   */
  lastHeartbeatMs?: number;
  /**
   * Set on powerMonitor "suspend", cleared on "resume". A non-null value
   * at next launch means the system slept and never made it through the
   * resume callback — usually a power loss during sleep.
   */
  lastSuspendStart?: number;
}

interface SessionSnapshot {
  capturedAt: number;
  appState?: unknown;
  windowStates?: unknown;
}

function isValidMarker(value: unknown): value is MarkerFile {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as MarkerFile).sessionStartMs === "number" &&
    Number.isFinite((value as MarkerFile).sessionStartMs) &&
    (value as MarkerFile).sessionStartMs > 0 &&
    typeof (value as MarkerFile).appVersion === "string"
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidAppStateSnapshot(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    return false;
  }

  const terminals = value.terminals;
  if (terminals !== undefined && !Array.isArray(terminals)) {
    return false;
  }

  return true;
}

function hasRestorableSnapshotContent(snapshot: SessionSnapshot): boolean {
  return isValidAppStateSnapshot(snapshot.appState) || isPlainObject(snapshot.windowStates);
}

let instance: CrashRecoveryService | null = null;

export function getCrashRecoveryService(): CrashRecoveryService {
  if (!instance) {
    instance = new CrashRecoveryService();
  }
  return instance;
}

export function initializeCrashRecoveryService(): CrashRecoveryService {
  const service = getCrashRecoveryService();
  service.initialize();
  return service;
}
