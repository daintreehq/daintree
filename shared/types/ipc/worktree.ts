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
