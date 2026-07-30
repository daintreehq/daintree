import type { AgentState, AgentStateChangeTrigger, AgentId, WaitingReason } from "./agent.js";
import type { TerminalCheckResult } from "./checkResult.js";
import type { BuiltInAgentId } from "../config/agentIds.js";
import type { BrowserHistory } from "./browser.js";
import type { GitStatus, DiffChangeSetEntry } from "./git.js";
import {
  BUILT_IN_PANEL_KINDS,
  panelKindIsDockable,
  type BuiltInPanelKind,
} from "../config/panelKindRegistry.js";

export type { BuiltInPanelKind };

/**
 * Panel kind: distinguishes between terminals, browser panels, and
 * extension-provided panel types. Agent-ness is a dynamic state of a terminal,
 * NOT a distinct panel kind — see `docs/architecture/terminal-identity.md`.
 *
 * Built-in kinds are listed in `BUILT_IN_PANEL_KINDS`.
 * Extensions can register additional kinds as strings.
 */
export type PanelKind = BuiltInPanelKind | (string & {});

/**
 * Location of a panel instance in the UI.
 *
 * `"dialog"` is the ephemeral presentation: the panel renders inside a modal
 * via `PanelDialogHost` instead of the grid or dock. Dialog panels are never
 * persisted, never counted toward the panel limit, and never restored on
 * restart — see `excludeFromPersistence`, which they always carry.
 */
export type PanelLocation = "grid" | "dock" | "overlay" | "trash" | "background" | "dialog";

/** Tab group location (subset of PanelLocation, excludes trash) */
export type TabGroupLocation = "grid" | "dock";

/**
 * Maps every `PanelLocation` to whether a panel at that location is a member of
 * the user-visible panel grid. `undefined` (legacy persisted panels written
 * before the `location` field existed) is treated as grid.
 *
 * The `satisfies Record<PanelLocation, boolean>` annotation makes any future
 * widening of `PanelLocation` a compile error here — forcing a placement
 * decision for the new value instead of silently defaulting it into the grid
 * (the root cause of issue #9699, where `"overlay"` leaked into grid filters).
 */
const GRID_MEMBER_BY_LOCATION = {
  grid: true,
  dock: false,
  overlay: false,
  trash: false,
  background: false,
  dialog: false,
} satisfies Record<PanelLocation, boolean>;

/**
 * Whether a panel at this location is a member of the user-visible panel grid.
 *
 * True only for `"grid"` and `undefined` (legacy panels). `"dock"`, `"overlay"`
 * (Daintree Assistant), `"trash"`, `"background"`, and `"dialog"` (modal
 * presentation) are NOT grid members and must be excluded from grid fleet
 * membership, counts, badges, and focus.
 */
export function isGridPanelLocation(location: PanelLocation | undefined): boolean {
  return location === undefined || GRID_MEMBER_BY_LOCATION[location];
}

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
  return (BUILT_IN_PANEL_KINDS as readonly string[]).includes(kind);
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

/** Flow-control states emitted by the PTY host. `data-loss` is a transient
 *  pulse fired when the IPC fallback queue discards bytes — it is not a
 *  durable state, must not be persisted as `flowStatus`, and is consumed
 *  by the renderer to inject a discontinuity marker into the xterm buffer.
 *
 *  `suspended` and `paused-user` are FUTURE_SAB skeleton statuses: `suspended`
 *  is only produced by the SharedArrayBuffer transport path, which is
 *  disabled in production (SharedArrayBuffer is not supported in Electron
 *  UtilityProcess — see PR #7724 / issue #7653); `paused-user` has no producer
 *  anywhere. They are kept in the type union so the renderer-side
 *  Suspended pill, the a11y formatter, and the future-sab wake guard
 *  remain type-safe forward-looking code, but they are excluded from
 *  `PersistableFlowStatus` so the buffer/store paths never persist them
 *  as durable state. See issue #9900. */
