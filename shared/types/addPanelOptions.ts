import type {
  PanelKind,
  PanelLocation,
  PanelExitBehavior,
  PanelTitleMode,
  ViewportPresetId,
  FileViewMode,
  DiffSource,
  FileBrowserTreeSnapshot,
} from "./panel.js";
import type { GitStatus, DiffChangeSetEntry } from "./git.js";
import type { BrowserHistory } from "./browser.js";
import type { AgentState, AgentId, WaitingReason } from "./agent.js";
import type { TerminalSpawnSource, AddPanelFocusPolicy } from "./panel.js";
import type { BuiltInAgentId } from "../config/agentIds.js";
import type { ActionContext } from "./actions.js";

/** Fields shared by all panel creation requests */
export interface AddPanelOptionsBase {
  kind?: PanelKind;
  title?: string;
  /** How the title is owned. Absent defaults to "default". */
  titleMode?: PanelTitleMode;
  worktreeId?: string;
  /**
   * How `worktreeId` was determined: `"explicit"` (caller/user chose it, the
   * default when omitted) or `"inferred"` (derived from cwd prefix matching —
   * orphan reconnects, journal resume). Recorded in the lifecycle ledger,
   * whose invariant is that inferred attribution never overwrites a differing
   * explicit one.
   */
  worktreeIdSource?: "explicit" | "inferred";
  cwd?: string;
  location?: PanelLocation;
  /** If provided, request a stable ID when spawning a new backend process */
  requestedId?: string;
  /** If provided, reconnect to existing backend process instead of spawning */
  existingId?: string;
  /** Opaque state bag for extension panels — survives the save/restore round-trip */
  extensionState?: Record<string, unknown>;
  /**
   * Extension ID of the plugin that registered this panel's kind, if applicable.
   * Preserved across save/restore so the placeholder can name the missing plugin
   * when its registration is gone.
   */
  pluginId?: string;
  /** Origin that spawned this terminal */
  spawnedBy?: TerminalSpawnSource;
  /**
   * Focus policy for the new panel. `"auto"` (default) suppresses focus change
   * only when the assistant has keyboard focus. `"preserve"` always keeps focus
   * where it is (MCP spawns, background batch operations). `"take"` always
   * advances focus to the new panel regardless of context.
   */
  focusPolicy?: AddPanelFocusPolicy;
  /** Bypass rate limiter during session restore (consumes main-process quota) */
  restore?: boolean;
  /** Opaque admission group shared by PTY panels from one bounded recipe operation. */
  spawnBatchId?: string;
  /** Total PTY panels declared by that recipe operation, potentially across worktrees. */
  spawnBatchSize?: number;
  /** Bypass panel limit checks (used during hydration/state restoration) */
  bypassLimits?: boolean;
  /**
   * When true, the panel is excluded from persisted layout snapshots and from
   * user-visible terminal surfaces, and is never rehydrated on app restart. Use
   * for ad-hoc panels whose lifetime is bound to a transient UI surface (e.g.
   * the Daintree assistant in the dock). Independent of `removeOnExit`.
   */
  excludeFromPersistence?: boolean;
  /**
   * When true, the panel is removed immediately when its PTY exits instead of
   * being retained under the trash TTL. Independent of `excludeFromPersistence`.
   */
  removeOnExit?: boolean;
  /**
   * When the panel's *resolved* `location` is `"dock"`, atomically set it as
   * the open dock panel in the same `set()` that commits `panelsById`/
   * `panelIds`. Eliminates the create-then-activate race where the watchdog
   * effect can see `activeDockTerminalId` set across a microtask boundary
   * from the panel commit.
   *
   * Note: location can resolve to `"dock"` even when caller requested
   * `"grid"` if the grid is at capacity (auto-dock). In that case the flag
   * still fires; pass `false` if you specifically want grid-only activation
   * to be skipped on auto-dock.
   *
   * Ignored during hydration batches.
   */
  activateDockOnCreate?: boolean;
  /**
   * Keep the current fullscreen view when this panel lands in the grid and takes
   * focus. Only for callers that immediately fold the new panel into the group
   * that is *already* maximized — the tab-strip "+" adds the panel first and
   * groups it second, so at commit time it isn't a member yet and would
   * otherwise look like a plain new grid cell (#11060).
   *
   * Not a background-spawn switch: a caller that simply doesn't want to disturb
   * the user wants `focusPolicy: "preserve"`, which suppresses focus and leaves
   * maximize untouched on its own.
   */
  preserveMaximize?: boolean;
  // --- PTY-related fields (optional on all types, only used by PTY panel kinds) ---
  shell?: string;
  command?: string;
  /**
   * Launch hint — agent this terminal was launched to run. Not identity.
   * Drives nothing UI-facing. See `docs/architecture/terminal-identity.md`.
   */
  launchAgentId?: AgentId;
  agentState?: AgentState;
  /** Why the agent is waiting, restored from the backend snapshot on reconnect. Only meaningful when `agentState` is "waiting". */
  waitingReason?: WaitingReason;
  lastStateChange?: number;
  /** Store command on instance but don't execute it on spawn */
  skipCommandExecution?: boolean;
  /** Restore input lock state (read-only monitor mode) */
  isInputLocked?: boolean;
  /** Environment variables to set for this terminal */
  env?: Record<string, string>;
  /** Behavior when terminal exits */
  exitBehavior?: PanelExitBehavior;
  /** Captured agent session ID from graceful shutdown (used for session resume) */
  agentSessionId?: string;
  /** Process-level flags captured at launch time, persisted for session resume */
  agentLaunchFlags?: string[];
  /** Model ID selected at launch time for per-panel model selection */
  agentModelId?: string;
  /** Sticky "runtime agent ever detected" flag, rehydrated from backend during reconnect. */
  everDetectedAgent?: boolean;
  /** Runtime-detected agent identity at hydration time; cleared when the agent exits. Rehydrated from backend reconnect payload. */
  detectedAgentId?: BuiltInAgentId;
  /** Runtime-detected non-agent process icon id (npm, yarn, etc.) at hydration time; cleared when the process exits. */
  detectedProcessId?: string;
  /** Preset ID selected at launch time for per-panel preset selection */
  agentPresetId?: string;
  /** Preset brand color (hex) captured at launch time for per-panel icon tinting */
  agentPresetColor?: string;
  /** Original user-selected preset ID; immutable across fallback hops. */
  originalPresetId?: string;
  /** Whether this panel is currently running on a fallback preset. */
  isUsingFallback?: boolean;
  /** Chain index consumed so far from the primary preset's fallback list. */
  fallbackChainIndex?: number;
  /**
   * PTY-only, transient. True when session restore fell through to a fresh
   * agent launch because no resume command was usable — either none was
   * available (neither exact-session nor resume-latest), or resume-latest was
   * suppressed because a sibling pane owns this agent+cwd's single slot
   * (#11461) — so the prior conversation is unreachable for this pane.
   * Drives the "Session no longer reachable" restart banner. Never persisted;
   * cleared on the next restart. See `serializePtyPanel` (intentionally omitted).
   */
  sessionLostOnRestore?: boolean;
  /**
   * User-initiated focus timestamp from the saved snapshot, propagated
   * from the hydration boundary (`statePatcher.ts:buildArgsFor*` →
   * `sanitizeLastActiveAt`) to the live panel. Read by
   * `useAppHydration`'s post-hydration focus picker so the active
   * worktree's most-recently-focused panel wins the boot pick (#9933).
   * Not used for fresh spawns — only hydration paths set it.
   */
  lastActiveAt?: number;
  /**
   * Launch-time `ActionContext` snapshot, captured synchronously by the caller
   * when it initiates the launch. Threaded to `terminal.spawn` and consumed
   * only by the `daintree-assistant` pinned-session path (#10647) so the CLI's
   * MCP tool dispatch targets the worktree/terminal focused at launch even if
   * focus later changes. Ignored for every other agent. The help-session
   * launch path captures its own snapshot via `help.provisionSession` instead.
   */
  actionContext?: ActionContext;
}

