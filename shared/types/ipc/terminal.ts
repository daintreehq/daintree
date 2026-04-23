import type { TerminalType, PanelKind, PanelLocation } from "../panel.js";
import type { AgentId } from "../agent.js";
import type { AgentState } from "../agent.js";
import type { BuiltInAgentId } from "../../config/agentIds.js";

/** Terminal spawn options */
export interface TerminalSpawnOptions {
  /** Optional custom ID for the terminal */
  id?: string;
  /** Terminal category */
  kind?: PanelKind;
  /**
   * Launch intent — the agent identity this terminal will be spawned as.
   * Sealed for the lifetime of the terminal. See
   * `docs/architecture/terminal-identity.md` for the full contract.
   */
  agentId?: AgentId;
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
  /**
   * @deprecated Legacy terminal classification. See
   * `docs/architecture/terminal-identity.md`. Prefer `agentId` for launch
   * intent, `capabilityAgentId` for capability mode.
   */
  type?: TerminalType;
  /** Display title for the terminal */
  title?: string;
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
  /** Original user-selected preset ID; unchanged across fallback hops. */
  originalAgentPresetId?: string;
  /**
   * Capability mode override for this spawn request. Currently expected to
   * follow `agentId`; reserved for future consumers.
   *
   * NOTE: This field is intentionally NOT present in `TerminalSpawnOptionsSchema`
   * (the Zod validation schema at `electron/schemas/ipc.ts`) and is not
   * consumed by the spawn IPC handler. See
   * `docs/architecture/terminal-identity.md`.
   */
  capabilityAgentId?: BuiltInAgentId;
}

/** Terminal state for app state persistence */
export interface TerminalState {
  /** Terminal ID */
  id: string;
  /** Terminal category */
  kind?: PanelKind;
  /**
   * @deprecated Legacy terminal classification retained for persisted-state
   * compatibility. See `docs/architecture/terminal-identity.md`. New code
   * should rely on `agentId` (launch intent).
   */
  type?: TerminalType;
  /**
   * Launch intent — the agent identity this terminal was spawned as. Persisted
   * so crash recovery respawns the terminal as the same agent. See
   * `docs/architecture/terminal-identity.md`.
   */
  agentId?: AgentId;
  /** Display title */
  title: string;
  /** Current working directory (required for PTY panels, optional for non-PTY) */
  cwd?: string;
  /** Associated worktree ID */
  worktreeId?: string;
  /** Location in the UI - grid or dock */
  location?: PanelLocation;
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
  /**
   * @deprecated Legacy terminal classification. See
   * `docs/architecture/terminal-identity.md`. Prefer `agentId` (launch intent),
   * `detectedAgentId` (live detection), or `capabilityAgentId` (capability mode).
   */
  type?: TerminalType;
  /**
   * Launch intent — the agent identity this terminal was spawned as. Sealed
   * at spawn time. See `docs/architecture/terminal-identity.md`.
   */
  agentId?: AgentId;
  title?: string;
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
  /**
   * Sticky live-session flag. True once runtime detection fires in this session,
   * even if no agent is currently detected. Not persisted; rehydrated here on
   * reconnect. See `docs/architecture/terminal-identity.md`.
   */
  everDetectedAgent?: boolean;
  /**
   * Live detected identity — the agent currently running in this terminal as
   * identified by the backend process detector. Cleared when the detected
   * agent exits. Not persisted; rehydrated here on reconnect. See
   * `docs/architecture/terminal-identity.md`.
   */
  detectedAgentId?: BuiltInAgentId;
  /**
   * Capability mode — sealed-at-spawn agent capability surface. Set when the
   * terminal was cold-launched as a built-in agent. See
   * `docs/architecture/terminal-identity.md`.
   */
  capabilityAgentId?: BuiltInAgentId;
  /** Runtime-detected non-agent process icon id (npm, yarn, etc.). Cleared when the process exits. */
  detectedProcessId?: string;
}