export type TerminalFlowStatus =
  | "running"
  | "paused-backpressure"
  | "paused-resource-governor"
  // FUTURE_SAB: see note above — no production producer.
  | "paused-user"
  // FUTURE_SAB: see note above — only emitted by the disabled SAB path.
  | "suspended"
  | "data-loss";

/** Future-state SharedArrayBuffer flow statuses. Defined as a named carve-out
 *  so the `Exclude<…, FutureSABFlowStatus>` pattern below is readable and
 *  matches the existing `data-loss` exclusion (#7590). The renderer side
 *  of these statuses is preserved as a forward-looking skeleton — see
 *  `TerminalHeaderContent.tsx` (Suspended pill) and the a11y formatter in
 *  `useAccessibilityAnnouncements.ts` (case "suspended"). The narrowing
 *  in `PersistableFlowStatus` is the load-bearing change: a worker-thread
 *  migration that revives the SAB transport will update the type to add
 *  the new statuses back, restore the `lifecycle.ts` wake branch, and
 *  remove the FUTURE_SAB: markers at every site. */
export type FutureSABFlowStatus = "suspended" | "paused-user";

/** Subset of `TerminalFlowStatus` that is safe to persist as the durable
 *  flow state of a terminal. Two carve-outs:
 *  - `data-loss` is excluded because it is a pulse, not a state (#7590).
 *  - The `FutureSABFlowStatus` set (`suspended` | `paused-user`) is excluded
 *    because the renderer is being rationalized to mark these as forward-looking
 *    code (#9900). Persisting either would freeze the runtime status on a
 *    state that has no production producer. */
export type PersistableFlowStatus = Exclude<TerminalFlowStatus, "data-loss" | FutureSABFlowStatus>;

/** Runtime lifecycle status for terminals (visibility + flow + exit/error).
 *  Derived from a `PersistableFlowStatus`, so `data-loss` and the
 *  `FutureSABFlowStatus` set never appear here. */
export type TerminalRuntimeStatus = PersistableFlowStatus | "background" | "exited" | "error";

/** Origin that spawned a terminal */
export type TerminalSpawnSource = "quickrun" | "recipe" | "agent" | "palette" | "mcp";

/** Focus policy for newly-created panels — orthogonal to provenance. */
export type AddPanelFocusPolicy = "auto" | "preserve" | "take";

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
 * How a panel's title is currently owned — an ownership ladder where higher
 * rungs can never be overwritten by lower ones.
 *
 * - `"default"` — title is derived from live runtime identity and is free to
 *   flip as detection promotes/demotes. The agent's observed task title
 *   (`lastObservedTitle`) composes into the displayed title.
 * - `"custom"` — the title was explicitly named by automation (a preset, a
 *   launch `name`, or an MCP/assistant `terminal.rename`); frozen against
 *   detection rewrites, but task composition still applies and a later
 *   automation rename may replace it.
 * - `"user"` — a human renamed this panel; the title is fully frozen: no
 *   detection rewrite, no task composition, and automation renames bounce.
 *   Only a human rename (or an empty rename, which resets to `"default"`)
 *   changes it.
 *
 * Absent defaults to `"default"` for hydration compatibility.
 */
export type PanelTitleMode = "default" | "custom" | "user";

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

