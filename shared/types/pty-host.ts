/**
 * Message protocol types for Pty Host IPC communication.
 *
 * This module defines the message format for communication between
 * the Main process (PtyClient) and the Pty Host (UtilityProcess).
 *
 * All types are serializable (no functions, no circular refs) for IPC transport.
 */

import type {
  AgentState,
  AgentId,
  TerminalType,
  TerminalKind,
  TerminalFlowStatus,
} from "./domain.js";

export type { TerminalFlowStatus };

/** Options for spawning a new PTY process (matches PtyManager interface) */
export interface PtyHostSpawnOptions {
  cwd: string;
  shell?: string;
  args?: string[];
  env?: Record<string, string>;
  cols: number;
  rows: number;
  kind?: TerminalKind;
  type?: TerminalType;
  agentId?: AgentId;
  title?: string;
  worktreeId?: string;
  projectId?: string;
  /** Whether to restore previous session content (default: true). Set to false on restart. */
  restore?: boolean;
}

/**
 * Requests sent from Main → Host.
 * Each request is a discriminated union type for compile-time safety.
 */
export type PtyHostRequest =
  | { type: "spawn"; id: string; options: PtyHostSpawnOptions }
  | { type: "resize"; id: string; cols: number; rows: number }
  | { type: "write"; id: string; data: string; traceId?: string }
  | { type: "submit"; id: string; text: string }
  | { type: "kill"; id: string; reason?: string }
  | { type: "trash"; id: string }
  | { type: "restore"; id: string }
  | { type: "set-activity-tier"; id: string; tier: PtyHostActivityTier }
  | { type: "wake-terminal"; id: string; requestId: string }
  | { type: "set-active-project"; projectId: string | null }
  | { type: "project-switch"; projectId: string }
  | { type: "kill-by-project"; projectId: string; requestId: string }
  | { type: "get-project-stats"; projectId: string; requestId: string }
  | { type: "get-snapshot"; id: string; requestId: string }
  | { type: "get-all-snapshots"; requestId: string }
  | { type: "mark-checked"; id: string }
  | {
      type: "transition-state";
      id: string;
      requestId: string;
      event: { type: string; [key: string]: unknown };
      trigger: string;
      confidence: number;
      spawnedAt?: number;
    }
  | { type: "health-check" }
  | { type: "pause-all" }
  | { type: "resume-all" }
  | { type: "dispose" }
  | { type: "get-terminals-for-project"; projectId: string; requestId: string }
  | { type: "get-terminal"; id: string; requestId: string }
  | { type: "replay-history"; id: string; maxLines: number; requestId: string }
  | { type: "get-serialized-state"; id: string; requestId: string }
  | {
      type: "init-buffers";
      visualBuffers: SharedArrayBuffer[];
      analysisBuffer: SharedArrayBuffer;
      visualSignalBuffer: SharedArrayBuffer;
    }
  | { type: "connect-port" }
  | { type: "get-terminal-info"; id: string; requestId: string }
  | { type: "force-resume"; id: string }
  | { type: "acknowledge-data"; id: string; charCount: number }
  | { type: "set-analysis-enabled"; id: string; enabled: boolean }
  | { type: "get-available-terminals"; requestId: string }
  | { type: "get-terminals-by-state"; state: AgentState; requestId: string }
  | { type: "get-all-terminals"; requestId: string };

/**
 * Terminal snapshot data sent from Host → Main for state queries.
 */
export interface PtyHostTerminalSnapshot {
  id: string;
  lines: string[];
  lastInputTime: number;
  lastOutputTime: number;
  lastCheckTime: number;
  kind?: TerminalKind;
  type?: TerminalType;
  worktreeId?: string;
  agentId?: AgentId;
  agentState?: AgentState;
  lastStateChange?: number;
  error?: string;
  spawnedAt: number;
}

/**
 * Events sent from Host → Main.
 * Forward processed events back to Main process.
 */
