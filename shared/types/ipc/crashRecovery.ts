export type ActionBreadcrumbSource = "user" | "keybinding" | "menu" | "agent" | "context-menu";

export interface ActionBreadcrumb {
  id: string;
  actionId: string;
  category: string;
  source: ActionBreadcrumbSource;
  durationMs: number;
  timestamp: number;
  args?: Record<string, unknown>;
  count: number;
}

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
  electronVersion?: string;
  nodeVersion?: string;
  chromeVersion?: string;
  v8Version?: string;
  isPackaged?: boolean;
  totalMemory?: number;
  freeMemory?: number;
  heapUsed?: number;
  heapTotal?: number;
  rss?: number;
  panelCount?: number;
  panelKinds?: Record<string, number>;
  windowCount?: number;
  cpuCount?: number;
  gpuAccelerationDisabled?: boolean;
  processUptime?: number;
  recentActions?: ActionBreadcrumb[];
}

export interface PanelSummary {
  id: string;
  kind: string;
  title: string;
  cwd?: string;
  worktreeId?: string;
  location: "grid" | "dock";
  isSuspect: boolean;
  agentState?: string;
  lastStateChange?: number;
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