/**
 * Options for creating a terminal panel.
 *
 * A "Claude terminal" is just a terminal with `launchAgentId: "claude"` and
 * `command: "claude"`; there is no separate panel kind. See
 * `docs/architecture/terminal-identity.md`.
 */
export interface TerminalPanelOptions extends AddPanelOptionsBase {
  kind?: "terminal";
}

/** Options for creating a browser panel */
export interface BrowserPanelOptions extends AddPanelOptionsBase {
  kind: "browser";
  /** Initial URL for the browser pane */
  browserUrl?: string;
  /** Navigation history */
  browserHistory?: BrowserHistory;
  /** Zoom factor */
  browserZoom?: number;
  /** Whether the browser console drawer is open */
  browserConsoleOpen?: boolean;
}

/** Options for creating a dev-preview panel */
export interface DevPreviewPanelOptions extends AddPanelOptionsBase {
  kind: "dev-preview";
  /** Dev server command (e.g., 'npm run dev') */
  devCommand?: string;
  /** Current URL for the preview browser */
  browserUrl?: string;
  /** Navigation history for the preview browser */
  browserHistory?: BrowserHistory;
  /** Zoom factor for the preview browser */
  browserZoom?: number;
  /** Dev server status */
  devServerStatus?: "stopped" | "starting" | "installing" | "running" | "error";
  /** Dev server URL */
  devServerUrl?: string;
  /** Dev server error */
  devServerError?: { type: string; message: string };
  /** Terminal ID associated with dev server */
  devServerTerminalId?: string;
  /** Whether the dev-preview console drawer is open */
  devPreviewConsoleOpen?: boolean;
  /** Active dev-preview console drawer tab ("output" = PTY, "console" = guest-page console) */
  devPreviewConsoleTab?: "output" | "console" | "diagnostics";
  /** Active viewport preset for responsive emulation (undefined = fill) */
  viewportPreset?: ViewportPresetId;
  /** Whether the active viewport preset is rotated to landscape */
  viewportRotated?: boolean;
  /** Device-pixel-ratio override for the active viewport preset */
  viewportDpr?: 1 | 2 | 3;
  /** Whether the viewport is scaled to fit the available pane */
  viewportFit?: boolean;
  /** Last captured scroll position, paired with URL for stale-scroll prevention */
  devPreviewScrollPosition?: { url: string; scrollY: number };
}

