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

export type { BranchInfo, CreateWorktreeOptions } from "../git.js";

/** Worktree path pattern configuration */
export interface WorktreeConfig {
  pathPattern: string;
}

/** Persisted worktree-to-issue association */
export interface IssueAssociation {
  issueNumber: number;
  issueTitle: string;
  issueState: "OPEN" | "CLOSED";
  issueUrl: string;
}

/** Payload for attaching an issue to a worktree */
export interface AttachIssuePayload {
  worktreeId: string;
  issueNumber: number;
  issueTitle: string;
  issueState: "OPEN" | "CLOSED";
  issueUrl: string;
}

/** Payload for detaching an issue from a worktree */
export interface DetachIssuePayload {
  worktreeId: string;
}
