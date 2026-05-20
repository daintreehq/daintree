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
import { resilientAtomicWriteFileSync, resilientRenameSync } from "../utils/fs.js";

const MAX_CRASH_LOGS = 10;
const MARKER_FILENAME = "running.lock";
const CRASHES_DIR = "crashes";
const BACKUP_DIR = "backups";
const BACKUP_FILENAME = "session-state.json";
const CRASHED_BACKUP_PREFIX = "session-state.crashed-";
const BACKUP_INTERVAL_MS = 60_000;
const DEBOUNCE_BACKUP_MS = 1_500;
const BLUR_BACKUP_DEBOUNCE_MS = 100;
const SUSPECT_WINDOW_MS = 30_000;
// If the heartbeat field in the marker is older than this on next launch, the
// previous session was almost certainly killed externally (SIGKILL, OOM killer,
// force-quit) before its backup tick could refresh the stamp.
const HEARTBEAT_STALE_THRESHOLD_MS = 120_000;

export class CrashRecoveryService {
  private userData: string;
  private markerPath: string;
  private crashesDir: string;
  private backupPath: string;
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

  constructor() {
    this.userData = app.getPath("userData");
    this.markerPath = path.join(this.userData, MARKER_FILENAME);
    this.crashesDir = path.join(this.userData, CRASHES_DIR);
    this.backupPath = path.join(this.userData, BACKUP_DIR, BACKUP_FILENAME);
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

  getLastBackupTimestamp(): number | null {
    const info = this.readBackupInfo();
    return info.exists && typeof info.timestamp === "number" ? info.timestamp : null;
  }

  getConfig(): CrashRecoveryConfig {
    const stored = store.get("crashRecovery");
    return {
      autoRestoreOnCrash:
        typeof stored?.autoRestoreOnCrash === "boolean" ? stored.autoRestoreOnCrash : false,
    };
  }

  setConfig(patch: Partial<CrashRecoveryConfig>): CrashRecoveryConfig {
    const current = this.getConfig();
    const updated = { ...current, ...patch };
    store.set("crashRecovery", updated);
    return updated;
  }

  recordCrash(error?: Error | unknown): void {
    if (this.crashRecorded) return;
    this.crashRecorded = true;

    try {
      fs.mkdirSync(this.crashesDir, { recursive: true });

      const entry = this.buildCrashEntry(error);
      const logPath = path.join(this.crashesDir, `crash-${entry.id}.json`);
      resilientAtomicWriteFileSync(logPath, JSON.stringify(entry, null, 2), "utf-8");
      this.writeMarker(entry);
      this.pruneOldLogs();
      console.log("[CrashRecovery] Crash recorded:", logPath);
    } catch (err) {
      console.error("[CrashRecovery] Failed to record crash:", err);
    }
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
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.takeBackup();
    }, DEBOUNCE_BACKUP_MS);
  }

  takeBackup(): void {
    try {
      const backupDir = path.join(this.userData, BACKUP_DIR);
      fs.mkdirSync(backupDir, { recursive: true });

      const snapshot = this.captureSessionSnapshot();
      resilientAtomicWriteFileSync(this.backupPath, JSON.stringify(snapshot, null, 2), "utf-8");
    } catch (err) {
      console.error("[CrashRecovery] Failed to take backup:", err);
    }
  }

  restoreBackup(panelIds?: string[]): boolean {
    try {
      // After a crash, consumeMarker() renames the live backup file to a
      // timestamped crashed-* path. Read from that path so the current
      // session's backup tick can recreate session-state.json without
      // clobbering the pre-crash snapshot. Fall back to the live path for
      // explicit user-driven restores in a non-crash session.
      const sourcePath = this.crashedBackupPath ?? this.backupPath;
      if (!fs.existsSync(sourcePath)) return false;
      const raw = fs.readFileSync(sourcePath, "utf8");
      let snapshot = JSON.parse(raw) as SessionSnapshot;

      if (panelIds !== undefined && panelIds.length > 0 && snapshot.appState) {
        // Filter onto a shallow copy so we don't mutate the parsed snapshot.
        // If applySessionSnapshot below throws and the user retries the
        // restore (with or without a different filter), re-reading from
        // the crashed-* file gives the full pre-crash terminal list again.
        const appState = { ...(snapshot.appState as Record<string, unknown>) };
        if (Array.isArray(appState.terminals)) {
          const idSet = new Set(panelIds);
          appState.terminals = (appState.terminals as Array<{ id: string }>).filter((t) =>
            idSet.has(t.id)
          );
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

      if (!app.isPackaged && marker.isPackaged === false && !marker.crashLogPath) {
        console.log("[CrashRecovery] Orphaned dev-mode marker — discarding (not a crash)");
        this.deleteMarker();
        return null;
      }

      this.deleteMarker();

      // Move the live backup aside before any other code path (notably
      // startBackupTimer in this new session) can overwrite it. The renamed
      // file becomes the durable source of truth for restoreBackup and
      // extractPanelSummaries — no in-memory cache, no race.
      this.crashedBackupPath = this.preserveBackupForRecovery(marker.sessionStartMs);

      let backupTimestamp: number | undefined;
      if (this.crashedBackupPath !== null) {
        try {
          backupTimestamp = fs.statSync(this.crashedBackupPath).mtimeMs;
        } catch {
          // best-effort: backup timestamp is informational only
        }
      }

      const logPath = marker.crashLogPath ?? null;
      const entry = logPath ? this.readCrashLog(logPath) : this.buildCrashEntryFromMarker(marker);
      entry.crashCause = this.classifyCrashCause(marker);
      const panels =
        this.crashedBackupPath !== null ? this.extractPanelSummaries(entry.timestamp) : undefined;

      return {
        logPath: logPath ?? path.join(this.crashesDir, `crash-${entry.id}.json`),
        entry,
        hasBackup: this.crashedBackupPath !== null,
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
    if (!fs.existsSync(this.backupPath)) return null;

    const crashedBackupPath = path.join(
      this.userData,
      BACKUP_DIR,
      `${CRASHED_BACKUP_PREFIX}${markerSessionStartMs}.json`
    );

    try {
      resilientRenameSync(this.backupPath, crashedBackupPath);
      return crashedBackupPath;
    } catch (renameErr) {
      try {
        const content = fs.readFileSync(this.backupPath, "utf-8");
        resilientAtomicWriteFileSync(crashedBackupPath, content, "utf-8");
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
    if (!this.crashedBackupPath) return;
    try {
      fs.unlinkSync(this.crashedBackupPath);
    } catch {
      // File may already be gone (multiple cleanup paths can race); ignore.
    }
    this.crashedBackupPath = null;
  }

  private extractPanelSummaries(crashTimestamp: number): PanelSummary[] {
    try {
      // Reads the renamed crashed-* file populated by consumeMarker. The
      // current session's backup tick can recreate session-state.json freely
      // — it can't overwrite the renamed file, so panel summaries here and
      // restoreBackup later see the same pre-crash snapshot.
      if (!this.crashedBackupPath || !fs.existsSync(this.crashedBackupPath)) return [];
      const raw = fs.readFileSync(this.crashedBackupPath, "utf8");
      const snapshot = JSON.parse(raw) as SessionSnapshot;
      if (!snapshot.appState) return [];

      const appState = snapshot.appState as Record<string, unknown>;
      const terminals = appState.terminals;
      if (!Array.isArray(terminals)) return [];

      return terminals.map((t: Record<string, unknown>) => ({
        id: String(t.id ?? ""),
        kind: String(t.kind ?? "terminal"),
        title: String(t.title ?? ""),
        cwd: t.cwd ? String(t.cwd) : undefined,
        worktreeId: t.worktreeId ? String(t.worktreeId) : undefined,
        location: (t.location === "dock" ? "dock" : "grid") as "grid" | "dock",
        isSuspect:
          typeof t.createdAt === "number"
            ? Math.abs(crashTimestamp - t.createdAt) < SUSPECT_WINDOW_MS
            : false,
        agentState: coerceAgentState(t.agentState),
        lastStateChange: typeof t.lastStateChange === "number" ? t.lastStateChange : undefined,
      }));
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
      resilientAtomicWriteFileSync(this.markerPath, JSON.stringify(marker), "utf-8");
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
      resilientAtomicWriteFileSync(this.markerPath, JSON.stringify(marker), "utf-8");
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

  private buildCrashEntryFromMarker(marker: MarkerFile): CrashLogEntry {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const entry: CrashLogEntry = {
      id,
      timestamp: Date.now(),
      appVersion: marker.appVersion ?? app.getVersion(),
      platform: marker.platform ?? process.platform,
      osVersion: os.release(),
      arch: os.arch(),
      sessionDurationMs: marker.sessionStartMs ? Date.now() - marker.sessionStartMs : undefined,
    };

    this.enrichWithEnvironmentMetadata(entry);
    this.enrichWithPanelData(entry, this.readCrashedBackupAppState());

    return entry;
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

  private readBackupInfo(): { exists: boolean; timestamp?: number } {
    try {
      if (!fs.existsSync(this.backupPath)) return { exists: false };
      const stat = fs.statSync(this.backupPath);
      return { exists: true, timestamp: stat.mtimeMs };
    } catch {
      return { exists: false };
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