/** Structured error state for scrollback restore failures (issue #8535) */
export interface TerminalScrollbackRestoreError {
  /** Human-readable error message */
  message: string;
  /** Error classification: write timeout, parse error from xterm, or other */
  type: "timeout" | "parse" | "error";
  /** Timestamp when error occurred (milliseconds since epoch) */
  timestamp: number;
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
  /** Persisted creation timestamp (milliseconds since epoch). */
  createdAt?: number;
  /**
   * When true, this panel is excluded from persisted layout snapshots and from
   * user-visible terminal surfaces (counts, switchers, bulk actions). Such
   * panels are never rehydrated on app restart (e.g. Daintree assistant dock
   * terminals, `location: "dialog"` panels). Independent of `removeOnExit`.
   *
   * Lives on the base shape, not `PtyPanelData`: non-PTY panels (the file
   * viewer presented as a dialog) rely on it too, and a PTY-narrowed read
   * would silently ignore the flag for them.
   */
  excludeFromPersistence?: boolean;
  /**
   * Timestamp (ms) of the last user-initiated focus on this panel. Used by
   * panel restore to promote the most-recently-active panel per worktree to
   * the priority restore tier.
   */
  lastActiveAt?: number;
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
  /** Whether this terminal has an active PTY process (false for orphaned terminals that exited) */
  hasPty?: boolean;
  /** Last meaningful OSC title observed from the running agent — survives the trash window for display. */
  lastObservedTitle?: string;
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
  /** Why the agent is waiting (only meaningful while agentState is "waiting") */
  waitingReason?: WaitingReason;
  /** Error code or message from agent state transitions (e.g., "ECONNRESET", "EPIPE") */
  error?: string;
  /** Extracted session cost in dollars from the last completed agent run */
  sessionCost?: number;
  /** Extracted session token count from the last completed agent run */
  sessionTokens?: number;
  /** AI-generated activity headline (e.g., "Installing dependencies") */
  activityHeadline?: string;
  /** Semantic activity status (working, waiting, success, failure) */
  activityStatus?: "working" | "waiting" | "success" | "failure";
  /** Terminal task type (interactive, background, idle) */
  activityType?: "interactive" | "background" | "idle";
  /** Last detected command for this terminal (e.g., 'npm run dev') */
  lastCommand?: string;
  /** Command to execute after shell starts (e.g., 'claude --model sonnet-4' for AI agents) */
  command?: string;
  /**
   * Caller-resolved launch environment (preset/recipe/caller layers) captured at
   * spawn time. Persisted so a restored session replays the same provider env it
   * launched with instead of re-deriving from a preset that may no longer resolve
   * (#10922). Sanitized via `sanitizeAgentEnv` on the serialize/restore boundary.
   * The live global/project env layer is re-merged fresh at spawn, not stored here.
   */
  env?: Record<string, string>;
  /** Counter incremented on restart to trigger React re-render without unmounting parent */
  restartKey?: number;
  /** Guard flag to prevent auto-trash during restart flow (exit event race condition) */
  isRestarting?: boolean;
  /** Restart failure error - set when restart fails, cleared on success or manual action */
  restartError?: TerminalRestartError;
  /** Reconnection failure error - set when reconnection fails during project switch */
  reconnectError?: TerminalReconnectError;
  /** Scrollback restore failure - set when deferred scrollback replay fails */
  scrollbackRestoreError?: TerminalScrollbackRestoreError;
  /** Error that occurred when spawning the PTY process */
  spawnError?: import("./pty-host.js").SpawnError;
  /** Flow control status - indicates if terminal is paused/suspended due to backpressure or safety policy.
   *  Excludes `data-loss` (transient pulse only — never persisted as state)
   *  and the `FutureSABFlowStatus` set (`suspended` | `paused-user`,
   *  no production producer — see #9900). */
  flowStatus?: PersistableFlowStatus;
  /** Combined lifecycle status for UI + diagnostics */
  runtimeStatus?: TerminalRuntimeStatus;
  /** Timestamp when flow status last changed */
  flowStatusTimestamp?: number;
  /** Whether user input is locked (read-only monitor mode) */
  isInputLocked?: boolean;
  /**
   * Held duration gauge for currently-paused terminals, sampled by the
   * `pause-duration-gauge` reliability metric (2s tick). Distinct from
   * `flowStatus` (a transition) and from `pauseDuration` on the
   * `terminal-status` event (a one-shot at transition time) — this is a
   * continuous observation that updates while the terminal is paused and
   * is cleared on `pause-end`. Surfaced in the Tier-1 status pill
   * tooltip so users can tell "5s pause for a big burst" from
   * "renderer wedged for two minutes".
   */
  heldDurationMs?: number;
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
  /** Dev server phase label for dev-preview panels */
  devServerPhaseLabel?: string | null;
  /** Dev server URL for dev-preview panels */
  devServerUrl?: string;
  /** Dev server error for dev-preview panels */
  devServerError?: { type: string; message: string };
  /** Terminal ID associated with dev server for dev-preview panels */
  devServerTerminalId?: string;
  /** Whether the dev-preview console drawer is open */
  devPreviewConsoleOpen?: boolean;
  /** Active dev-preview console drawer tab ("output" = PTY, "console" = guest-page console) */
  devPreviewConsoleTab?: "output" | "console" | "diagnostics";
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
  /** Focus policy applied when this panel was created. */
  focusPolicy?: AddPanelFocusPolicy;
  /**
   * When true, this panel is removed immediately when its PTY exits instead of
   * being retained under the trash TTL. Independent of `excludeFromPersistence`.
   */
  removeOnExit?: boolean;
  /** Timestamp when this terminal was created */
  startedAt?: number;
  /** Exit code from the last process exit */
  exitCode?: number;
  /**
   * Parsed test/lint/build result from the most recent recognized check
   * summary (issue #10682). Best-effort, not an authoritative exit code — see
   * `TerminalCheckResult`. Surfaced over MCP via `terminal.getStatus`.
   * Live-only: set from `agent:state-changed`, never persisted.
   */
  lastCheckResult?: TerminalCheckResult;
  /**
   * Live-only spawn lifecycle state. "spawning" from the moment the optimistic
   * placeholder lands in `panelsById` until the PTY IPC round-trip resolves;
   * then "ready". Absent (undefined) on hydrated panels — treat as "ready".
   * Never serialized — see `serializePtyPanel`.
   */
  spawnStatus?: "spawning" | "ready" | "missing-cli" | "failed";
  /**
   * Live-only render hint: mount the visible xterm immediately instead of
   * waiting for spawnStatus to flip "ready". Stamped at creation for a
   * single active-grid launch (startup queue idle), where realizing the
   * xterm concurrently with the spawn IPC shaves the round-trip off the
   * time-to-visible path. Burst spawns (queue non-idle) stay gated so many
   * panels never realize in the same frame. Never serialized.
   */
  eagerAttach?: boolean;
  /**
   * Original user-selected preset ID. Set on first spawn, never overwritten
   * when a fallback activates. Used to display "was {original} → {active}".
   */
  originalPresetId?: string;
  /** Whether this panel is currently running on a fallback preset. */
  isUsingFallback?: boolean;
  /** How many fallback hops have been consumed from the primary's chain (0-based index into fallbacks[]). */
  fallbackChainIndex?: number;
  /**
   * Live-only restore signal. True on first mount when the saved agent session
   * could not be safely resumed — unreachable, or resume-latest suppressed
   * because a sibling pane owns the slot (#11461) — and a fresh session was
   * launched instead. Drives the
   * "Session no longer reachable" restart banner. Cleared on restart; never
   * serialized — see `serializePtyPanel`.
   */
  sessionLostOnRestore?: boolean;
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
export type ViewportPresetId = "iphone" | "pixel" | "ipad" | "galaxy";

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
  /** Active dev-preview console drawer tab ("output" = PTY, "console" = guest-page console) */
  devPreviewConsoleTab?: "output" | "console" | "diagnostics";
  /** Dev server status */
  devServerStatus?: "stopped" | "starting" | "installing" | "running" | "error";
  /** Dev server phase label */
  devServerPhaseLabel?: string | null;
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
  /** Whether the active viewport preset is rotated to landscape (width/height swapped) */
  viewportRotated?: boolean;
  /** Device-pixel-ratio override for the active viewport preset (visual change deferred to #8278) */
  viewportDpr?: 1 | 2 | 3;
  /** Whether the viewport is scaled down to fit the available pane (zoom-to-fit) */
  viewportFit?: boolean;
  /** Last captured scroll position, paired with URL for stale-scroll prevention */
  devPreviewScrollPosition?: { url: string; scrollY: number };
}

