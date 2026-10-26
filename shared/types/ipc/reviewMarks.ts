import type { ReviewPointHead } from "../reviewPoint.js";

/**
 * What every view of a project holds of one worktree's review mark (#14584).
 * The review point itself stays on the host: one can run to megabytes, and the
 * comparisons that read it run beside the repository.
 */
export interface ReviewMarkSummary {
  /** Epoch ms on the host when the mark was saved. */
  markedAt: number;
  /** Epoch ms when the acknowledged review point was captured. */
  capturedAt: number;
  head: ReviewPointHead;
  base: { ref: string | null; tip: string | null };
  /** Whether the point covers its whole change set. */
  complete: boolean;
  /** Paths the point lists. */
  pathCount: number;
  /** The marks revision this mark was written at. */
  revision: number;
}

/** The sender project's review marks, as the host holds them. */
export interface ReviewMarksSnapshot {
  projectId: string;
  /** Worktree id → its mark. A worktree with none is absent. */
  marks: Record<string, ReviewMarkSummary>;
  /**
   * Bumped on every write. A view drops a snapshot older than the one it holds,
   * and names the one it holds when it writes, so a write that started before
   * a newer one can't undo it.
   */
  revision: number;
}

/** What the review point names that the worktree it would be stored against doesn't match. */
export type ReviewMarkMismatch = "repository" | "worktree" | "branch";

export type ReviewMarkSaveOutcome =
  | { status: "saved"; snapshot: ReviewMarksSnapshot }
  /**
   * The worktree's mark was set or cleared after the revision the caller
   * named. Nothing saved.
   */
  | { status: "stale"; snapshot: ReviewMarksSnapshot }
  | { status: "mismatch"; reason: ReviewMarkMismatch; snapshot: ReviewMarksSnapshot }
  /** The host couldn't confirm the worktree, so nothing was saved. */
  | { status: "unavailable"; snapshot: ReviewMarksSnapshot };

export type ReviewMarkClearOutcome =
  /** Also the answer when there was no mark to clear. */
  | { status: "cleared"; snapshot: ReviewMarksSnapshot }
  /** The mark changed after the revision the caller named. Nothing cleared. */
  | { status: "stale"; snapshot: ReviewMarksSnapshot };
