import type { AgentState, AgentStateChangeTrigger, AgentId, WaitingReason } from "./agent.js";
import type { BuiltInAgentId } from "../config/agentIds.js";
import type { BrowserHistory } from "./browser.js";

/** Built-in panel kinds */
export type BuiltInPanelKind = "terminal" | "browser" | "dev-preview";

/**
 * Panel kind: distinguishes between terminals, browser panels, and
 * extension-provided panel types. Agent-ness is a dynamic state of a terminal,
 * NOT a distinct panel kind — see `docs/architecture/terminal-identity.md`.
 *
 * Built-in kinds: "terminal" | "browser" | "dev-preview"
 * Extensions can register additional kinds as strings.
 */
export type PanelKind = BuiltInPanelKind | (string & {});

/** Location of a panel instance in the UI */
export type PanelLocation = "grid" | "dock" | "trash" | "background";

/** Tab group location (subset of PanelLocation, excludes trash) */
export type TabGroupLocation = "grid" | "dock";

/**
 * Tab group - a collection of panels displayed as tabs
 *
 * INVARIANT: All panels in a group must have the same worktreeId as the group.
 * Cross-worktree groups are not permitted.
 */
export interface TabGroup {
  /** Unique identifier for this tab group */
  id: string;
  /** Location of the tab group in the UI */
  location: TabGroupLocation;
  /** Worktree this tab group is associated with (undefined for global) */
  worktreeId?: string;
  /** ID of the currently active/visible panel in this group */
  activeTabId: string;
  /** Ordered list of panel IDs in this group (sorted by orderInGroup) */
  panelIds: string[];
}

/** Dock display mode - always expanded (kept as literal type for compatibility) */
export type DockMode = "expanded";

/**
 * Centralized dock render state - computed once and consumed by all dock components.
 * Prevents desync between components computing derived visibility independently.
 */
export interface DockRenderState {
  /** The effective dock mode (always "expanded") */
  effectiveMode: DockMode;
  /** Whether the dock content should render in the layout (takes up space) - true after hydration */
  shouldShowInLayout: boolean;
  /** Density for ContentDock components (always "normal") */
  density: "normal";
  /** Whether hydration is complete */
  isHydrated: boolean;
}

/** Type guard to check if a panel kind is a built-in kind */
export function isBuiltInPanelKind(kind: PanelKind): kind is BuiltInPanelKind {
  return kind === "terminal" || kind === "browser" || kind === "dev-preview";
}

/**
 * Check if a built-in panel kind requires PTY.
 * For extension kinds, use `panelKindHasPty()` from panelKindRegistry
 * which consults the runtime registry configuration.
 * Note: dev-preview panels manage their own ephemeral PTYs via useDevServer hook,
 * so they are not considered registry-owned PTY panels.
 */
export function isPtyPanelKind(kind: PanelKind): boolean {
  // Built-in kinds - for extension kinds, use panelKindHasPty() from registry
  return kind === "terminal";
}

/**
 * Renderer refresh rate tiers for terminal UI updates.
 *
 * Maps to backend PtyHostActivityTier:
 * - BURST/FOCUSED/VISIBLE → backend "active" (full visual streaming, 50ms polling)
 * - BACKGROUND → backend "background" (visual streaming suppressed, 500ms polling)
 *                Analysis buffer writes continue for agent state detection
 */
export enum TerminalRefreshTier {
  BURST = 16, // 60fps - only during active typing
  FOCUSED = 100, // 10fps - focused but idle
  VISIBLE = 200, // 5fps
  BACKGROUND = 1000, // 1fps
}

/** Flow-control states emitted by the PTY host */
export type TerminalFlowStatus = "running" | "paused-backpressure" | "paused-user" | "suspended";

/** Runtime lifecycle status for terminals (visibility + flow + exit/error) */
export type TerminalRuntimeStatus = TerminalFlowStatus | "background" | "exited" | "error";

/** Origin that spawned a terminal */
export type TerminalSpawnSource = "quickrun" | "recipe" | "agent" | "palette";

/**
 * Live process identity detected inside a PTY. This is transient runtime state,
 * not a launch hint and not persisted.
 */