/**
 * Options for creating a review panel. Mounts the worktree's Review & Commit
 * surface in a grid cell or as a dialog. `worktreeId` from `AddPanelOptionsBase`
 * is the sole persisted binding — the worktree path is resolved at render time
 * from the worktree store. Both fields below are open-time hints; neither is
 * persisted.
 */
export interface ReviewPanelOptions extends AddPanelOptionsBase {
  kind: "review";
  /**
   * Commit message to seed the composer with on first open. Open-time hint;
   * never persisted. Must carry no fallback — see `ReviewPanelData` (#7884).
   */
  initialCommitMessage?: string;
  /** Stage all unstaged files on open when nothing is staged. Open-time hint. */
  autoStageOnOpen?: boolean;
}

/** Options for creating a file viewer panel */
export interface FilePanelOptions extends AddPanelOptionsBase {
  kind: "file";
  /** Absolute path of the file to view */
  filePath?: string;
  /** Initial view mode; defaults to "source" (rendered applies to Markdown and HTML) */
  fileViewMode?: FileViewMode;
  /** 1-based line to scroll to on first render. Open-time hint; never persisted. */
  initialLine?: number;
}

/**
 * Options for creating a file browser panel. Everything is optional — the
 * browser only needs the `worktreeId` from `AddPanelOptionsBase` to open on a
 * worktree root, and the rest are seeds for restoring a remembered view.
 */
export interface FileBrowserPanelOptions extends AddPanelOptionsBase {
  kind: "file-browser";
  /** Worktree-relative path to select on open */
  browserSelectedPath?: string;
  /** Worktree-relative directory paths to expand on open */
  browserExpandedPaths?: string[];
  /** Whether dot-prefixed entries start hidden; defaults to false (dotfiles visible) */
  browserHideDotfiles?: boolean;
  /** Worktree-relative directory to root the tree at; "" or absent = worktree root */
  browserRootPath?: string;
  /** Whether the tree sidebar starts collapsed; absent or false = open */
  browserSidebarCollapsed?: boolean;
  /** Last-known tree structure to paint before the first live listing (#11367) */
  browserTreeSnapshot?: FileBrowserTreeSnapshot;
  /** Tree column width in px to restore; absent or 288 = the default width */
  browserSidebarWidth?: number;
}

/**
 * Options for creating a diff panel. `filePath` is worktree-relative (the
 * worktree root comes from `worktreeId`) so a worktree move can't strand the
 * panel on a dead absolute path. The change set is not passed in — the panel
 * derives it live from the worktree store using `diffSource`.
 */
export interface DiffPanelOptions extends AddPanelOptionsBase {
  kind: "diff";
  /** Worktree-relative path of the file to diff */
  filePath?: string;
  /** Status the diff is opened against; defaults to "modified" */
  fileStatus?: GitStatus;
  /** Which change set to review; defaults to "working-tree" */
  diffSource?: DiffSource;
  /** Base ref, required when `diffSource` is "base-branch" */
  baseBranch?: string;
  /**
   * Files the review workspace steps through. Runtime-only; the opener keeps
   * it current via `setDiffPanelChangeSet` for as long as the panel is open.
   */
  changeSet?: DiffChangeSetEntry[];
  /**
   * `changeSet` entry the panel opens on. Pass it whenever the set can hold
   * two entries with the same path and status (partial staging) — they differ
   * only by this key. Runtime-only, like the set itself.
   */
  viewedKey?: string;
}

/**
 * Options for extension-provided panel kinds.
 *
 * NOTE: intentionally excluded from the `AddPanelOptions` union below. Including
 * `kind: string & {}` as a union member defeats discriminated-union narrowing
 * for built-in kinds (any literal string satisfies `string & {}`, so TypeScript
 * silently picks this variant and skips the stricter built-in shapes). Extensions
 * that need to spawn panels with a custom kind should widen via an explicit cast
 * at their integration boundary.
 */
export interface ExtensionPanelOptions extends AddPanelOptionsBase {
  kind: string & {};
}

/** Discriminated union of all built-in panel creation option types */
export type AddPanelOptions =
  | TerminalPanelOptions
  | BrowserPanelOptions
  | DevPreviewPanelOptions
  | ReviewPanelOptions
  | FilePanelOptions
  | FileBrowserPanelOptions
  | DiffPanelOptions;