/**
 * Review panel — mounts the worktree's Review & Commit surface, in a grid cell
 * or as a dialog. Carries no kind-specific *persisted* fields: `worktreeId`
 * from `BasePanelData` is the sole binding, and the worktree path is resolved
 * fresh from the worktree store at render time so renames or moves don't leave
 * a stale reference. The two fields below are open-time hints, deliberately
 * absent from `serializeReview`.
 */
export interface ReviewPanelData extends BasePanelData {
  kind: "review";
  /**
   * Commit message to seed the composer with on first open — the worktree
   * card's AI-note first line. An open-time hint only; never persisted, so a
   * restored panel opens with an empty composer rather than a stale message.
   *
   * Deliberately has no fallback anywhere in its chain: a silently substituted
   * commit message caused a real bad push (#7884). Empty means empty.
   */
  initialCommitMessage?: string;
  /**
   * Stage all unstaged files on open when nothing is staged yet, so opening
   * from the worktree card lands in a ready-to-commit state. An open-time hint
   * only; never persisted, so a restored panel never re-stages behind the user.
   */
  autoStageOnOpen?: boolean;
}

/**
 * The two modes that render the file's own bytes. Separate from `FileViewMode`
 * so document viewers can't be handed "diff", which they'd silently treat as
 * "rendered" (every non-"source" value takes their rendered branch).
 */
