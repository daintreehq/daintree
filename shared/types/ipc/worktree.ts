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

/**
 * Where a linked issue came from (#13700). Absent on links made before issues
 * could come from a provider other than the code forge — those numbers belong
 * to the code forge. Present when an issues provider served the issue, so the
 * link survives that provider renumbering it and is never read back as the
 * code forge's issue of the same number.
 */
export interface IssueProvenance {
  /** Canonical id of the provider that served the issue. */
  issueProviderId?: string;
  /** The provider's own stable id for the issue (`Issue.id`). */
  issueId?: string;
  /** The provider's display identifier (`Issue.key`, e.g. `"ENG-123"`). */
  issueKey?: string;
}

/** Persisted worktree-to-issue association */
export interface IssueAssociation extends IssueProvenance {
  issueNumber: number;
  issueTitle: string;
}

/** Payload for attaching an issue to a worktree */
export interface AttachIssuePayload extends IssueProvenance {
  worktreeId: string;
  issueNumber: number;
  issueTitle: string;
}

/** Payload for detaching an issue from a worktree */
export interface DetachIssuePayload {
  worktreeId: string;
}
