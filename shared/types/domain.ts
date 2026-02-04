// Git Types

/** Git file status */
export type GitStatus =
  | "modified"
  | "added"
  | "deleted"
  | "untracked"
  | "ignored"
  | "renamed"
  | "copied";

/** Details about a single file change in a worktree */
export interface FileChangeDetail {
  /** Relative path to the file from worktree root */
  path: string;
  /** Git status of the file */
  status: GitStatus;
  /** Number of lines inserted (null if not applicable) */
  insertions: number | null;
  /** Number of lines deleted (null if not applicable) */
  deletions: number | null;
  /** File modification time in milliseconds (for recency scoring) */
  mtimeMs?: number;
  /** Alias for mtimeMs (compatibility with some APIs) */
  mtime?: number;
}

/** Aggregated git changes for a worktree */
export interface WorktreeChanges {
  /** Unique identifier for the worktree */
  worktreeId: string;
  /** Absolute path to worktree root */
  rootPath: string;
  /** List of individual file changes */
  changes: FileChangeDetail[];
  /** Total count of changed files */
  changedFileCount: number;
  /** Total lines inserted across all files */
  totalInsertions?: number;
  /** Total lines deleted across all files */
  totalDeletions?: number;
  /** Alias for totalInsertions (compatibility) */
  insertions?: number;
  /** Alias for totalDeletions (compatibility) */
  deletions?: number;
  /** Most recent file modification time */
  latestFileMtime?: number;
  /** Timestamp when changes were last calculated */
  lastUpdated?: number;
  /** Last commit message (cached to avoid extra git log calls) */
  lastCommitMessage?: string;
  /** Last commit time (ms since epoch, committer date) */
  lastCommitTimestampMs?: number;
}

// Worktree Types

/** Worktree mood indicator */
export type WorktreeMood = "stable" | "active" | "stale" | "error";

/** Git worktree - multiple working trees on same repo */
export interface Worktree {
  /** Stable identifier for this worktree (normalized absolute path) */
  id: string;

  /** Absolute path to the worktree root directory */
  path: string;

  /** Human-readable name (branch name or last path segment) */
  name: string;

  /** Git branch name if available (undefined for detached HEAD) */
  branch?: string;

  /** HEAD commit hash (only populated when in detached HEAD state) */
  head?: string;

  /** Whether this worktree is in detached HEAD state */
  isDetached?: boolean;

  /** Whether this is the currently active worktree based on cwd */
  isCurrent: boolean;

  /** Whether this is the main worktree (not a linked worktree) */
  isMainWorktree?: boolean;

  /** Path to the .git directory */
  gitDir?: string;

  /** Summary of work being done (last commit message or status) */
  summary?: string;

  /** Number of modified files in this worktree */
  modifiedCount?: number;

  /** Recent git status changes for this worktree */
  changes?: FileChangeDetail[];

  /** High-level mood/state for dashboard sorting */
  mood?: WorktreeMood;

  /** Timestamp of last git activity (milliseconds since epoch, null if no activity yet) */
  lastActivityTimestamp?: number | null;

  /** Timestamp when worktree directory was created (milliseconds since epoch, for sorting) */
  createdAt?: number;

  /** Content from .git/canopy/note file (for AI agent status communication) */
  aiNote?: string;

  /** Timestamp when the note file was last modified (milliseconds since epoch) */
  aiNoteTimestamp?: number;

  /** GitHub issue number extracted from branch name (e.g., 158 from feature/issue-158-description) */
  issueNumber?: number;

  /** GitHub pull request number linked to this worktree's issue or branch */
  prNumber?: number;

  /** GitHub pull request URL for quick access */
  prUrl?: string;

  /** Pull request state: open, merged, or closed */
  prState?: "open" | "merged" | "closed";

  /** Pull request title */
  prTitle?: string;

  /** GitHub issue title */
  issueTitle?: string;

  /** Worktree changes snapshot */
  worktreeChanges?: WorktreeChanges | null;

  /** Task ID for task-scoped worktree orchestration */
  taskId?: string;
}

/** Runtime worktree state (internal to WorktreeService) */
export interface WorktreeState extends Worktree {
  /** Alias for id (compatibility with some internal APIs) */
  worktreeId: string;
  /** Current changes snapshot (null if not yet calculated) */
  worktreeChanges: WorktreeChanges | null;
  /** Override to ensure lastActivityTimestamp is always present */
  lastActivityTimestamp: number | null;
}