/** Result from terminal reconnect operation */
export interface TerminalReconnectResult {
  exists: boolean;
  id?: string;
  projectId?: string;
  kind?: PanelKind;
  /**
   * @deprecated Legacy terminal classification. See
   * `docs/architecture/terminal-identity.md`. Prefer `agentId` (launch intent),
   * `detectedAgentId` (live detection), or `capabilityAgentId` (capability mode).
   */
  type?: TerminalType;
  /**
   * Launch intent — the agent identity this terminal was spawned as. Sealed
   * at spawn time. See `docs/architecture/terminal-identity.md`.
   */
  agentId?: AgentId;
  title?: string;
  cwd?: string;
  agentState?: AgentState;
  lastStateChange?: number;
  spawnedAt?: number;
  activityTier?: "active" | "background";
  hasPty?: boolean;
  agentSessionId?: string;
  agentLaunchFlags?: string[];
  agentModelId?: string;
  /**
   * Sticky live-session flag. True once runtime detection fired in this
   * session, even if no agent is currently detected. Rehydrated on reconnect.
   * See `docs/architecture/terminal-identity.md`.
   */
  everDetectedAgent?: boolean;
  /**
   * Live detected identity — the agent currently running in this terminal
   * as identified by the backend process detector. Cleared when the detected
   * agent exits. See `docs/architecture/terminal-identity.md`.
   */
  detectedAgentId?: BuiltInAgentId;
  /**
   * Capability mode — sealed-at-spawn agent capability surface. Carried on
   * reconnect so the renderer can re-derive session-capability gates without
   * waiting for a fresh snapshot. See
   * `docs/architecture/terminal-identity.md`.
   */
  capabilityAgentId?: BuiltInAgentId;
  /** Runtime-detected non-agent process icon id (npm, yarn, etc.). Cleared when the process exits. */
  detectedProcessId?: string;
}

/**
 * Terminal information payload for diagnostic display.
 *
 * Consumed exclusively by `TerminalInfoDialog.tsx`. Intentionally omits
 * `capabilityAgentId` — capability mode is sealed-at-spawn from `agentId`
 * (narrowed to `BuiltInAgentId`), so the dialog does not need to render it
 * separately. Diagnostic readers that need the value should consume it via
 * `BackendTerminalInfo` / `TerminalReconnectResult`.
 * See `docs/architecture/terminal-identity.md`.
 */
export interface TerminalInfoPayload {
  id: string;
  projectId?: string;
  kind?: PanelKind;
  /**
   * @deprecated Legacy terminal classification. See
   * `docs/architecture/terminal-identity.md`. Prefer `agentId` (launch intent)
   * or `detectedAgentId` (live detection).
   */
  type?: TerminalType;
  /**
   * Launch intent — the agent identity this terminal was spawned as. Sealed
   * at spawn time. See `docs/architecture/terminal-identity.md`.
   */
  agentId?: AgentId;
  title?: string;
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
  /** Whether this terminal is classified as an agent terminal */
  isAgentTerminal?: boolean;
  /**
   * Live detected identity — internal PTY-side alias for the agent currently
   * running in this terminal. Equivalent to `detectedAgentId`; retained here
   * for diagnostic display of the PTY-side name. See
   * `docs/architecture/terminal-identity.md`.
   */
  detectedAgentType?: TerminalType;
  /**
   * Live detected identity — the agent currently running in this terminal as
   * identified by the backend process detector. Cleared when the detected
   * agent exits. See `docs/architecture/terminal-identity.md`.
   */
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
   * session, even if no agent is currently detected. Not persisted; not
   * launch intent; not capability mode. See
   * `docs/architecture/terminal-identity.md`.
   */
  everDetectedAgent?: boolean;
}

import type { TerminalActivityPayload } from "../terminal.js";

/** Payload for terminal activity events */
export { TerminalActivityPayload };
