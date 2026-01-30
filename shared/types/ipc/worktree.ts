/** Worktree removal payload */
export interface WorktreeRemovePayload {
  worktreeId: string;
}

/** Payload for setting active worktree */
export interface WorktreeSetActivePayload {
  worktreeId: string;
}

/** Payload for deleting a worktree */
export interface WorktreeDeletePayload {
  worktreeId: string;
  force?: boolean;
  /** Delete the associated git branch after removing the worktree */
  deleteBranch?: boolean;
}

export interface BranchInfo {
  name: string;
  current: boolean;
  commit: string;
  remote?: string;
}

export interface CreateWorktreeOptions {
  baseBranch: string;
  newBranch: string;
  path: string;
  fromRemote?: boolean;
  useExistingBranch?: boolean;
}

/** Worktree path pattern configuration */
export interface WorktreeConfig {
  pathPattern: string;
}

/** Payload for creating a task-scoped worktree */
export interface CreateForTaskPayload {
  taskId: string;
  baseBranch?: string;
  description?: string;
}

/** Options for cleaning up a task-scoped worktree */
export interface CleanupTaskOptions {
  /** Whether to force delete worktree with uncommitted changes (default: true) */
  force?: boolean;
  /** Whether to delete the associated git branch after removing the worktree (default: true) */
  deleteBranch?: boolean;
}