// Notification Types

/** Notification type */
export type NotificationType = "info" | "success" | "error" | "warning";

/** A notification message to display to the user */
export interface Notification {
  /** Unique identifier for the notification */
  id: string;
  /** Message text to display */
  message: string;
  /** Type determines styling/icon */
  type: NotificationType;
}

/** Payload for creating a new notification (id is optional and will be generated) */
export type NotificationPayload = Omit<Notification, "id"> & { id?: string };

// Agent/Task/Run Types

/** Agent lifecycle state: idle | working | running | waiting | completed | failed */
export type AgentState = "idle" | "working" | "running" | "waiting" | "completed" | "failed";

/** Task state: draft | queued | running | blocked | completed | failed | cancelled */
export type TaskState =
  | "draft"
  | "queued"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

/** Execution instance - individual attempt of a task */
export interface RunRecord {
  /** Unique identifier for this run */
  id: string;
  /** ID of the agent executing this run */
  agentId: string;
  /** ID of the task being executed (optional for ad-hoc runs) */
  taskId?: string;
  /** Unix timestamp (ms) when the run started */
  startTime: number;
  /** Unix timestamp (ms) when the run ended (undefined if still running) */
  endTime?: number;
  /** Current state of the run */
  state: "running" | "completed" | "failed" | "cancelled";
  /** Error message if state is 'failed' */
  error?: string;
}

// Panel Types

export type AgentId = string;
export type LegacyAgentType = "claude" | "gemini" | "codex" | "opencode";

/** Built-in panel kinds */
export type BuiltInPanelKind = "terminal" | "agent" | "browser" | "notes" | "dev-preview";

/**
 * Panel kind: distinguishes between default terminals, agent-driven terminals, browser panels,
 * and extension-provided panel types.
 *
 * Built-in kinds: "terminal" | "agent" | "browser"
 * Extensions can register additional kinds as strings.
 */
export type PanelKind = BuiltInPanelKind | (string & {});

/**
 * @deprecated Use PanelKind instead. Kept for backward compatibility.
 */
export type TerminalKind = PanelKind;

/**
 * @deprecated Use PanelKind + agentId instead. This is kept for backward compatibility/migrations.
 */
export type TerminalType = "terminal" | LegacyAgentType;

/** Location of a panel instance in the UI */
export type PanelLocation = "grid" | "dock" | "trash";

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

/**
 * @deprecated Use PanelLocation instead. Kept for backward compatibility.
 */
export type TerminalLocation = PanelLocation;

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
  return (
    kind === "terminal" ||
    kind === "agent" ||
    kind === "browser" ||
    kind === "notes" ||
    kind === "dev-preview"
  );
}

/**
 * Check if a built-in panel kind requires PTY (terminal or agent).
 * For extension kinds, use `panelKindHasPty()` from panelKindRegistry
 * which consults the runtime registry configuration.
 */
export function isPtyPanelKind(kind: PanelKind): boolean {
  // Built-in kinds - for extension kinds, use panelKindHasPty() from registry
  return kind === "terminal" || kind === "agent" || kind === "dev-preview";
}

/** Valid triggers for agent state changes */
export type AgentStateChangeTrigger =
  | "input"
  | "output"
  | "heuristic"
  | "ai-classification"
  | "timeout"
  | "exit"
  | "activity";

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

export interface BrowserHistory {
  past: string[];
  present: string;
  future: string[];
}

interface BasePanelData {
  /** Unique identifier for this panel */
  id: string;
  /** Panel category */
  kind: PanelKind;
  /** Display title for the panel tab */
  title: string;
  /** Location in the UI - grid (main view) or dock (minimized) */
  location: TerminalLocation;
  /** ID of the worktree this panel is associated with */
  worktreeId?: string;
  /** Whether the panel pane is currently visible in the viewport */
  isVisible?: boolean;
  // Note: Tab membership is now stored in TabGroup objects, not on panels
}

