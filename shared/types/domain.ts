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

  /** Worktree changes snapshot */
  worktreeChanges?: WorktreeChanges | null;
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

// Terminal Types
export type AgentId = string;
export type LegacyAgentType = "claude" | "gemini" | "codex";
/** Terminal kind: distinguishes between default terminals and agent-driven terminals */
export type TerminalKind = "terminal" | "agent";
/**
 * @deprecated Use TerminalKind + agentId instead. This is kept for backward compatibility/migrations.
 */
export type TerminalType = "terminal" | LegacyAgentType;

/** Location of a terminal instance in the UI */
export type TerminalLocation = "grid" | "dock" | "trash";

/** Valid triggers for agent state changes */
export type AgentStateChangeTrigger =
  | "input"
  | "output"
  | "heuristic"
  | "ai-classification"
  | "timeout"
  | "exit"
  | "activity";

export enum TerminalRefreshTier {
  BURST = 16, // 60fps - only during active typing
  FOCUSED = 100, // 10fps - focused but idle
  VISIBLE = 200, // 5fps
  BACKGROUND = 1000, // 1fps
}

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

/** Represents a terminal instance in the application */
export interface TerminalInstance {
  /** Unique identifier for this terminal */
  id: string;
  /** ID of the worktree this terminal is associated with */
  worktreeId?: string;
  /** Terminal category */
  kind?: TerminalKind;
  /**
   * Legacy field retained for persistence; new code should prefer `kind`.
   * - "terminal" for default terminals
   * - legacy agent ids ("claude", "gemini", "codex") when migrated from old state
   */
  type?: TerminalType;
  /** Agent ID when kind is 'agent' */
  agentId?: AgentId;
  /** Display title for the terminal tab */
  title: string;
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
  /** Location in the UI - grid (main view) or dock (minimized) */
  location: TerminalLocation;
  /** Command to execute after shell starts (e.g., 'claude --model sonnet-4' for AI agents) */
  command?: string;
  /** Whether the terminal pane is currently visible in the viewport */
  isVisible?: boolean;
  /** Counter incremented on restart to trigger React re-render without unmounting parent */
  restartKey?: number;
  /** Guard flag to prevent auto-trash during restart flow (exit event race condition) */
  isRestarting?: boolean;
  /** Restart failure error - set when restart fails, cleared on success or manual action */
  restartError?: TerminalRestartError;
  /** Flow control status - indicates if terminal is paused/suspended due to backpressure or safety policy */
  flowStatus?: "running" | "paused-backpressure" | "paused-user" | "suspended";
  /** Timestamp when flow status last changed */
  flowStatusTimestamp?: number;
  /** Whether user input is locked (read-only monitor mode) */
  isInputLocked?: boolean;
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
}

/** Terminal snapshot for state preservation */
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
  /** Working directory */
  cwd: string;
  /** Associated worktree ID */
  worktreeId?: string;
  /** Location in the UI - grid or dock */
  location: TerminalLocation;
  /** Command to execute after shell starts (e.g., 'claude --model sonnet-4' for AI agents) */
  command?: string;
}

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
  /** Terminal layout metadata */
  terminalLayout?: TerminalLayout;
}

// Terminal Recipe Types

/** Recipe terminal type */
export type RecipeTerminalType = AgentId | "terminal";

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
}

/** A saved terminal recipe */
export interface TerminalRecipe {
  /** Unique identifier for the recipe */
  id: string;
  /** Human-readable name for the recipe */
  name: string;
  /** Associated worktree ID (undefined for global recipes) */
  worktreeId?: string;
  /** List of terminals to spawn when recipe is executed */
  terminals: RecipeTerminal[];
  /** Timestamp when recipe was created (milliseconds since epoch) */
  createdAt: number;
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

/** Project-level settings that persist per repository */
export interface ProjectSettings {
  /** List of custom run commands for this project */
  runCommands: RunCommand[];
  /** Environment variables to set */
  environmentVariables?: Record<string, string>;
  /** Paths to exclude from monitoring */
  excludedPaths?: string[];
}
