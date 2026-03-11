import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type {
  CrashLogEntry,
  CrashRecoveryConfig,
  PendingCrash,
} from "../../shared/types/ipc/crashRecovery.js";
import { store } from "../store.js";

const MAX_CRASH_LOGS = 10;
const MARKER_FILENAME = "running.lock";
const CRASHES_DIR = "crashes";
const BACKUP_DIR = "backups";
const BACKUP_FILENAME = "session-state.json";
const BACKUP_INTERVAL_MS = 60_000;

export class CrashRecoveryService {
  private userData: string;
  private markerPath: string;
  private crashesDir: string;
  private backupPath: string;
  private sessionStartMs: number;
  private pendingCrash: PendingCrash | null = null;
  private backupTimer: ReturnType<typeof setInterval> | null = null;
  private crashRecorded = false;

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

  restoreBackup(): boolean {
    try {
      if (!fs.existsSync(this.backupPath)) return false;
      const raw = fs.readFileSync(this.backupPath, "utf8");
      const snapshot = JSON.parse(raw) as SessionSnapshot;
      this.applySessionSnapshot(snapshot);
      console.log("[CrashRecovery] Session restored from backup");
      return true;
    } catch (err) {
      console.error("[CrashRecovery] Failed to restore backup:", err);
      return false;
    }
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

      this.deleteMarker();

      const logPath = marker.crashLogPath ?? null;
      const entry = logPath ? this.readCrashLog(logPath) : this.buildCrashEntryFromMarker(marker);
      const backupInfo = this.readBackupInfo();

      return {
        logPath: logPath ?? path.join(this.crashesDir, `crash-${entry.id}.json`),
        entry,
        hasBackup: backupInfo.exists,
        backupTimestamp: backupInfo.timestamp,
      };
    } catch (err) {
      console.error("[CrashRecovery] Failed to consume marker:", err);
      this.deleteMarker();
      return null;
    }
  }

  private writeMarker(crashEntry?: CrashLogEntry): void {
    try {
      const marker: MarkerFile = {
        sessionStartMs: this.sessionStartMs,
        appVersion: app.getVersion(),
        platform: process.platform,
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

    return entry;
  }

  private buildCrashEntryFromMarker(marker: MarkerFile): CrashLogEntry {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return {
      id,
      timestamp: Date.now(),
      appVersion: marker.appVersion ?? app.getVersion(),
      platform: marker.platform ?? process.platform,
      osVersion: os.release(),
      arch: os.arch(),
      sessionDurationMs: marker.sessionStartMs ? Date.now() - marker.sessionStartMs : undefined,
    };
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