export type FileRenderMode = "rendered" | "source";

/**
 * View mode shared by the file viewer surfaces (panel + dialog). "rendered"
 * only applies to markdown and HTML files; "diff" only to files with local
 * worktree changes. Every other file is source-only. Availability is derived
 * per file at render time, so a persisted mode whose capability is gone falls
 * back to "source" rather than being rewritten.
 */
export type FileViewMode = FileRenderMode | "diff";

/**
 * File panel — read-only viewer for a repo file in a grid cell. Markdown and
 * HTML files additionally get a rendered-document mode, and locally changed
 * files get a diff mode. `filePath` is absolute; the effective read root is
 * resolved at render time (the panel's worktree when the file is inside one,
 * else the file's parent directory) so worktree renames don't strand the panel.
 */
export interface FilePanelData extends BasePanelData {
  kind: "file";
  /** Absolute path of the file being viewed; absent = picker empty state */
  filePath?: string;
  /** Active view mode. Absent defaults to "source". */
  fileViewMode?: FileViewMode;
  /**
   * 1-based line to scroll to on first render. An open-time hint only —
   * deliberately absent from `serializeFile`, so it never persists and a
   * restored panel opens at the top rather than at a stale position.
   */
  initialLine?: number;
}

/**
 * Which set of changes a diff panel is reviewing. Selects both the change-set
 * derivation (which files appear in the workspace sidebar) and the fetch path:
 * the working-tree sources diff against the index via `git.getFileDiff`, while
 * "base-branch" compares the branch against its merge base.
 */
export type DiffSource = "working-tree" | "staged" | "unstaged" | "base-branch";

/**
 * Diff panel — renders one file's diff, plus the multi-file review workspace
 * (sidebar, viewed markers, cross-file stepping) when its source resolves to
 * more than one changed file.
 *
 * Every field is optional so a partially-restored panel degrades to an empty
 * state rather than a type error, mirroring `FilePanelData.filePath`. The
 * change set itself is deliberately absent: it is rebuilt live from the
 * worktree store on every render, so a restored panel never shows files that
 * have since been committed or reverted (the `ReviewPanelData` rationale).
 */
