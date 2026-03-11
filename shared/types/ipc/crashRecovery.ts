export interface CrashLogEntry {
  id: string;
  timestamp: number;
  appVersion: string;
  platform: string;
  osVersion: string;
  arch: string;
  errorMessage?: string;
  errorStack?: string;
  sessionDurationMs?: number;
}

export interface PanelSummary {
  id: string;
  kind: string;
  title: string;
  cwd?: string;
  worktreeId?: string;
  location: "grid" | "dock";
  isSuspect: boolean;
}

export interface PendingCrash {
  logPath: string;
  entry: CrashLogEntry;
  hasBackup: boolean;
  backupTimestamp?: number;
  panels?: PanelSummary[];
}

export interface CrashRecoveryConfig {
  autoRestoreOnCrash: boolean;
}

export type CrashRecoveryAction = { kind: "restore"; panelIds: string[] } | { kind: "fresh" };
