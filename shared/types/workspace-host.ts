/**
 * Message protocol types for Workspace Host IPC communication.
 *
 * This module defines the message format for communication between
 * the Main process (WorkspaceClient) and the Workspace Host (UtilityProcess).
 *
 * The Workspace Host consolidates all file-system and worktree-related operations:
 * - Phase 1: Git operations (WorktreeService, GitService)
 * - Phase 2: Context generation (CopyTreeService) - future
 *
 * All types are serializable (no functions, no circular refs) for IPC transport.
 */

import type { FileChangeDetail, WorktreeChanges } from "./git.js";
import type {
  Worktree,
  WorktreeMood,
  WorktreeLifecycleStatus,
  WorktreeResourceStatus,
} from "./worktree.js";
import type {
  CopyTreeOptions,
  CopyTreeProgress,
  CopyTreeResult,
  CopyTreeTestConfigResult,
  FileTreeNode,
} from "./ipc.js";
import type { ProjectPulse, PulseRangeDays } from "./pulse.js";

/** Options for creating a new worktree */
export interface CreateWorktreeOptions {
  baseBranch: string;
  newBranch: string;
  path: string;
  fromRemote?: boolean;
  useExistingBranch?: boolean;
  /** Opt-in flag to run resource.provision after setup */
  provisionResource?: boolean;
  /** Worktree environment mode ("local" or an environment key from resourceEnvironments) */
  worktreeMode?: string;
}

/** Branch information from git */
export interface BranchInfo {
  name: string;
  current: boolean;
  commit: string;
  remote?: string;
}

/** Pull request service status */
export interface PRServiceStatus {
  isRunning: boolean;
  candidateCount: number;
  resolvedPRCount: number;
  lastCheckTime?: number;
  circuitBreakerTripped?: boolean;
}

/**
 * Worktree state snapshot for IPC transport.
 *
 * IMPORTANT: All fields must be serializable via structured clone algorithm.
 * No functions, class instances, symbols, or circular references allowed.
 * Snapshots are automatically sanitized via ensureSerializable() before sending.
 */
export interface WorktreeSnapshot {
  id: string;
  path: string;
  name: string;
  branch?: string;
  isCurrent: boolean;
  /**
   * Whether this is the main worktree (project permanent worktree).
   * Determined by canonical path match with project root, not git primary status.
   * Main worktrees are protected from deletion and cleanup operations.
   * False when project root path is unavailable (no protection applied).
   */
  isMainWorktree?: boolean;
  gitDir?: string;
  summary?: string;
  modifiedCount?: number;
  changes?: FileChangeDetail[];
  mood?: WorktreeMood;
  lastActivityTimestamp?: number | null;
  createdAt?: number;
  aiNote?: string;
  aiNoteTimestamp?: number;
  issueNumber?: number;
  prNumber?: number;
  prUrl?: string;
  prState?: "open" | "merged" | "closed";
  prTitle?: string;
  issueTitle?: string;
  worktreeChanges?: WorktreeChanges | null;
  worktreeId: string;
  timestamp?: number;
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

  /** Connect command from .daintree/config.json resource block */
  resourceConnectCommand?: string;

  /** Whether this worktree's project has a resource config block */
  hasResourceConfig?: boolean;

  /** Whether the resource config has a status command */
  hasStatusCommand?: boolean;

  /** Whether the resource config has a pause command */
  hasPauseCommand?: boolean;

  /** Whether the resource config has a resume command */
  hasResumeCommand?: boolean;

  /** Whether the resource config has a teardown command */
  hasTeardownCommand?: boolean;

  /** Whether the resource config has a provision command */
  hasProvisionCommand?: boolean;

  /** Worktree environment mode ("local" or an environment key from resourceEnvironments) */
  worktreeMode?: string;

  /** Cached display label for the environment (e.g., "Docker", "Akash") */
  worktreeEnvironmentLabel?: string;
}