export interface DiffPanelData extends BasePanelData {
  kind: "diff";
  /** Worktree-relative path of the file being diffed; absent = empty state. */
  filePath?: string;
  /**
   * Status the diff was opened against. Persisted as the fallback used before
   * live change data resolves, and when the file has left the change set.
   */
  fileStatus?: GitStatus;
  /** Which change set this panel reviews. Absent defaults to "working-tree". */
  diffSource?: DiffSource;
  /**
   * Base ref for `diffSource: "base-branch"`. The *current* branch is
   * deliberately not persisted — it is resolved live from the worktree, so a
   * branch switch can't strand the panel comparing against a stale ref.
   */
  baseBranch?: string;
  /**
   * Files the review workspace steps through. Runtime-only — deliberately
   * absent from `serializeDiff`, so a restored panel opens on its single file
   * rather than replaying a change set whose files may since have been
   * committed or reverted.
   *
   * Pushed by whichever surface opened the panel (the change list, the review
   * hub, the base-branch compare) rather than derived here: each of those
   * orders and keys its files differently, and the base-branch set arrives
   * from a `compareWorktrees` fetch that has no worktree-store equivalent.
   * Keeping one owner per set is what stops the two from drifting.
   */
  changeSet?: DiffChangeSetEntry[];
  /**
   * Cursor into `changeSet` for the open file. Runtime-only (never
   * serialized), because it only means anything alongside the live set.
   *
   * (path, status) is not unique: partial staging puts the same path with the
   * same status in both the staged and unstaged sections, and those entries
   * differ only by `viewedKey`. Without this cursor the panel resolves to the
   * first match, so selecting the unstaged copy highlights the staged row and
   * marks the wrong file viewed.
   */
  viewedKey?: string;
}

/** One directory entry in a persisted file-browser tree snapshot. */
export interface FileBrowserSnapshotNode {
  /** Entry basename. */
  name: string;
  /** Worktree-relative path. */
  path: string;
  isDirectory: boolean;
}

/** One directory's listing in a persisted file-browser tree snapshot. */
export interface FileBrowserTreeSnapshotEntry {
  /** Worktree-relative directory path; "" = the browse root's own listing. */
  dirPath: string;
  nodes: FileBrowserSnapshotNode[];
}

/**
 * Structure-only snapshot of a file browser's last-known tree (#11367): entry
 * names, paths and directory bits — never contents, sizes or timestamps.
 * Tagged with the identity it was captured under so a worktree switch or
 * re-root can't seed the wrong tree; a mismatch just cold-starts. Arrays
 * rather than a Map because it round-trips through JSON persistence.
 */
export interface FileBrowserTreeSnapshot {
  /** Absent when the browser is rooted at the workspace itself (#11482). */
  worktreeId?: string;
  /**
   * Absolute root the listings were captured under. Identity only — never
   * joined against, so it can't strand the panel the way a persisted absolute
   * *root* would; a mismatch (a relocated project) just cold-starts, which is
   * the same self-healing outcome as a worktree switch.
   */
  basePath?: string;
  /** Browse root relative to the base at capture time; "" = the base itself. */
  rootPath: string;
  listings: FileBrowserTreeSnapshotEntry[];
}

/**
 * File browser panel — a lazily-expanded directory tree over one folder with a
 * read-only viewer beside it. Every field is relative rather than absolute (the
 * root comes from `worktreeId`, like `DiffPanelData.filePath`), so moving or
 * renaming the folder can't strand the panel on a dead path.
 *
 * A panel opened without a worktree is rooted at the *view's own workspace* —
 * the project or scratch folder it was created for (#11482) — and records that
 * as `browserWorkspaceRooted`, because grid promotion later stamps a
 * placement `worktreeId` onto it (#11290) and absence alone would stop
 * answering (#11489). Deliberately no absolute root is stored for that case
 * either: main derives it from the same sender binding it authorizes against,
 * so resolving it fresh on both sides is what keeps them from ever disagreeing.
 *
 * Every field persists: the issue's contract is that a pinned panel keeps its
 * expansion, selection and layout, and `promoteDialogPanelToGrid` reuses the
 * same panel record, so anything stored here also survives dialog → grid
 * promotion without a side channel.
 */
