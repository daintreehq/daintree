import type { PanelKind, PanelLocation, PanelTitleMode } from "../panel.js";
import type { AgentId } from "../agent.js";
import type { AgentState } from "../agent.js";
import type { BuiltInAgentId } from "../../config/agentIds.js";

/** Terminal spawn options */
export interface TerminalSpawnOptions {
  /** Optional custom ID for the terminal */
  id?: string;
  /** Terminal category (only "terminal" makes sense for PTY spawns) */
  kind?: PanelKind;
  /**
   * Launch hint — the agent this terminal is being launched to run. Used
   * only to key agent-specific settings (model, preset, flags, session
   * resume) and to derive the command to auto-inject. NOT an identity.
   * Absent for plain-shell launches. See
   * `docs/architecture/terminal-identity.md`.
   */
  launchAgentId?: AgentId;
  /** Project ID to associate with the terminal (captured at action time to avoid race conditions) */
  projectId?: string;
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
  /** Display title for the terminal */
  title?: string;
  /** How the title is owned. Absent defaults to "default". */
  titleMode?: PanelTitleMode;
  /** Command to execute after shell starts (e.g., 'claude' for AI agents) */
  command?: string;
  /** Whether to restore previous session content (default: true). Set to false on restart. */
  restore?: boolean;
  /** Whether to kill the PTY when the frontend disconnects (no terminal registry entry) */
  isEphemeral?: boolean;
  /** Process-level flags captured at launch time */
  agentLaunchFlags?: string[];
  /** Model ID selected at launch time */
  agentModelId?: string;
  /** Worktree the terminal is spawned in; persisted in agent session history */
  worktreeId?: string;
  /** Preset ID the agent is being launched with (needed for fallback chain lookup on exit). */
  agentPresetId?: string;
  /** Preset brand color captured at launch time. */
  agentPresetColor?: string;
  /** Original user-selected preset ID; unchanged across fallback hops. */
  originalAgentPresetId?: string;
}

/** Terminal state for app state persistence */
export interface TerminalState {
  /** Terminal ID */
  id: string;
  /** Terminal category */
  kind?: PanelKind;
  /**
   * Launch hint — the agent this terminal was launched to run. Persisted so
   * restart/crash-recovery can re-inject the right command. Not identity.
   * See `docs/architecture/terminal-identity.md`.
   */
  launchAgentId?: AgentId;
  /** Display title */
  title: string;
  /** How the title is owned. Absent defaults to "default". */
  titleMode?: PanelTitleMode;
  /** Current working directory (required for PTY panels, optional for non-PTY) */
  cwd?: string;
  /** Associated worktree ID */
  worktreeId?: string;
  /** Location in the UI - grid or dock */
  location?: PanelLocation;
  /** Command to execute after shell starts (e.g., 'claude' for AI agents) */
  command?: string;
  isInputLocked?: boolean;
  /** Current URL for browser/dev-preview panes */
  browserUrl?: string;
  /** Navigation history for browser/dev-preview panes */
  browserHistory?: import("../browser.js").BrowserHistory;
  /** Zoom factor for browser/dev-preview panes */
  browserZoom?: number;
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
  /** Whether the browser console drawer is open */
  browserConsoleOpen?: boolean;
  /** Whether the dev-preview console drawer is open */
  devPreviewConsoleOpen?: boolean;
  /** Behavior when terminal exits */
  exitBehavior?: import("../panel.js").PanelExitBehavior;
  /** Captured agent session ID from graceful shutdown */
  agentSessionId?: string;
  /** Process-level flags captured at launch time, persisted for session resume */
  agentLaunchFlags?: string[];
  /** Model ID selected at launch time for per-panel model selection */
  agentModelId?: string;
  /** Preset ID selected at launch time */
  agentPresetId?: string;
  /** Preset brand color captured at launch time */
  agentPresetColor?: string;
  /** Original user-selected preset ID; unchanged across fallback hops */
  originalPresetId?: string;
  /** Whether this panel is currently running on a fallback preset */
  isUsingFallback?: boolean;
  /** How many fallback hops have been consumed */
  fallbackChainIndex?: number;
  /**
   * Extension ID of the plugin that registered this panel's kind, if applicable.
   * Preserved across save/restore so the placeholder can name the missing plugin
   * when its registration is gone.
   */
  pluginId?: string;
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
  kind?: PanelKind;
  /** Launch hint — agent this terminal was launched to run. See `docs/architecture/terminal-identity.md`. */
  launchAgentId?: AgentId;
  title?: string;
  titleMode?: PanelTitleMode;
  cwd: string;
  agentState?: AgentState;
  lastStateChange?: number;
  spawnedAt: number;
  isTrashed?: boolean;
  trashExpiresAt?: number;
  /** Current activity tier: "active" (foreground) or "background" (project switched away) */
  activityTier?: "active" | "background";
  /** Whether this terminal has an active PTY process (false for orphaned terminals that exited) */
  hasPty?: boolean;
  /** Captured agent session ID from graceful shutdown */
  agentSessionId?: string;
  /** Process-level flags captured at launch time */
  agentLaunchFlags?: string[];
  /** Model ID selected at launch time */
  agentModelId?: string;
  /** Preset ID selected at launch time */
  agentPresetId?: string;
  /** Preset brand color captured at launch time */
  agentPresetColor?: string;
  /** Original user-selected preset ID; unchanged across fallback hops */
  originalAgentPresetId?: string;
  /**
   * Sticky live-session flag. True once runtime detection fires in this
   * session, even if no agent is currently detected. Not persisted;
   * rehydrated here on reconnect.
   */
  everDetectedAgent?: boolean;
  /**
   * Live detected identity — the agent currently running in this terminal.
   * The single source of truth for chrome. Not persisted; rehydrated here on
   * reconnect. See `docs/architecture/terminal-identity.md`.
   */
  detectedAgentId?: BuiltInAgentId;
  /** Runtime-detected non-agent process icon id (npm, yarn, etc.). Cleared when the process exits. */
  detectedProcessId?: string;
}

