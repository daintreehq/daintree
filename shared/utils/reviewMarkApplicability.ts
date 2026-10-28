import type { ReviewPointHead } from "../types/reviewPoint.js";

/**
 * Whether a worktree's review mark (#14584) still describes the worktree. A
 * mark belongs to the branch it was made on: once the worktree is on another
 * branch, or detached where the mark was on a branch (or the reverse), the mark
 * is reported, never applied. A worktree whose branch isn't known yet gets
 * `branch-unknown`, which applies nothing either.
 */
export type ReviewMarkApplicability = "applicable" | "branch-changed" | "branch-unknown";

export interface ReviewMarkWorktreeHead {
  /** The branch checked out, without `refs/heads/`; absent when detached. */
  branch?: string;
  isDetached?: boolean;
}

export function reviewMarkApplicability(
  markHead: ReviewPointHead,
  worktree: ReviewMarkWorktreeHead
): ReviewMarkApplicability {
  if (worktree.isDetached === true) {
    return markHead.kind === "detached" ? "applicable" : "branch-changed";
  }
  if (typeof worktree.branch !== "string" || worktree.branch.length === 0) {
    return "branch-unknown";
  }
  if (markHead.kind === "detached") return "branch-changed";
  return markHead.branch === worktree.branch ? "applicable" : "branch-changed";
}
