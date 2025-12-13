/**
 * Message protocol types for Workspace Host IPC communication.
 *
 * This module defines the message format for communication between
 * the Main process (WorkspaceClient) and the Workspace Host (UtilityProcess).
 *
 * The Workspace Host consolidates all file-system and worktree-related operations:
 * - Phase 1: Git operations (WorktreeService, GitService)
 * - Phase 2: Context generation (CopyTreeService) - future
 * - Phase 3: DevServer parsing (DevServerManager) - future
 *
 * All types are serializable (no functions, no circular refs) for IPC transport.
 */

import type { Worktree, WorktreeChanges, FileChangeDetail, WorktreeMood } from "./domain.js";
import type { CopyTreeOptions, CopyTreeProgress, CopyTreeResult, FileTreeNode } from "./ipc.js";
import type { ProjectPulse, PulseRangeDays } from "./pulse.js";

/** Options for creating a new worktree */
export interface CreateWorktreeOptions {
  baseBranch: string;
  newBranch: string;
  path: string;
  fromRemote?: boolean;
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

/** Worktree state snapshot for IPC transport */
export interface WorktreeSnapshot {
  id: string;
  path: string;
  name: string;
  branch?: string;
  isCurrent: boolean;
  isMainWorktree?: boolean;
  gitDir?: string;
  summary?: string;
  modifiedCount?: number;
  changes?: FileChangeDetail[];
  mood?: WorktreeMood;
  lastActivityTimestamp?: number | null;
  aiNote?: string;
  aiNoteTimestamp?: number;
  issueNumber?: number;
  prNumber?: number;
  prUrl?: string;
  prState?: "open" | "merged" | "closed";
  worktreeChanges?: WorktreeChanges | null;
  worktreeId: string;
  timestamp?: number;
}

/** Monitor configuration for polling intervals */
export interface MonitorConfig {
  pollIntervalActive?: number;
  pollIntervalBackground?: number;
  adaptiveBackoff?: boolean;
  pollIntervalMax?: number;
  circuitBreakerThreshold?: number;
}

/**
 * Requests sent from Main → Workspace Host.
 * Each request is a discriminated union type for compile-time safety.
 * Request IDs enable tracking responses for async operations.
 */
export type WorkspaceHostRequest =
  // Project lifecycle
  | { type: "load-project"; requestId: string; rootPath: string }
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
    }
  // Branch operations
  | { type: "list-branches"; requestId: string; rootPath: string }
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
  // DevServer parsing operations
  | { type: "devserver:parse-output"; requestId: string; worktreeId: string; output: string }
  // GitHub token propagation
  | { type: "update-github-token"; token: string | null }
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

/** Result of DevServer URL detection */
export interface DevServerDetectedUrls {
  url?: string;
  port?: number;
}

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
  | { type: "create-worktree-result"; requestId: string; success: boolean; error?: string }
  | { type: "delete-worktree-result"; requestId: string; success: boolean; error?: string }
  // Branch operation responses
  | { type: "list-branches-result"; requestId: string; branches: BranchInfo[]; error?: string }
  // Git operation responses
  | { type: "get-file-diff-result"; requestId: string; diff: string; error?: string }
  // Spontaneous updates (no requestId - these are pushed events)
  | { type: "worktree-update"; worktree: WorktreeSnapshot }
  | { type: "worktree-removed"; worktreeId: string }
  // PR events
  | {
      type: "pr-detected";
      worktreeId: string;
      prNumber: number;
      prUrl: string;
      prState: "open" | "merged" | "closed";
    }
  | { type: "pr-cleared"; worktreeId: string }
  // CopyTree events
  | { type: "copytree:progress"; operationId: string; progress: CopyTreeProgress }
  | {
      type: "copytree:complete";
      requestId: string;
      operationId: string;
      result: CopyTreeResult;
    }
  | { type: "copytree:error"; requestId: string; operationId: string; error: string }
  // DevServer events
  | {
      type: "devserver:urls-detected";
      requestId: string;
      worktreeId: string;
      detected: DevServerDetectedUrls | null;
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
  | { type: "git:project-pulse-error"; requestId: string; error: string };

/** Configuration for WorkspaceClient */
export interface WorkspaceClientConfig {
  /** Maximum restart attempts before giving up */
  maxRestartAttempts?: number;
  /** Health check interval in milliseconds */
  healthCheckIntervalMs?: number;
  /** Whether to show dialog on crash */
  showCrashDialog?: boolean;
}