export interface TerminalRuntimeIdentity {
  kind: "agent" | "process";
  /** Stable runtime identity id: agent id for agents, process icon id for processes. */
  id: string;
  /** Icon registry id used by terminal chrome. */
  iconId: string;
  /** Present only when the live process is an agent. */
  agentId?: AgentId;
  /** Present when the detector emitted a process icon id. */
  processId?: string;
}

/**
 * How a panel's title is currently owned.
 *
 * - `"default"` — title is derived from live runtime identity and is free to
 *   flip as detection promotes/demotes.
 * - `"custom"` — the user renamed this panel; title is frozen and must not be
 *   overwritten by detection events.
 *
 * Absent defaults to `"default"` for hydration compatibility.
 */
export type PanelTitleMode = "default" | "custom";

/** Structured error state for terminal restart failures */
export interface TerminalRestartError {
  /** Human-readable error message */
  message: string;
  /** Error code (e.g., ENOENT, EPERM, EACCES) */
  code?: string;
  /** Timestamp when error occurred (milliseconds since epoch) */
  timestamp: number;
  /** Whether this error can be fixed by user action (e.g., changing CWD) */
  recoverable: boolean;
  /** Additional context for debugging */
  context?: {
    /** The CWD that failed */
    failedCwd?: string;
    /** The command that failed */
    command?: string;
    /** Any additional metadata */
    [key: string]: unknown;
  };
}

/** Structured error state for terminal reconnection failures during project switch */
export interface TerminalReconnectError {
  /** Human-readable error message */
  message: string;
  /** Error type: timeout, not_found, or other */
  type: "timeout" | "not_found" | "error";
  /** Timestamp when error occurred (milliseconds since epoch) */
  timestamp: number;
  /** Additional context for debugging */
  context?: {
    /** The terminal ID that failed to reconnect */
    terminalId?: string;
    /** Timeout duration in ms (for timeout errors) */
    timeoutMs?: number;
    /** Any additional metadata */
    [key: string]: unknown;
  };
}

/** Exit behavior for panels/terminals after process exits */
export type PanelExitBehavior = "keep" | "trash" | "remove" | "restart";

interface BasePanelData {
  /** Unique identifier for this panel */
  id: string;
  /** Panel category */
  kind: PanelKind;
  /** Display title for the panel tab */
  title: string;
  /** How the title is owned. Absent = "default". */
  titleMode?: PanelTitleMode;
  /** Location in the UI - grid (main view) or dock (minimized) */
  location: PanelLocation;
  /** ID of the worktree this panel is associated with */
  worktreeId?: string;
  /** Whether the panel pane is currently visible in the viewport */
  isVisible?: boolean;
  /** Opaque state bag for extension panels — survives the save/restore round-trip */
  extensionState?: Record<string, unknown>;
  /**
   * Extension ID of the plugin that registered this panel's kind, if applicable.
   * Preserved across save/restore so the placeholder can name the missing plugin
   * when its registration is gone.
   */
  pluginId?: string;
  // Note: Tab membership is now stored in TabGroup objects, not on panels
}