export type PtyHostEvent =
  | { type: "data"; id: string; data: string }
  | { type: "exit"; id: string; exitCode: number }
  | { type: "error"; id: string; error: string }
  | { type: "spawn-result"; id: string; result: SpawnResult }
  | {
      type: "wake-result";
      requestId: string;
      id: string;
      state: string | null;
      warnings?: string[];
    }
  | { type: "kill-by-project-result"; requestId: string; killed: number }
  | {
      type: "project-stats";
      requestId: string;
      stats: { terminalCount: number; processIds: number[]; terminalTypes: Record<string, number> };
    }
  | {
      type: "agent-state";
      id: string;
      agentId?: AgentId;
      state: AgentState;
      previousState: AgentState;
      timestamp: number;
      traceId?: string;
      trigger: string;
      confidence: number;
      worktreeId?: string;
    }
  | {
      type: "agent-detected";
      terminalId: string;
      agentType: string;
      processName: string;
      timestamp: number;
    }
  | {
      type: "agent-exited";
      terminalId: string;
      agentType: string;
      timestamp: number;
    }
  | { type: "agent-spawned"; payload: AgentSpawnedPayload }
  | { type: "agent-output"; payload: AgentOutputPayload }
  | { type: "agent-completed"; payload: AgentCompletedPayload }
  | { type: "agent-failed"; payload: AgentFailedPayload }
  | { type: "agent-killed"; payload: AgentKilledPayload }
  | { type: "terminal-trashed"; id: string; expiresAt: number }
  | { type: "terminal-restored"; id: string }
  | { type: "terminal-pid"; id: string; pid: number }
  | { type: "snapshot"; id: string; requestId: string; snapshot: PtyHostTerminalSnapshot | null }
  | { type: "all-snapshots"; requestId: string; snapshots: PtyHostTerminalSnapshot[] }
  | { type: "transition-result"; id: string; requestId: string; success: boolean }
  | { type: "pong" }
  | { type: "ready" }
  | { type: "terminals-for-project"; requestId: string; terminalIds: string[] }
  | { type: "terminal-info"; requestId: string; terminal: PtyHostTerminalInfo | null }
  | { type: "replay-history-result"; requestId: string; replayed: number }
  | { type: "serialized-state"; requestId: string; id: string; state: string | null }
  | { type: "terminal-diagnostic-info"; requestId: string; info: any }
  | { type: "available-terminals"; requestId: string; terminals: PtyHostTerminalInfo[] }
  | { type: "terminals-by-state"; requestId: string; terminals: PtyHostTerminalInfo[] }
  | { type: "all-terminals"; requestId: string; terminals: PtyHostTerminalInfo[] }
  | {
      type: "terminal-status";
      id: string;
      status: TerminalFlowStatus;
      bufferUtilization?: number;
      pauseDuration?: number;
      timestamp: number;
    }
  | {
      type: "host-throttled";
      isThrottled: boolean;
      reason?: string;
      duration?: number;
      timestamp: number;
    }
  | {
      type: "terminal-reliability-metric";
      payload: TerminalReliabilityMetricPayload;
    };

/** Terminal info sent from Host → Main for getTerminal queries */
export interface PtyHostTerminalInfo {
  id: string;
  projectId?: string;
  kind?: TerminalKind;
  type?: TerminalType;
  agentId?: AgentId;
  title?: string;
  cwd: string;
  worktreeId?: string;
  agentState?: AgentState;
  lastStateChange?: number;
  spawnedAt: number;
  isTrashed?: boolean;
  trashExpiresAt?: number;
  /** Current activity tier: "active" (foreground) or "background" (project switched away) */
  activityTier?: "active" | "background";
  /** Whether this terminal has an active PTY process (false for orphaned terminals that exited) */
  hasPty?: boolean;
}

