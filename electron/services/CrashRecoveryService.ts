import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type {
  CrashLogEntry,
  CrashRecoveryConfig,
  PanelSummary,
  PendingCrash,
} from "../../shared/types/ipc/crashRecovery.js";
import { store } from "../store.js";
import { isGpuDisabledByFlag } from "./GpuCrashMonitorService.js";

const MAX_CRASH_LOGS = 10;
const MARKER_FILENAME = "running.lock";
const CRASHES_DIR = "crashes";
const BACKUP_DIR = "backups";
const BACKUP_FILENAME = "session-state.json";
const BACKUP_INTERVAL_MS = 60_000;
const DEBOUNCE_BACKUP_MS = 1_500;
const SUSPECT_WINDOW_MS = 30_000;

export class CrashRecoveryService {
  private userData: string;
  private markerPath: string;
  private crashesDir: string;
  private backupPath: string;
  private sessionStartMs: number;
  private pendingCrash: PendingCrash | null = null;
  private backupTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private crashRecorded = false;
  private pendingPanelFilter: string[] | null = null;
  private cachedBackupSnapshot: SessionSnapshot | null = null;

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
      this.atomicWrite(logPath, JSON.stringify(entry, null, 2));
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
    this.backupTimer = setInterval(() => {
      this.takeBackup();
    }, BACKUP_INTERVAL_MS);
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
      this.atomicWrite(this.backupPath, JSON.stringify(snapshot, null, 2));
    } catch (err) {
      console.error("[CrashRecovery] Failed to take backup:", err);
    }
  }

  restoreBackup(panelIds?: string[]): boolean {
    try {
      // Use cached snapshot if available (backup file may have been overwritten
      // by startBackupTimer between consumeMarker and user clicking restore)
      let snapshot: SessionSnapshot;
      if (this.cachedBackupSnapshot) {
        snapshot = this.cachedBackupSnapshot;
      } else {
        if (!fs.existsSync(this.backupPath)) return false;
        const raw = fs.readFileSync(this.backupPath, "utf8");
        snapshot = JSON.parse(raw) as SessionSnapshot;
      }

      if (panelIds !== undefined && panelIds.length > 0 && snapshot.appState) {
        const appState = snapshot.appState as Record<string, unknown>;
        if (Array.isArray(appState.terminals)) {
          const idSet = new Set(panelIds);
          appState.terminals = (appState.terminals as Array<{ id: string }>).filter((t) =>
            idSet.has(t.id)
          );
        }
      }

      this.applySessionSnapshot(snapshot);
      this.cachedBackupSnapshot = null;
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
      console.log("[CrashRecovery] Clean exit — marker removed");
    }
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

      const backupInfo = this.readBackupInfo();

      // Cache the backup snapshot early so buildCrashEntryFromMarker can
      // read panel data, and restoreBackup() can use it even if
      // startBackupTimer() overwrites the backup file before the user resolves.
      if (backupInfo.exists) {
        try {
          const raw = fs.readFileSync(this.backupPath, "utf8");
          this.cachedBackupSnapshot = JSON.parse(raw) as SessionSnapshot;
        } catch {
          // If read fails, restoreBackup will fall back to reading from disk
        }
      }

      const logPath = marker.crashLogPath ?? null;
      const entry = logPath ? this.readCrashLog(logPath) : this.buildCrashEntryFromMarker(marker);
      const panels = backupInfo.exists ? this.extractPanelSummaries(entry.timestamp) : undefined;

      return {
        logPath: logPath ?? path.join(this.crashesDir, `crash-${entry.id}.json`),
        entry,
        hasBackup: backupInfo.exists,
        backupTimestamp: backupInfo.timestamp,
        panels,
      };
    } catch (err) {
      console.error("[CrashRecovery] Failed to consume marker:", err);
      this.deleteMarker();
      return null;
    }
  }

  private extractPanelSummaries(crashTimestamp: number): PanelSummary[] {
    try {
      if (!fs.existsSync(this.backupPath)) return [];
      const raw = fs.readFileSync(this.backupPath, "utf8");
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
        agentState: typeof t.agentState === "string" ? t.agentState : undefined,
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
        crashLogPath: crashEntry
          ? path.join(this.crashesDir, `crash-${crashEntry.id}.json`)
          : undefined,
      };
      this.atomicWrite(this.markerPath, JSON.stringify(marker));
    } catch (err) {
      console.error("[CrashRecovery] Failed to write marker:", err);
    }
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
    const backupAppState = this.cachedBackupSnapshot?.appState;
    this.enrichWithPanelData(entry, backupAppState);

    return entry;
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
      windowState: store.get("windowState"),
    };
  }

  private applySessionSnapshot(snapshot: SessionSnapshot): void {
    if (snapshot.appState) store.set("appState", snapshot.appState);
    if (snapshot.windowState) store.set("windowState", snapshot.windowState);
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

  private atomicWrite(targetPath: string, data: string): void {
    const tmpPath = `${targetPath}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmpPath, data, { encoding: "utf8", flush: true } as Parameters<
        typeof fs.writeFileSync
      >[2]);
      fs.renameSync(tmpPath, targetPath);
    } catch (err) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
      throw err;
    }
  }
}

interface MarkerFile {
  sessionStartMs: number;
  appVersion: string;
  platform: string;
  crashLogPath?: string;
  isPackaged?: boolean;
}

interface SessionSnapshot {
  capturedAt: number;
  appState?: unknown;
  windowState?: unknown;
}

function isValidMarker(value: unknown): value is MarkerFile {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as MarkerFile).sessionStartMs === "number" &&
    typeof (value as MarkerFile).appVersion === "string"
  );
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