export interface PtyPanelData extends BasePanelData {
  kind: "terminal";
  /**
   * Durable launch affinity — the agent this terminal was launched to run, if any.
   *
   * It is the "which agent's command did we inject at spawn time" record, kept so:
   *   - Restart can re-inject the same command.
   *   - Session resume can look up the agent's resume flags.
   *   - Persisted settings (model, preset, launch flags) have a key.
   *   - Chrome/activity can stay agent-branded across renderer restore before
   *     transient runtime detection rehydrates.
   *
   * Live detection wins when present. A strong exit signal (`agentState:
   * "exited"`, terminal exit/error, or exitCode) demotes back to shell chrome.
   * Absent for plain-shell launches.
   */
  launchAgentId?: AgentId;
  /** Current working directory of the terminal */
  cwd: string;
  /** Process ID of the underlying PTY process */
  pid?: number;
  /** Number of columns in the terminal */
  cols: number;
  /** Number of rows in the terminal */
  rows: number;
  /** Current agent lifecycle state (only meaningful while an agent is detected) */
  agentState?: AgentState;
  /** Timestamp when agentState last changed (milliseconds since epoch) */
  lastStateChange?: number;
  /** What triggered the most recent state change */
  stateChangeTrigger?: AgentStateChangeTrigger;
  /** Confidence in the most recent state detection (0.0-1.0) */
  stateChangeConfidence?: number;
  /** AI-generated activity headline (e.g., "Installing dependencies") */
  activityHeadline?: string;
  /** Semantic activity status (working, waiting, success, failure) */
  activityStatus?: "working" | "waiting" | "success" | "failure";
  /** Terminal task type (interactive, background, idle) */
  activityType?: "interactive" | "background" | "idle";
  /** Timestamp when activity was last updated */
  activityTimestamp?: number;
  /** Last detected command for this terminal (e.g., 'npm run dev') */
  lastCommand?: string;
  /** Command to execute after shell starts (e.g., 'claude --model sonnet-4' for AI agents) */
  command?: string;
  /** Counter incremented on restart to trigger React re-render without unmounting parent */
  restartKey?: number;
  /** Guard flag to prevent auto-trash during restart flow (exit event race condition) */
  isRestarting?: boolean;
  /** Restart failure error - set when restart fails, cleared on success or manual action */
  restartError?: TerminalRestartError;
  /** Reconnection failure error - set when reconnection fails during project switch */
  reconnectError?: TerminalReconnectError;
  /** Flow control status - indicates if terminal is paused/suspended due to backpressure or safety policy */
  flowStatus?: TerminalFlowStatus;
  /** Combined lifecycle status for UI + diagnostics */
  runtimeStatus?: TerminalRuntimeStatus;
  /** Timestamp when flow status last changed */
  flowStatusTimestamp?: number;
  /** Whether user input is locked (read-only monitor mode) */
  isInputLocked?: boolean;
  /** Current URL for browser/dev-preview panels */
  browserUrl?: string;
  /** Navigation history for browser/dev-preview panels */
  browserHistory?: BrowserHistory;
  /** Zoom factor for browser/dev-preview panels */
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
  /** Whether the dev-preview console drawer is open */
  devPreviewConsoleOpen?: boolean;
  /** Behavior when terminal exits: "keep" preserves for review, "trash" sends to trash, "remove" deletes completely */
  exitBehavior?: PanelExitBehavior;
  /** Detected process icon ID for dynamic terminal icons (transient, not persisted) */
  detectedProcessId?: string;
  /** Canonical live runtime identity for terminal chrome (transient, not persisted) */
  runtimeIdentity?: TerminalRuntimeIdentity;
  /**
   * Sticky live-session flag. True once runtime detection fires in this session,
   * even if no agent is currently detected. Enables "this terminal hosted an
   * agent at some point" decisions (exit preservation, chrome demotion).
   *
   * Not persisted; rehydrated from backend reconnect payload.
   */
  everDetectedAgent?: boolean;
  /**
   * Live detected identity — the agent currently running in this terminal.
   *
   * Live detected identity — highest-precedence runtime evidence for UI
   * chrome, fleet eligibility, hybrid-input visibility, and focus routing.
   * When absent, durable `launchAgentId` can still provide agent affinity until
   * a strong exit signal demotes the terminal back to shell chrome.
   *
   * Not persisted; rehydrated from backend reconnect payload.
   * See `docs/architecture/terminal-identity.md`.
   */
  detectedAgentId?: BuiltInAgentId;
  /** Captured agent session ID from graceful shutdown (used for session resume) */
  agentSessionId?: string;
  /** Process-level flags captured at launch time, persisted for session resume */
  agentLaunchFlags?: string[];
  /** Model ID selected at launch time for per-panel model selection */
  agentModelId?: string;
  /** Preset ID used at launch time, for live color lookup */
  agentPresetId?: string;
  /** Preset brand color (hex) captured at launch time; overridden by live settings lookup */
  agentPresetColor?: string;
  /** Origin that spawned this terminal */
  spawnedBy?: TerminalSpawnSource;
  /** Timestamp when this terminal was created */
  startedAt?: number;
  /** Exit code from the last process exit */
  exitCode?: number;
  /**
   * Original user-selected preset ID. Set on first spawn, never overwritten
   * when a fallback activates. Used to display "was {original} → {active}".
   */
  originalPresetId?: string;
  /** Whether this panel is currently running on a fallback preset. */
  isUsingFallback?: boolean;
  /** How many fallback hops have been consumed from the primary's chain (0-based index into fallbacks[]). */
  fallbackChainIndex?: number;
}

