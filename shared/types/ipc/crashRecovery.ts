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

export interface PendingCrash {
  logPath: string;
  entry: CrashLogEntry;
  hasBackup: boolean;
  backupTimestamp?: number;
}

export interface CrashRecoveryConfig {
  autoRestoreOnCrash: boolean;
}

export type CrashRecoveryAction = "restore" | "fresh";