interface PtyPanelData extends BasePanelData {
  kind: "terminal" | "agent" | "dev-preview";
  /**
   * Legacy field retained for persistence; new code should prefer `kind`.
   * - "terminal" for default terminals
   * - legacy agent ids ("claude", "gemini", "codex") when migrated from old state
   */
  type: TerminalType;
  /** Agent ID when kind is 'agent' */
  agentId?: AgentId;
  /** Current working directory of the terminal */
  cwd: string;
  /** Process ID of the underlying PTY process */
  pid?: number;
  /** Number of columns in the terminal */
  cols: number;
  /** Number of rows in the terminal */
  rows: number;
  /** Current agent lifecycle state (for agent-type terminals) */
  agentState?: AgentState;
  /** Timestamp when agentState last changed (milliseconds since epoch) */
  lastStateChange?: number;
  /** Error message if agentState is 'failed' */
  error?: string;
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
  /** Behavior when terminal exits: "keep" preserves for review, "trash" sends to trash, "remove" deletes completely */
  exitBehavior?: PanelExitBehavior;
}

interface BrowserPanelData extends BasePanelData {
  kind: "browser";
  /** Current URL for browser panes */
  browserUrl?: string;
  /** Navigation history for browser panes */
  browserHistory?: BrowserHistory;
  /** Zoom factor for browser panes */
  browserZoom?: number;
}

interface NotesPanelData extends BasePanelData {
  kind: "notes";
  /** Path to the note file (relative to project root) */
  notePath: string;
  /** Unique identifier for the note (from frontmatter) */
  noteId: string;
  /** Note scope: worktree-specific or project-wide */
  scope: "worktree" | "project";
  /** Timestamp when note was created (milliseconds since epoch) */
  createdAt: number;
}

export type PanelInstance = PtyPanelData | BrowserPanelData | NotesPanelData;

export function isPtyPanel(panel: PanelInstance | TerminalInstance): panel is PtyPanelData {
  const kind = panel.kind ?? "terminal";
  return kind === "terminal" || kind === "agent" || kind === "dev-preview";
}

export function isBrowserPanel(panel: PanelInstance | TerminalInstance): panel is BrowserPanelData {
  const kind = panel.kind ?? "terminal";
  return kind === "browser";
}

export function isNotesPanel(panel: PanelInstance): panel is NotesPanelData {
  return panel.kind === "notes";
}

export function isDevPreviewPanel(panel: PanelInstance | TerminalInstance): panel is PtyPanelData {
  const kind = panel.kind ?? "terminal";
  return kind === "dev-preview";
}

/**
 * Legacy interface for backward compatibility with persisted state.
 * New code should use the PanelInstance discriminated union.
 *
 * Note: PTY-specific fields (cwd, cols, rows) are optional to support
 * non-PTY panels like browser and notes.
 */