export interface FileBrowserPanelData extends BasePanelData {
  kind: "file-browser";
  /** Worktree-relative path of the selected file; absent = nothing selected. */
  browserSelectedPath?: string;
  /**
   * Worktree-relative directory paths the user has expanded. A list rather
   * than a Set because panel data round-trips through JSON persistence.
   */
  browserExpandedPaths?: string[];
  /**
   * Whether dot-prefixed entries are hidden in this panel. Absent defaults to
   * false — dotfiles are visible by default; the toolbar toggle hides them
   * (#11330). Replaces the old `browserShowIgnored` field, which is
   * intentionally not migrated: its meaning was inverted, so an old panel that
   * showed gitignored files must not silently start hiding dotfiles.
   */
  browserHideDotfiles?: boolean;
  /**
   * Directory the tree is rooted at, relative to the base. Absent or "" = the
   * base itself. Always relative, in both modes — `canonicalizeRootPath`
   * collapses anything traversal-shaped, so it structurally cannot carry an
   * absolute path.
   */
  browserRootPath?: string;
  /**
   * Whether the tree sidebar is collapsed. Absent or `false` = open (the
   * default); only `true` is persisted, so an open panel stays sparse.
   */
  browserSidebarCollapsed?: boolean;
  /**
   * Whether the viewer column is collapsed, leaving the tree as the whole
   * panel (#11496). Absent or `false` = open; only `true` is persisted.
   *
   * Independent of `browserSidebarCollapsed` on disk, but the two are mutually
   * exclusive on screen: each column's toggle lives in the *other* column's
   * header, so a reachable gesture can never hide both. A record holding both
   * flags resolves tree-hidden/viewer-visible at read time in the pane.
   */
  browserViewerCollapsed?: boolean;
  /**
   * Last-known tree structure, captured when the view goes away and painted
   * back instantly on restore while a live refresh runs (#11367). Derived
   * data, unlike every other field here — but it must live on the panel
   * record because the renderer (and any cache in it) is destroyed on LRU
   * eviction; only the persisted record survives.
   */
  browserTreeSnapshot?: FileBrowserTreeSnapshot;
  /**
   * Dragged width of the tree column in px. Absent = the 288px default; only a
   * non-default, in-range width is persisted, so an unresized panel stays
   * sparse. Independent of both collapse flags: collapsing either column never
   * clears it, so re-opening restores the last-dragged split (#11331, #11496).
   * Governs the split layout only — as the sole column the tree simply fills
   * the panel, so the width is remembered rather than applied.
   */
  browserSidebarWidth?: number;
  /**
   * Whether the tree is rooted at the view's workspace folder — a scratch or
   * worktree-less project root (#11482) — rather than at `worktreeId`.
   *
   * Decided once at creation from the absence of a requested worktree, and
   * never changed by a placement gesture. Promotion into the grid adopts the
   * active worktree so the panel lands in a rendered index bucket (#11290);
   * for a workspace-rooted panel that id is placement metadata only, and
   * re-deriving the browse root from it silently re-roots the tree to a folder
   * the user never asked for (#11489). Only `true` is persisted.
   */
  browserWorkspaceRooted?: boolean;
}

export type PanelInstance =
  | PtyPanelData
  | BrowserPanelData
  | DevPreviewPanelData
  | ReviewPanelData
  | FilePanelData
  | FileBrowserPanelData
  | DiffPanelData;

export function isPtyPanel(panel: PanelInstance | TerminalInstance): panel is PtyPanelData {
  const kind = panel.kind ?? "terminal";
  // eslint-disable-next-line no-restricted-syntax -- sanctioned panel-kind type guard
  return kind === "terminal";
}

export function isBrowserPanel(panel: PanelInstance | TerminalInstance): panel is BrowserPanelData {
  const kind = panel.kind ?? "terminal";
  // eslint-disable-next-line no-restricted-syntax -- sanctioned panel-kind type guard
  return kind === "browser";
}

