import type { FileChangeDetail, WorktreeChanges } from "./git.js";

/** Worktree mood indicator */
export type WorktreeMood = "stable" | "active" | "stale" | "error";

/** Phase of worktree lifecycle script execution */
export type WorktreeLifecyclePhase =
  | "setup"
  | "teardown"
  | "resource-provision"
  | "resource-teardown"
  | "resource-resume"
  | "resource-pause"
  | "resource-status";

/** State of worktree lifecycle script execution */
export type WorktreeLifecycleState = "running" | "success" | "failed" | "timed-out";

/** Status of worktree lifecycle script execution (serializable) */
export interface WorktreeLifecycleStatus {
  phase: WorktreeLifecyclePhase;
  state: WorktreeLifecycleState;
  currentCommand?: string;
  commandIndex?: number;
  totalCommands?: number;
  output?: string;
  startedAt: number;
  completedAt?: number;
  error?: string;
}

/** Resource status from the last manual status check */
export interface WorktreeResourceStatus {
  /** Raw status string from CLI output (e.g., "ready", "paused", "running") */
  lastStatus?: string;
  /** Last command output (tail) */
  lastOutput?: string;
  /** Error message if the last resource command failed */
  error?: string;
  /** Timestamp of the last status check */
  lastCheckedAt?: number;
  /** Resource endpoint URL from status JSON */
  endpoint?: string;
  /** Arbitrary metadata from status JSON */
  meta?: Record<string, unknown>;
  /** Provider identifier from config */
  provider?: string;
  /** Timestamp (ms epoch) when resource was last resumed */
  resumedAt?: number;
  /** Timestamp (ms epoch) when resource was last paused */
  pausedAt?: number;
}

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

  /**
   * Whether this is the main worktree (project permanent worktree).
   * Determined by canonical path match with project root, not git primary status.
   * Main worktrees are protected from deletion and cleanup operations.
   * False when project root path is unavailable (no protection applied).
   */
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

  /** Current or last completed lifecycle script status */
  lifecycleStatus?: WorktreeLifecycleStatus;

  /** Whether a plan file (TODO.md, PLAN.md, etc.) exists in the worktree root */
  hasPlanFile?: boolean;

  /** Relative path to the detected plan file (e.g. "TODO.md") */
  planFilePath?: string;

  /** Number of commits ahead of the upstream tracking branch */
  aheadCount?: number;

  /** Number of commits behind the upstream tracking branch */
  behindCount?: number;

  /** Resource status from the last manual status check */
  resourceStatus?: WorktreeResourceStatus;

  /** Connect command from .canopy/config.json resource block */
  resourceConnectCommand?: string;

  /** Whether this worktree's project has a resource config block */
  hasResourceConfig?: boolean;

  /** Whether the configured resource environment has a pause command */
  hasPauseCommand?: boolean;

  /** Whether the configured resource environment has a resume command */
  hasResumeCommand?: boolean;

  /** Whether the configured resource environment has a teardown command */
  hasTeardownCommand?: boolean;

  /** Worktree environment mode ("local" or an environment key from resourceEnvironments) */
  worktreeMode?: string;

  /** Cached display label for the environment (e.g., "Docker", "Akash") */
  worktreeEnvironmentLabel?: string;
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