export interface TerminalInstance {
  id: string;
  worktreeId?: string;
  kind?: TerminalKind;
  type?: TerminalType;
  agentId?: AgentId;
  title: string;
  /** Working directory - only present for PTY panels */
  cwd?: string;
  pid?: number;
  /** Terminal columns - only present for PTY panels */
  cols?: number;
  /** Terminal rows - only present for PTY panels */
  rows?: number;
  agentState?: AgentState;
  lastStateChange?: number;
  error?: string;
  stateChangeTrigger?: AgentStateChangeTrigger;
  stateChangeConfidence?: number;
  activityHeadline?: string;
  activityStatus?: "working" | "waiting" | "success" | "failure";
  activityType?: "interactive" | "background" | "idle";
  activityTimestamp?: number;
  lastCommand?: string;
  location: TerminalLocation;
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
  notePath?: string;
  noteId?: string;
  scope?: "worktree" | "project";
  createdAt?: number;
  /** Dev command override for dev-preview panels */
  devCommand?: string;
  /** Behavior when terminal exits: "keep" preserves for review, "trash" sends to trash, "remove" deletes completely */
  exitBehavior?: PanelExitBehavior;
  /** Whether this terminal has an active PTY process (false for orphaned terminals that exited) */
  hasPty?: boolean;
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

// Project Types

/**
 * Project lifecycle status:
 * - `active`: Currently open and in use (only one project can be active at a time)
 * - `background`: Has running processes but not currently displayed
 * - `closed`: No running processes, fully dormant
 */
export type ProjectStatus = "active" | "background" | "closed";

/** Project (Git repository) managed by Canopy */
export interface Project {
  /** Unique identifier (UUID or path hash) */
  id: string;
  /** Git repository root path */
  path: string;
  /** User-editable display name */
  name: string;
  /** User-editable emoji (default: tree) */
  emoji: string;
  /** Timestamp of last opening (for sorting) */
  lastOpened: number;
  /** Theme color/gradient (optional) */
  color?: string;
  /** Project lifecycle status (defaults to 'closed' for backward compatibility) */
  status?: ProjectStatus;
}

/**
 * Panel snapshot for state preservation.
 * Note: Named TerminalSnapshot for backward compatibility.
 */
export interface TerminalSnapshot {
  /** Terminal ID */
  id: string;
  /** Terminal category */
  kind?: TerminalKind;
  /** Terminal type */
  type?: TerminalType;
  /** Agent ID when kind is an agent - enables extensibility */
  agentId?: AgentId;
  /** Display title */
  title: string;
  /** Working directory - only present for PTY panels */
  cwd?: string;
  /** Associated worktree ID */
  worktreeId?: string;
  /** Location in the UI - grid or dock */
  location: TerminalLocation;
  /** Command to execute after shell starts (e.g., 'claude --model sonnet-4' for AI agents) */
  command?: string;
  /** Current URL for browser/dev-preview panes */
  browserUrl?: string;
  /** Navigation history for browser/dev-preview panes */
  browserHistory?: BrowserHistory;
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
  // Note: Tab membership is now stored in ProjectState.tabGroups, not on terminals
}

/** Type alias for TerminalSnapshot. Use this in new code. */
export type PanelSnapshot = TerminalSnapshot;

/** Terminal layout metadata */
export interface TerminalLayout {
  /** Grid configuration (optional for future use) */
  grid?: {
    rows: number;
    cols: number;
  };
  /** Focused terminal ID */
  focusedTerminalId?: string;
  /** Maximized terminal ID */
  maximizedTerminalId?: string;
}

/** Focus panel state saved before entering focus mode */
export interface FocusPanelState {
  /** Sidebar width before focus mode */
  sidebarWidth: number;
  /** Whether diagnostics dock was open */
  diagnosticsOpen: boolean;
}

/** Per-project state snapshot */
export interface ProjectState {
  /** ID of the project this state belongs to */
  projectId: string;
  /** Active worktree ID */
  activeWorktreeId?: string;
  /** Sidebar width */
  sidebarWidth: number;
  /** Terminal snapshots */
  terminals: TerminalSnapshot[];
  /** Tab groups - explicit groups only (single panels are implicit) */
  tabGroups?: TabGroup[];
  /** Terminal layout metadata */
  terminalLayout?: TerminalLayout;
  /** Whether focus mode is active (panels collapsed for max terminal space) */
  focusMode?: boolean;
  /** Saved panel state before entering focus mode (for restoration) */
  focusPanelState?: FocusPanelState;
}

// Terminal Recipe Types

/** Recipe terminal type */
export type RecipeTerminalType = AgentId | "terminal" | "dev-preview";

/** Exit behavior for panels/terminals after process exits */
export type PanelExitBehavior = "keep" | "trash" | "remove";

/** A single terminal definition within a recipe */
export interface RecipeTerminal {
  /** Type of terminal to spawn */
  type: RecipeTerminalType;
  /** Custom title for this terminal (optional) */
  title?: string;
  /** Command to execute for custom terminal types (optional) */
  command?: string;
  /** Environment variables to set (optional) */
  env?: Record<string, string>;
  /** Initial prompt to send to agent terminals after boot (optional) */
  initialPrompt?: string;
  /** Dev server command for dev-preview terminals (optional). Falls back to project devServerCommand if not set. */
  devCommand?: string;
  /** Behavior when terminal exits: "keep" preserves for review, "trash" sends to trash, "remove" deletes completely (optional, defaults to "keep") */
  exitBehavior?: PanelExitBehavior;
}

/** A saved terminal recipe */
export interface TerminalRecipe {
  /** Unique identifier for the recipe */
  id: string;
  /** Human-readable name for the recipe */
  name: string;
  /** Project ID this recipe belongs to (required for project-scoped storage) */
  projectId: string;
  /** Associated worktree ID (optional for worktree-specific recipes) */
  worktreeId?: string;
  /** List of terminals to spawn when recipe is executed */
  terminals: RecipeTerminal[];
  /** Timestamp when recipe was created (milliseconds since epoch) */
  createdAt: number;
  /** Whether this recipe should appear in the empty state as a primary launcher */
  showInEmptyState?: boolean;
  /** Timestamp of last run (milliseconds since epoch) */
  lastUsedAt?: number;
}

// Project Settings Types

/** Run command definition */
export interface RunCommand {
  /** Unique identifier for this command */
  id: string;
  /** Display name (e.g. "Dev Server" or "Run Tests") */
  name: string;
  /** Command to execute (e.g. "npm run dev" or "php artisan test") */
  command: string;
  /** Optional icon name for UI display */
  icon?: string;
  /** Optional description (e.g. the script content from package.json) */
  description?: string;
}

/** CopyTree context generation settings */
export interface CopyTreeSettings {
  /** Maximum total context size in bytes (e.g., 1MB, 5MB, 10MB). Undefined = unlimited */
  maxContextSize?: number;
  /** Maximum individual file size in bytes. Files larger are skipped */
  maxFileSize?: number;
  /** Character limit per file for truncation. Files exceeding this will be truncated */
  charLimit?: number;
  /** Truncation strategy: "all" (no truncation) or "modified" (newest first when limits hit) */
  strategy?: "all" | "modified";
  /** Glob patterns to always include, even if old */
  alwaysInclude?: string[];
  /** Glob patterns to always exclude from context */
  alwaysExclude?: string[];
}

/** Project-level settings that persist per repository */
export interface ProjectSettings {
  /** List of custom run commands for this project */
  runCommands: RunCommand[];
  /** Environment variables to set */
  environmentVariables?: Record<string, string>;
  /** List of env var keys stored securely (values in safeStorage, not settings.json) */
  secureEnvironmentVariables?: string[];
  /** List of env var keys found in plaintext that should be migrated (transient, not persisted) */
  insecureEnvironmentVariables?: string[];
  /** List of secure keys that couldn't be decrypted (transient, not persisted) */
  unresolvedSecureEnvironmentVariables?: string[];
  /** Paths to exclude from monitoring */
  excludedPaths?: string[];
  /** Raw SVG text for project icon (max 250KB, validated/sanitized) */
  projectIconSvg?: string;
  /** ID of the default recipe to run when creating new worktrees */
  defaultWorktreeRecipeId?: string;
  /** Dev server command (e.g., "npm run dev") for the toolbar button */
  devServerCommand?: string;
  /** CopyTree context generation configuration */
  copyTreeSettings?: CopyTreeSettings;
  /** Command overrides for project-specific customization */
  commandOverrides?: import("./commands.js").CommandOverride[];
}

// Toolbar Customization Types

/** Unique identifier for toolbar buttons */
export type ToolbarButtonId =
  | "sidebar-toggle"
  | "claude"
  | "gemini"
  | "codex"
  | "opencode"
  | "terminal"
  | "browser"
  | "dev-server"
  | "github-stats"
  | "notes"
  | "copy-tree"
  | "settings"
  | "problems"
  | "sidecar-toggle"
  | "assistant";

/** Configuration for which toolbar buttons are visible and their order */
export interface ToolbarLayout {
  /** Ordered list of button IDs to show on the left side (excluding sidebar-toggle which is always first) */
  leftButtons: ToolbarButtonId[];
  /** Ordered list of button IDs to show on the right side (excluding sidecar-toggle which is always last) */
  rightButtons: ToolbarButtonId[];
}

/** Launcher palette default behaviors */
export interface LauncherDefaults {
  /** Always show dev server option in palette, even if devServerCommand not configured */
  alwaysShowDevServer: boolean;
  /** Default panel type to highlight when palette opens */
  defaultSelection?:
    | "terminal"
    | "claude"
    | "gemini"
    | "codex"
    | "opencode"
    | "browser"
    | "dev-server";
  /** Default agent for automated workflows like "What's Next?" */
  defaultAgent?: "claude" | "gemini" | "codex" | "opencode";
}

/** Complete toolbar preferences configuration */
export interface ToolbarPreferences {
  /** Layout configuration (button visibility and ordering) */
  layout: ToolbarLayout;
  /** Launcher palette defaults */
  launcher: LauncherDefaults;
}