/** Result from terminal reconnect operation */
export interface TerminalReconnectResult {
  exists: boolean;
  id?: string;
  projectId?: string;
  kind?: PanelKind;
  /** Launch hint — agent this terminal was launched to run. See `docs/architecture/terminal-identity.md`. */
  launchAgentId?: AgentId;
  title?: string;
  titleMode?: PanelTitleMode;
  cwd?: string;
  agentState?: AgentState;
  lastStateChange?: number;
  spawnedAt?: number;
  activityTier?: "active" | "background";
  hasPty?: boolean;
  agentSessionId?: string;
  agentLaunchFlags?: string[];
  agentModelId?: string;
  agentPresetId?: string;
  agentPresetColor?: string;
  originalAgentPresetId?: string;
  /** Sticky live-session flag. Rehydrated on reconnect. */
  everDetectedAgent?: boolean;
  /** Live detected identity; the single chrome source of truth. See `docs/architecture/terminal-identity.md`. */
  detectedAgentId?: BuiltInAgentId;
  /** Runtime-detected non-agent process icon id (npm, yarn, etc.). Cleared when the process exits. */
  detectedProcessId?: string;
}

/**
 * Terminal information payload for diagnostic display.
 * Consumed exclusively by `TerminalInfoDialog.tsx`.
 */
export interface TerminalInfoPayload {
  id: string;
  projectId?: string;
  kind?: PanelKind;
  /** Launch hint — agent this terminal was launched to run. Not identity. */
  launchAgentId?: AgentId;
  title?: string;
  titleMode?: PanelTitleMode;
  cwd: string;
  shell?: string;
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
  /** Live detected identity — the agent currently running. Source of truth for chrome. */
  detectedAgentId?: BuiltInAgentId;
  /** Whether semantic analysis is enabled for this terminal */
  analysisEnabled?: boolean;
  /** Resize strategy: "default" (immediate) or "settled" (batched for TUI agents) */
  resizeStrategy?: "default" | "settled";
  /** PTY process PID */
  ptyPid?: number;
  /** PTY column count */
  ptyCols?: number;
  /** PTY row count */
  ptyRows?: number;
  /** Current foreground process name */
  ptyForegroundProcess?: string;
  /** TTY device path (e.g., /dev/ttys004) */
  ptyTty?: string;
  /** Resolved argv passed to pty.spawn() at launch time */
  spawnArgs?: string[];
  /** Process-level flags captured at launch time (agent terminals only) */
  agentLaunchFlags?: string[];
  /** Model ID selected at launch time (agent terminals only) */
  agentModelId?: string;
  /** Exit code when terminal has exited */
  exitCode?: number;
  /**
   * Sticky live-session flag. True once runtime detection fires in this
   * session, even if no agent is currently detected.
   */
  everDetectedAgent?: boolean;
}

import type { TerminalActivityPayload } from "../terminal.js";

/** Payload for terminal activity events */
export { TerminalActivityPayload };

/**
 * Snippet match returned by the semantic-buffer search.
 * `line` is ANSI-stripped; `matchStart`/`matchEnd` index into `line`.
 */
export interface SemanticSearchMatch {
  terminalId: string;
  line: string;
  matchStart: number;
  matchEnd: number;
}