export interface BrowserPanelData extends BasePanelData {
  kind: "browser";
  /** Current URL for browser panes */
  browserUrl?: string;
  /** Navigation history for browser panes */
  browserHistory?: BrowserHistory;
  /** Zoom factor for browser panes */
  browserZoom?: number;
  /** Whether the browser console drawer is open */
  browserConsoleOpen?: boolean;
}

/** Viewport preset IDs for dev-preview responsive emulation */
export type ViewportPresetId = "iphone" | "pixel" | "ipad";

export interface DevPreviewPanelData extends BasePanelData {
  kind: "dev-preview";
  /** Current working directory for the dev server */
  cwd: string;
  /** Dev server command (e.g., 'npm run dev') */
  devCommand?: string;
  /** Current URL for the preview browser */
  browserUrl?: string;
  /** Navigation history for the preview browser */
  browserHistory?: BrowserHistory;
  /** Zoom factor for the preview browser */
  browserZoom?: number;
  /** Whether the console drawer is open */
  devPreviewConsoleOpen?: boolean;
  /** Dev server status */
  devServerStatus?: "stopped" | "starting" | "installing" | "running" | "error";
  /** Dev server URL */
  devServerUrl?: string;
  /** Dev server error */
  devServerError?: { type: string; message: string };
  /** Terminal ID associated with dev server */
  devServerTerminalId?: string;
  /** Behavior when dev server exits */
  exitBehavior?: PanelExitBehavior;
  /** Active viewport preset (undefined = fill/full-width) */
  viewportPreset?: ViewportPresetId;
  /** Last captured scroll position, paired with URL for stale-scroll prevention */
  devPreviewScrollPosition?: { url: string; scrollY: number };
}

export type PanelInstance = PtyPanelData | BrowserPanelData | DevPreviewPanelData;

export function isPtyPanel(panel: PanelInstance | TerminalInstance): panel is PtyPanelData {
  const kind = panel.kind ?? "terminal";
  return kind === "terminal";
}

export function isBrowserPanel(panel: PanelInstance | TerminalInstance): panel is BrowserPanelData {
  const kind = panel.kind ?? "terminal";
  return kind === "browser";
}

export function isDevPreviewPanel(
  panel: PanelInstance | TerminalInstance
): panel is DevPreviewPanelData {
  const kind = panel.kind ?? "terminal";
  return kind === "dev-preview";
}

/**
 * Legacy interface for backward compatibility with persisted state.
 * New code should use the PanelInstance discriminated union.
 *
 * Note: PTY-specific fields (cwd, cols, rows) are optional to support
 * non-PTY panels like browser.
 */
