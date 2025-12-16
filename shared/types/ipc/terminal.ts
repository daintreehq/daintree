import type { TerminalType, TerminalKind, AgentId, TerminalLocation } from "../domain.js";
import type { AgentState } from "../domain.js";

/** Terminal spawn options */
export interface TerminalSpawnOptions {
  /** Optional custom ID for the terminal */
  id?: string;
  /** Terminal category */
  kind?: TerminalKind;
  /** Agent ID when kind is 'agent' */
  agentId?: AgentId;
  /** Working directory for the terminal */
  cwd?: string;
  /** Shell executable to use (defaults to user's shell) */
  shell?: string;
  /** Environment variables to set */
  env?: Record<string, string>;
  /** Initial number of columns */
  cols: number;
  /** Initial number of rows */
  rows: number;
  /** Legacy type of terminal */
  type?: TerminalType;
  /** Display title for the terminal */
  title?: string;
  /** Associated worktree ID */
  worktreeId?: string;
  /** Command to execute after shell starts (e.g., 'claude' for AI agents) */
  command?: string;
}

/** Terminal state for app state persistence */
export interface TerminalState {
  /** Terminal ID */
  id: string;
  /** Terminal category */
  kind?: TerminalKind;
  /** Legacy terminal type for persisted state */
  type?: TerminalType;
  /** Agent ID when kind is an agent - enables extensibility */
  agentId?: AgentId;
  /** Display title */
  title: string;
  /** Current working directory */
  cwd: string;
  /** Associated worktree ID */
  worktreeId?: string;
  /** Location in the UI - grid or dock */
  location?: TerminalLocation;
  /** Command to execute after shell starts (e.g., 'claude' for AI agents) */
  command?: string;
  /** Last detected agent type (for restoration hints) */
  lastDetectedAgent?: TerminalType;
  /** Last detected agent title (for restoration hints) */
  lastDetectedAgentTitle?: string;
  /** Whether user input is locked (read-only monitor mode) */
  isInputLocked?: boolean;
}

/** Terminal data payload for IPC */
export interface TerminalDataPayload {
  id: string;
  data: string;
}

/** Terminal resize payload for IPC */
export interface TerminalResizePayload {
  id: string;
  cols: number;
  rows: number;
}

/** Terminal kill payload for IPC */
export interface TerminalKillPayload {
  id: string;
}

/** Terminal exit payload for IPC */
export interface TerminalExitPayload {
  id: string;
  exitCode: number;
}

/** Terminal error payload for IPC */
export interface TerminalErrorPayload {
  id: string;
  error: string;
}

/** Terminal info from backend for reconnection */
export interface BackendTerminalInfo {
  id: string;
  projectId?: string;
  kind?: TerminalKind;
  type?: TerminalType;
  title?: string;
  cwd: string;
  worktreeId?: string;
  agentState?: string;
  spawnedAt: number;
}

/** Result from terminal reconnect operation */
export interface TerminalReconnectResult {
  exists: boolean;
  id?: string;
  kind?: TerminalKind;
  type?: TerminalType;
  cwd?: string;
  agentState?: string;
  error?: string;
}

/** Terminal information payload for diagnostic display */
export interface TerminalInfoPayload {
  id: string;
  projectId?: string;
  kind?: TerminalKind;
  type?: TerminalType;
  title?: string;
  cwd: string;
  worktreeId?: string;
  agentState?: AgentState;
  spawnedAt: number;
  lastInputTime: number;
  lastOutputTime: number;
  lastStateChange?: number;
  activityTier: "focused" | "visible" | "background";
  outputBufferSize: number;
  semanticBufferLines: number;
  restartCount: number;
}

import type { TerminalActivityPayload } from "../terminal.js";

/** Payload for terminal activity events */
export { TerminalActivityPayload };