/** Monitor configuration for polling intervals */
export interface MonitorConfig {
  pollIntervalActive?: number;
  pollIntervalBackground?: number;
  adaptiveBackoff?: boolean;
  pollIntervalMax?: number;
  circuitBreakerThreshold?: number;
  gitWatchEnabled?: boolean;
  gitWatchDebounceMs?: number;
}

/**
 * Requests sent from Main → Workspace Host.
 * Each request is a discriminated union type for compile-time safety.
 * Request IDs enable tracking responses for async operations.
 */
export type WorkspaceHostRequest =
  // Project lifecycle
  | {
      type: "load-project";
      requestId: string;
      rootPath: string;
      globalEnvVars?: Record<string, string>;
    }
  | {
      type: "sync";
      requestId: string;
      worktrees: Worktree[];
      activeWorktreeId: string | null;
      mainBranch: string;
      monitorConfig?: MonitorConfig;
    }
  | { type: "project-switch"; requestId: string }
  // Worktree queries
  | { type: "get-all-states"; requestId: string }
  | { type: "get-monitor"; requestId: string; worktreeId: string }
  // Worktree operations
  | { type: "set-active"; requestId: string; worktreeId: string }
  | { type: "refresh"; requestId: string; worktreeId?: string }
  | { type: "refresh-prs"; requestId: string }
  | { type: "get-pr-status"; requestId: string }
  | { type: "reset-pr-state"; requestId: string }
  | {
      type: "create-worktree";
      requestId: string;
      rootPath: string;
      options: CreateWorktreeOptions;
    }
  | {
      type: "delete-worktree";
      requestId: string;
      worktreeId: string;
      force?: boolean;
      deleteBranch?: boolean;
    }
  // Branch operations
  | { type: "list-branches"; requestId: string; rootPath: string }
  | { type: "get-recent-branches"; requestId: string; rootPath: string }
  | {
      type: "fetch-pr-branch";
      requestId: string;
      rootPath: string;
      prNumber: number;
      headRefName: string;
    }
  // Git operations
  | {
      type: "get-file-diff";
      requestId: string;
      cwd: string;
      filePath: string;
      status: string;
    }
  // Polling control
  | { type: "set-polling-enabled"; enabled: boolean }
  // Background/foreground lifecycle
  | { type: "background" }
  | { type: "foreground" }
  // Health check
  | { type: "health-check" }
  // Lifecycle
  | { type: "dispose" }
  // CopyTree operations
  | {
      type: "copytree:generate";
      requestId: string;
      operationId: string;
      rootPath: string;
      options?: CopyTreeOptions;
    }
  | { type: "copytree:cancel"; operationId: string }
  | {
      type: "copytree:test-config";
      requestId: string;
      rootPath: string;
      options?: CopyTreeOptions;
    }
  // Resource profile config update
  | { type: "update-monitor-config"; requestId: string; config: MonitorConfig }
  // Resource actions
  | {
      type: "resource-action";
      requestId: string;
      worktreeId: string;
      action: "provision" | "teardown" | "resume" | "pause" | "status";
    }
  | {
      type: "switch-worktree-environment";
      requestId: string;
      worktreeId: string;
      envKey: string;
    }
  | { type: "has-resource-config"; requestId: string; rootPath: string }
  // Direct renderer port attachment (port transferred via postMessage transfer list)
  | { type: "attach-renderer-port" }
  // GitHub token propagation
  | { type: "update-github-token"; token: string | null }
  // Project environment variable propagation
  | { type: "update-project-env"; vars: Record<string, string> }
  // File tree operations
  | {
      type: "get-file-tree";
      requestId: string;
      worktreePath: string;
      dirPath?: string;
    }
  // Project Pulse operations
  | {
      type: "git:get-project-pulse";
      requestId: string;
      worktreePath: string;
      worktreeId: string;
      mainBranch: string;
      rangeDays: PulseRangeDays;
      includeDelta?: boolean;
      includeRecentCommits?: boolean;
      forceRefresh?: boolean;
    };

/**
 * Events sent from Workspace Host → Main.
 * Includes both responses to requests and spontaneous updates.
 */
