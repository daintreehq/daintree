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
  /** Whether to restore previous session content (default: true). Set to false on restart. */
  restore?: boolean;
  /** Whether to kill the PTY when the frontend disconnects (no terminal registry entry) */
  isEphemeral?: boolean;
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
  /** Current working directory (required for PTY panels, optional for non-PTY) */
  cwd?: string;
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
  isInputLocked?: boolean;
  /** Current URL for browser/dev-preview panes */
  browserUrl?: string;
  /** Navigation history for browser/dev-preview panes */
  browserHistory?: import("../domain.js").BrowserHistory;
  /** Zoom factor for browser/dev-preview panes */
  browserZoom?: number;
  /** Path to note file (kind === 'notes') */
  notePath?: string;
  /** Note ID (kind === 'notes') */
  noteId?: string;
  /** Note scope (kind === 'notes') */
  scope?: "worktree" | "project";
  /** Note creation timestamp (kind === 'notes') */
  createdAt?: number;
  /** Dev command override for dev-preview panels */
  devCommand?: string;
  /** Dev server status for dev-preview panels */
  devServerStatus?: "stopped" | "starting" | "installing" | "running" | "error";
  /** Dev server URL for dev-preview panels */
  devServerUrl?: string;
  /** Dev server error for dev-preview panels */
  devServerError?: { type: string; message: string };
  /** Terminal ID associated with dev server for dev-preview panels */
  devServerTerminalId?: string;
  /** Whether the dev-preview console drawer is open */
  devPreviewConsoleOpen?: boolean;
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

/** Result from terminal reconnect operation */
export interface TerminalReconnectResult {
  exists: boolean;
  id?: string;
  projectId?: string;
  kind?: TerminalKind;
  type?: TerminalType;
  agentId?: AgentId;
  title?: string;
  cwd?: string;
  worktreeId?: string;
  agentState?: AgentState;
  lastStateChange?: number;
  spawnedAt?: number;
  activityTier?: "active" | "background";
  hasPty?: boolean;
  error?: string;
}

/** Terminal information payload for diagnostic display */
export interface TerminalInfoPayload {
  id: string;
  projectId?: string;
  kind?: TerminalKind;
  type?: TerminalType;
  agentId?: AgentId;
  title?: string;
  cwd: string;
  shell?: string;
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
  /** Whether this terminal has an active PTY process (false for orphaned terminals that exited) */
  hasPty?: boolean;
  /** Whether this terminal is classified as an agent terminal */
  isAgentTerminal?: boolean;
  /** Runtime-detected agent type (from process tree analysis) */
  detectedAgentType?: TerminalType;
  /** Whether semantic analysis is enabled for this terminal */
  analysisEnabled?: boolean;
  /** Resize strategy: "default" (immediate) or "settled" (batched for TUI agents) */
  resizeStrategy?: "default" | "settled";
  /** DEC 2026 sync buffer state (null if not enabled) */
  syncBuffer?: {
    enabled: boolean;
    /** Whether sync buffer is bypassed (alt screen active) */
    bypassed: boolean;
    /** Whether currently inside a DEC 2026 synchronized update */
    inSyncMode: boolean;
    /** Total frames emitted through the sync buffer */
    framesEmitted: number;
  } | null;
}

import type { TerminalActivityPayload } from "../terminal.js";

/** Payload for terminal activity events */
export { TerminalActivityPayload };