/** Payload for agent:spawned event */
export interface AgentSpawnedPayload {
  agentId: string;
  terminalId: string;
  type: TerminalType;
  worktreeId?: string;
  timestamp: number;
}

/** Payload for agent:output event */
export interface AgentOutputPayload {
  agentId: string;
  data: string;
  timestamp: number;
  traceId?: string;
  terminalId?: string;
  worktreeId?: string;
}

/** Payload for agent:completed event */
export interface AgentCompletedPayload {
  agentId: string;
  exitCode: number;
  duration: number;
  timestamp: number;
  traceId?: string;
  terminalId?: string;
  worktreeId?: string;
}

/** Payload for agent:failed event */
export interface AgentFailedPayload {
  agentId: string;
  error: string;
  timestamp: number;
  traceId?: string;
  terminalId?: string;
  worktreeId?: string;
}

/** Payload for agent:killed event */
export interface AgentKilledPayload {
  agentId: string;
  reason?: string;
  timestamp: number;
  traceId?: string;
  terminalId?: string;
  worktreeId?: string;
}

/**
 * Terminal activity tier (streaming policy).
 *
 * Controls backend streaming behavior and resource allocation:
 * - `active`: Full visual streaming to SAB/IPC (50ms ActivityMonitor polling)
 * - `background`: Visual streaming suppressed, wake snapshots only (500ms polling)
 *                 Analysis buffer writes continue for agent state detection
 *
 * Maps from renderer TerminalRefreshTier:
 * - BURST/FOCUSED → active
 * - VISIBLE → active (for now, may become background in future)
 * - BACKGROUND → background
 */
export type PtyHostActivityTier = "active" | "background";

/** Error codes for spawn failures */
export type SpawnErrorCode =
  | "ENOENT" // Shell or command not found
  | "EACCES" // Permission denied
  | "ENOTDIR" // Working directory does not exist (or path component is not a directory)
  | "EIO" // I/O error (e.g., PTY allocation failure)
  | "DISCONNECTED" // Terminal process no longer exists in backend (e.g., after project switch)
  | "UNKNOWN"; // Unknown error

/** Result of a spawn operation */
export interface SpawnResult {
  success: boolean;
  id: string;
  error?: SpawnError;
}

/** Details of a spawn error */
export interface SpawnError {
  code: SpawnErrorCode;
  message: string;
  errno?: number;
  syscall?: string;
  path?: string;
}

/** Crash type classification based on exit codes */
export type CrashType =
  | "OUT_OF_MEMORY"
  | "ASSERTION_FAILURE"
  | "SIGNAL_TERMINATED"
  | "UNKNOWN_CRASH"
  | "CLEAN_EXIT";

/** Payload for terminal status events (flow control) */
export interface TerminalStatusPayload {
  id: string;
  status: TerminalFlowStatus;
  bufferUtilization?: number;
  pauseDuration?: number;
  timestamp: number;
}

/** Payload for host crash events */
export interface HostCrashPayload {
  code: number | null;
  signal: string | null;
  crashType: CrashType;
  timestamp: number;
}

/** Payload for host throttle events (memory pressure) */
export interface HostThrottlePayload {
  isThrottled: boolean;
  reason?: string;
  duration?: number;
  timestamp: number;
}

/** Payload for terminal reliability metrics (backpressure/suspend/wake) */
export interface TerminalReliabilityMetricPayload {
  terminalId: string;
  metricType: "pause-start" | "pause-end" | "suspend" | "wake-latency";
  timestamp: number;
  durationMs?: number;
  bufferUtilization?: number;
  shardIndex?: number;
  serializedStateBytes?: number;
  wakeLatencyMs?: number;
}

/**
 * Messages sent from Renderer → Pty Host via MessagePort (direct channel).
 * These bypass the Main process for low-latency terminal input.
 */
export type RendererToPtyHostMessage =
  | { type: "write"; id: string; data: string; traceId?: string }
  | { type: "resize"; id: string; cols: number; rows: number };