export interface TerminalInstance {
  id: string;
  worktreeId?: string;
  kind?: PanelKind;
  /**
   * Launch hint — the agent this terminal was *launched to run*. Not identity.
   * See `PtyPanelData.launchAgentId` for the full contract.
   */
  launchAgentId?: AgentId;
  title: string;
  /** How the title is owned. Absent = "default". */
  titleMode?: PanelTitleMode;
  /** Last meaningful OSC title observed from the running agent — survives the trash window for display. */
  lastObservedTitle?: string;
  /** Working directory - only present for PTY panels */
  cwd?: string;
  pid?: number;
  /** Terminal columns - only present for PTY panels */
  cols?: number;
  /** Terminal rows - only present for PTY panels */
  rows?: number;
  agentState?: AgentState;
  lastStateChange?: number;
  stateChangeTrigger?: AgentStateChangeTrigger;
  stateChangeConfidence?: number;
  waitingReason?: WaitingReason;
  /** Extracted session cost in dollars from the last completed agent run */
  sessionCost?: number;
  /** Extracted session token count from the last completed agent run */
  sessionTokens?: number;
  activityHeadline?: string;
  activityStatus?: "working" | "waiting" | "success" | "failure";
  activityType?: "interactive" | "background" | "idle";
  activityTimestamp?: number;
  lastCommand?: string;
  location: PanelLocation;
  command?: string;
  isVisible?: boolean;
  restartKey?: number;
  isRestarting?: boolean;
  restartError?: TerminalRestartError;
  /** Error that occurred during reconnection (e.g., timeout, not found) */
  reconnectError?: TerminalReconnectError;
  /** Error that occurred when spawning the PTY process */
  spawnError?: import("./pty-host.js").SpawnError;
  flowStatus?: TerminalFlowStatus;
  runtimeStatus?: TerminalRuntimeStatus;
  flowStatusTimestamp?: number;
  isInputLocked?: boolean;
  browserUrl?: string;
  browserHistory?: BrowserHistory;
  browserZoom?: number;
  /** Whether the browser console drawer is open */
  browserConsoleOpen?: boolean;
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
  /** Active viewport preset for dev-preview responsive emulation (undefined = fill) */
  viewportPreset?: ViewportPresetId;
  /** Last captured dev-preview scroll position, paired with URL for stale-scroll prevention */
  devPreviewScrollPosition?: { url: string; scrollY: number };
  /** Behavior when terminal exits: "keep" preserves for review, "trash" sends to trash, "remove" deletes completely */
  exitBehavior?: PanelExitBehavior;
  /** Legacy persisted creation timestamp (milliseconds since epoch) */
  createdAt?: number;
  /** Whether this terminal has an active PTY process (false for orphaned terminals that exited) */
  hasPty?: boolean;
  /** Detected process icon ID for dynamic terminal icons (transient, not persisted) */
  detectedProcessId?: string;
  /** Canonical live runtime identity for terminal chrome (transient, not persisted) */
  runtimeIdentity?: TerminalRuntimeIdentity;
  /**
   * Sticky live-session flag; set once on first runtime detection, never cleared.
   * See `PtyPanelData.everDetectedAgent` for full contract.
   */
  everDetectedAgent?: boolean;
  /**
   * Live detected identity — the agent currently running in this terminal.
   * See `PtyPanelData.detectedAgentId` for full contract.
   */
  detectedAgentId?: BuiltInAgentId;
  /** Captured agent session ID from graceful shutdown (used for session resume) */
  agentSessionId?: string;
  /** Process-level flags captured at launch time, persisted for session resume */
  agentLaunchFlags?: string[];
  /** Model ID selected at launch time for per-panel model selection */
  agentModelId?: string;
  /** Preset ID used at launch time, for live color lookup */
  agentPresetId?: string;
  /** Preset brand color (hex) captured at launch time; overridden by live settings lookup */
  agentPresetColor?: string;
  /** Origin that spawned this terminal */
  spawnedBy?: TerminalSpawnSource;
  /** Timestamp when this terminal was created */
  startedAt?: number;
  /** Exit code from the last process exit */
  exitCode?: number;
  /**
   * Live-only spawn lifecycle state. "spawning" from the moment the optimistic
   * placeholder lands in `panelsById` until the PTY IPC round-trip resolves;
   * then "ready". Absent (undefined) on hydrated panels — treat as "ready".
   * Never serialized — see `serializePtyPanel`.
   */
  spawnStatus?: "spawning" | "ready";
  /** Original user-selected preset ID; immutable across fallback hops. */
  originalPresetId?: string;
  /** Whether this panel is currently running on a fallback preset. */
  isUsingFallback?: boolean;
  /** How many fallback hops have been consumed from the primary's chain. */
  fallbackChainIndex?: number;
  /** Opaque state bag for extension panels — survives the save/restore round-trip */
  extensionState?: Record<string, unknown>;
  /**
   * Extension ID of the plugin that registered this panel's kind, if applicable.
   * Preserved across save/restore so the placeholder can name the missing plugin
   * when its registration is gone.
   */
  pluginId?: string;
  // Note: Tab membership is now stored in TabGroup objects, not on panels
}

/** Options for spawning a new PTY process */
export interface PtySpawnOptions {
  /** Working directory for the new process */
  cwd: string;
  /** Shell executable to use (defaults to user's shell) */
  shell?: string;
  /** Arguments to pass to the shell */
  args?: string[];
  /** Environment variables to set */
  env?: Record<string, string>;
  /** Initial number of columns */
  cols: number;
  /** Initial number of rows */
  rows: number;
}

/** Terminal dimensions for resize operations */
export interface TerminalDimensions {
  /** Terminal width in columns */
  width: number;
  /** Terminal height in rows */
  height: number;
}
