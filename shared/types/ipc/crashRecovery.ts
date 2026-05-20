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

/**
 * Best-effort attribution of why the previous session ended.
 *
 * - "uncaught-exception": JS uncaughtException fired and recordCrash wrote a crash log.
 * - "native-crash": Crashpad minidump newer than sessionStartMs was found in the dumps dir.
 * - "suspended-then-lost": Marker showed an in-flight suspend stamp at next launch.
 * - "power-loss": os.uptime() at next launch is shorter than wall-clock time since
 *   sessionStartMs, meaning the system rebooted. Reliable in the positive direction
 *   only — sleep pauses uptime, so the absence of this signal does not prove a reboot
 *   did not happen.
 * - "external-kill": Marker heartbeat is older than the staleness threshold while
 *   os.uptime() shows no reboot, indicating the process was killed without a chance
 *   to clean up (SIGKILL, OOM killer, force-quit).
 * - "unknown": None of the signals above fired.
 */
export type CrashCause =
  | "uncaught-exception"
  | "native-crash"
  | "suspended-then-lost"
  | "power-loss"
  | "external-kill"
  | "unknown";

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
  crashCause?: CrashCause;
  /**
   * Precise sub-classification for watchdog-driven kills. Complements
   * crashCause (which is heuristic-only): when the external watchdog
   * SIGKILLs main after missed heartbeats, it writes a sidecar flag and
   * this field is set on the entry. Absent = no watchdog signal.
   */
  cause?: "watchdog-deadlock";
  watchdogKilledAt?: number;
  watchdogMissedBeats?: number;
  watchdogMainPid?: number;
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

/**
 * Renderer-facing summary of a panel that the suspect ledger is currently
 * quarantining — i.e., the panel was flagged `isSuspect` on enough consecutive
 * crashed boots to cross the quarantine threshold. Skipped from restore in
 * safe mode and surfaced in `SafeModeBanner` with a "Restore panel" affordance.
 */
export interface QuarantinedPanelSummary {
  id: string;
  kind: string;
  title: string;
  cwd?: string;
  worktreeId?: string;
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
