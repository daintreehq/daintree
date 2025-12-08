/**
 * Message protocol types for Pty Host IPC communication.
 *
 * This module defines the message format for communication between
 * the Main process (PtyClient) and the Pty Host (UtilityProcess).
 *
 * All types are serializable (no functions, no circular refs) for IPC transport.
 */

import type { AgentState, TerminalType } from "./domain.js";

/** Activity tier for IPC batching (determines flush timing) */
export type ActivityTier = "focused" | "visible" | "background";

/** Options for spawning a new PTY process (matches PtyManager interface) */
export interface PtyHostSpawnOptions {
  cwd: string;
  shell?: string;
  args?: string[];
  env?: Record<string, string>;
  cols: number;
  rows: number;
  type?: TerminalType;
  title?: string;
  worktreeId?: string;
  projectId?: string;
}

/**
 * Requests sent from Main → Host.
 * Each request is a discriminated union type for compile-time safety.
 */
export type PtyHostRequest =
  | { type: "spawn"; id: string; options: PtyHostSpawnOptions }
  | { type: "resize"; id: string; cols: number; rows: number }
  | { type: "write"; id: string; data: string; traceId?: string }
  | { type: "kill"; id: string; reason?: string }
  | { type: "trash"; id: string }
  | { type: "restore"; id: string }
  | { type: "set-buffering"; id: string; enabled: boolean }
  | { type: "flush-buffer"; id: string }
  | { type: "set-activity-tier"; id: string; tier: ActivityTier }
  | { type: "get-snapshot"; id: string }
  | { type: "get-all-snapshots" }
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
  | { type: "init-buffers"; visualBuffer: SharedArrayBuffer; analysisBuffer: SharedArrayBuffer }
  | { type: "connect-port" }
  | { type: "get-terminal-info"; id: string; requestId: string };

/**
 * Terminal snapshot data sent from Host → Main for state queries.
 */
export interface PtyHostTerminalSnapshot {
  id: string;
  lines: string[];
  lastInputTime: number;
  lastOutputTime: number;
  lastCheckTime: number;
  type?: TerminalType;
  worktreeId?: string;
  agentId?: string;
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
  | {
      type: "agent-state";
      id: string;
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
  | { type: "snapshot"; id: string; snapshot: PtyHostTerminalSnapshot | null }
  | { type: "all-snapshots"; snapshots: PtyHostTerminalSnapshot[] }
  | { type: "transition-result"; id: string; requestId: string; success: boolean }
  | { type: "pong" }
  | { type: "ready" }
  | { type: "terminals-for-project"; requestId: string; terminalIds: string[] }
  | { type: "terminal-info"; requestId: string; terminal: PtyHostTerminalInfo | null }
  | { type: "replay-history-result"; requestId: string; replayed: number }
  | { type: "serialized-state"; requestId: string; id: string; state: string | null }
  | { type: "terminal-diagnostic-info"; requestId: string; info: any };

/** Terminal info sent from Host → Main for getTerminal queries */
export interface PtyHostTerminalInfo {
  id: string;
  projectId?: string;
  type?: TerminalType;
  title?: string;
  cwd: string;
  worktreeId?: string;
  agentState?: AgentState;
  spawnedAt: number;
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
 * Messages sent from Renderer → Pty Host via MessagePort (direct channel).
 * These bypass the Main process for low-latency terminal input.
 */
export type RendererToPtyHostMessage =
  | { type: "write"; id: string; data: string; traceId?: string }
  | { type: "resize"; id: string; cols: number; rows: number };