export type WorkspaceHostEvent =
  // Lifecycle events
  | { type: "ready" }
  | { type: "pong" }
  | { type: "error"; error: string; requestId?: string }
  // Project lifecycle responses
  | { type: "load-project-result"; requestId: string; success: boolean; error?: string }
  | { type: "sync-result"; requestId: string; success: boolean; error?: string }
  | { type: "update-monitor-config-result"; requestId: string; success: boolean; error?: string }
  | { type: "project-switch-result"; requestId: string; success: boolean }
  // Worktree query responses
  | { type: "all-states"; requestId: string; states: WorktreeSnapshot[] }
  | { type: "monitor"; requestId: string; state: WorktreeSnapshot | null }
  // Worktree operation responses
  | { type: "set-active-result"; requestId: string; success: boolean }
  | { type: "refresh-result"; requestId: string; success: boolean; error?: string }
  | { type: "refresh-prs-result"; requestId: string; success: boolean; error?: string }
  | { type: "get-pr-status-result"; requestId: string; status: PRServiceStatus | null }
  | { type: "reset-pr-state-result"; requestId: string; success: boolean }
  | {
      type: "create-worktree-result";
      requestId: string;
      success: boolean;
      worktreeId?: string;
      error?: string;
    }
  | { type: "delete-worktree-result"; requestId: string; success: boolean; error?: string }
  // Branch operation responses
  | { type: "list-branches-result"; requestId: string; branches: BranchInfo[]; error?: string }
  | { type: "get-recent-branches-result"; requestId: string; branches: string[]; error?: string }
  | { type: "fetch-pr-branch-result"; requestId: string; success: boolean; error?: string }
  // Git operation responses
  | { type: "get-file-diff-result"; requestId: string; diff: string; error?: string }
  // Spontaneous updates (no requestId - these are pushed events)
  | { type: "worktree-update"; worktree: WorktreeSnapshot }
  | { type: "worktree-removed"; worktreeId: string }
  // Linux-only: fired once per host-process lifetime when the recursive file
  // watcher hits the inotify watch limit (ENOSPC).
  | { type: "inotify-limit-reached" }
  // PR events
  | {
      type: "pr-detected";
      worktreeId: string;
      prNumber: number;
      prUrl: string;
      prState: "open" | "merged" | "closed";
      prTitle?: string;
      issueNumber?: number;
      issueTitle?: string;
    }
  | { type: "pr-cleared"; worktreeId: string }
  // Issue events
  | {
      type: "issue-detected";
      worktreeId: string;
      issueNumber: number;
      issueTitle: string;
    }
  | {
      type: "issue-not-found";
      worktreeId: string;
      issueNumber: number;
    }
  // CopyTree events
  | { type: "copytree:progress"; operationId: string; progress: CopyTreeProgress }
  | {
      type: "copytree:complete";
      requestId: string;
      operationId: string;
      result: CopyTreeResult;
    }
  | { type: "copytree:error"; requestId: string; operationId: string; error: string }
  | {
      type: "copytree:test-config-result";
      requestId: string;
      result: CopyTreeTestConfigResult;
    }
  // File tree events
  | {
      type: "file-tree-result";
      requestId: string;
      nodes: FileTreeNode[];
      error?: string;
    }
  // Project Pulse events
  | { type: "git:project-pulse"; requestId: string; data: ProjectPulse }
  | { type: "git:project-pulse-error"; requestId: string; error: string }
  // Resource action responses
  | {
      type: "resource-action-result";
      requestId: string;
      success: boolean;
      output?: string;
      error?: string;
    }
  | {
      type: "has-resource-config-result";
      requestId: string;
      hasConfig: boolean;
    };

/** Configuration for WorkspaceClient */
export interface WorkspaceClientConfig {
  /** Maximum restart attempts before giving up */
  maxRestartAttempts?: number;
  /** Health check interval in milliseconds */
  healthCheckIntervalMs?: number;
  /** Whether to show dialog on crash */
  showCrashDialog?: boolean;
}