export function isDevPreviewPanel(
  panel: PanelInstance | TerminalInstance
): panel is DevPreviewPanelData {
  const kind = panel.kind ?? "terminal";
  // eslint-disable-next-line no-restricted-syntax -- sanctioned panel-kind type guard
  return kind === "dev-preview";
}

export function isReviewPanel(panel: PanelInstance | TerminalInstance): panel is ReviewPanelData {
  const kind = panel.kind ?? "terminal";

  return kind === "review";
}

export function isFilePanel(panel: PanelInstance | TerminalInstance): panel is FilePanelData {
  const kind = panel.kind ?? "terminal";

  return kind === "file";
}

export function isFileBrowserPanel(
  panel: PanelInstance | TerminalInstance
): panel is FileBrowserPanelData {
  const kind = panel.kind ?? "terminal";

  return kind === "file-browser";
}

export function isDiffPanel(panel: PanelInstance | TerminalInstance): panel is DiffPanelData {
  const kind = panel.kind ?? "terminal";

  return kind === "diff";
}

/**
 * A panel known to be dockable. Dockability is runtime registry state, not a
 * fixed kind list: any registered kind is dockable unless it declares
 * `dockable: false` (see `panelKindIsDockable`), including plugin kinds cast
 * into `PanelInstance` at creation. So this is `PanelInstance` — the guarantee
 * lives in `isDockPanel`'s runtime check, and the dock render path narrows per
 * kind (`isPtyPanel` for the terminal chip, `DockedNonPtyPanelItem` for the
 * rest) rather than trusting this type to enumerate members.
 */
export type DockPanelData = PanelInstance;

export function isDockPanel(panel: PanelInstance | TerminalInstance): panel is DockPanelData {
  return panelKindIsDockable(panel.kind ?? "terminal");
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
  /** Error code or message from agent state transitions (e.g., "ECONNRESET", "EPIPE") */
  error?: string;
  /** Extracted session cost in dollars from the last completed agent run */
  sessionCost?: number;
  /** Extracted session token count from the last completed agent run */
  sessionTokens?: number;
  activityHeadline?: string;
  activityStatus?: "working" | "waiting" | "success" | "failure";
  activityType?: "interactive" | "background" | "idle";
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
  /** Error that occurred during deferred scrollback restore (issue #8535) */
  scrollbackRestoreError?: TerminalScrollbackRestoreError;
  flowStatus?: PersistableFlowStatus;
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
  /** Dev server phase label for dev-preview panels */
  devServerPhaseLabel?: string | null;
  /** Dev server URL for dev-preview panels */
  devServerUrl?: string;
  /** Dev server error for dev-preview panels */
  devServerError?: { type: string; message: string };
  /** Terminal ID associated with dev server for dev-preview panels */
  devServerTerminalId?: string;
  /** Whether the dev-preview console drawer is open */
  devPreviewConsoleOpen?: boolean;
  /** Active dev-preview console drawer tab ("output" = PTY, "console" = guest-page console) */
  devPreviewConsoleTab?: "output" | "console" | "diagnostics";
  /** Behavior when terminal exits: "keep" preserves for review, "trash" sends to trash, "remove" deletes completely */
  exitBehavior?: PanelExitBehavior;
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
  /** Focus policy applied when this panel was created. */
  focusPolicy?: AddPanelFocusPolicy;
  /**
   * When true, this panel is excluded from persisted layout snapshots and from
   * user-visible terminal surfaces (counts, switchers, bulk actions). Such
   * panels are never rehydrated on app restart (e.g. Daintree assistant dock
   * terminals).
   */
  excludeFromPersistence?: boolean;
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
  spawnStatus?: "spawning" | "ready" | "missing-cli" | "failed";
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
  /** Legacy persisted creation timestamp (milliseconds since epoch). */
  createdAt?: number;
  /**
   * Timestamp (ms) of the last user-initiated focus on this panel. Used by
   * panel restore to promote the most-recently-active panel per worktree to
   * the priority restore tier.
   */
  lastActiveAt?: number;
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
