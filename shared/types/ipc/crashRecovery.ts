import type { ActionDanger } from "../actions.js";

export type ActionBreadcrumbSource = "user" | "keybinding" | "menu" | "agent" | "context-menu";

export interface ActionBreadcrumb {
  id: string;
  actionId: string;
  category: string;
  source: ActionBreadcrumbSource;
  danger: ActionDanger;
  durationMs: number;
  timestamp: number;
  args?: Record<string, unknown>;
  count: number;
  /** True when an agent explicitly confirmed a danger:"confirm" action. Absent for user-source and safe actions. */
  confirmed?: boolean;
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
  createdAt?: number;
  agentState?: string;
  lastStateChange?: number;
}

export interface PendingCrash {
  logPath: string;
  entry: CrashLogEntry;
  hasBackup: boolean;
  backupTimestamp?: number;
  panels?: PanelSummary[];
  crashCount?: number;
}

export interface CrashRecoveryConfig {
  autoRestoreOnCrash: boolean;
}

export type CrashRecoveryAction = { kind: "restore"; panelIds: string[] } | { kind: "fresh" };
