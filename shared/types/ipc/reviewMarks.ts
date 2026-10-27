import type { ReviewComparisonResult } from "../reviewComparison.js";
import type { ReviewPointCaptureFailure, ReviewPointHead } from "../reviewPoint.js";

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
  | { status: "unavailable"; snapshot: ReviewMarksSnapshot }
  /** The capture named is no longer held on the host. Nothing saved. */
  | { status: "expired"; snapshot: ReviewMarksSnapshot };

export type ReviewMarkClearOutcome =
  /** Also the answer when there was no mark to clear. */
  | { status: "cleared"; snapshot: ReviewMarksSnapshot }
  /** The mark changed after the revision the caller named. Nothing cleared. */
  | { status: "stale"; snapshot: ReviewMarksSnapshot };

/**
 * What Review Hub holds of a capture it took while reading a worktree (#14585).
 * The review point stays on the host; marking the worktree reviewed names the
 * capture by its id.
 */
export interface ReviewMarkCapture {
  captureId: string;
  /** Epoch ms on the host when the capture finished. */
  capturedAt: number;
  head: ReviewPointHead;
  /** Whether the point covers its whole change set. */
  complete: boolean;
  pathCount: number;
}

export type ReviewMarkCaptureOutcome =
  | { status: "captured"; capture: ReviewMarkCapture }
  /** The worktree moved while it was read; nothing mixed is held. */
  | { status: "changed-during-capture" }
  /** The host couldn't find the worktree. */
  | { status: "unavailable" }
  /** The capture is larger than a mark can keep. */
  | { status: "too-large" }
  | { status: "failed"; reason: ReviewPointCaptureFailure; message: string };

export type ReviewMarkCompareOutcome =
  /** The worktree has no mark. */
  | { status: "none" }
  /** The mark's review point, or the worktree, couldn't be read on the host. */
  | { status: "unavailable"; markRevision: number }
  /** The comparison is larger than one reply carries. */
  | { status: "too-large"; markRevision: number }
  /** `markRevision` is the revision of the mark the result compares against. */
  | { status: "compared"; markRevision: number; result: ReviewComparisonResult };

/** The two places a file's content can differ since the review: the index and the working tree. */
export type ReviewFileSinceSide = "worktree" | "index";

/** What a diff since review is set against, when it isn't the reviewed version. */
export interface ReviewFileSinceStandIn {
  /** The commit the review point was taken at; its version of the file is the old side. */
  commit: string;
  patch: string;
}

export type ReviewFileSinceUnavailableReason =
  /** Git no longer has the reviewed content: it only ever lived in the working tree, or was collected. */
  | "reviewed-content-missing"
  /** The point didn't cover this path, or held no content for it to compare. */
  | "reviewed-not-covered"
  /** Only known as git compares it, and line-ending or filter settings apply to this file. */
  | "reviewed-not-raw"
  /** The current content couldn't be read as the comparison saw it. */
  | "current-unreadable";

export type ReviewFileSinceView =
  /** The side holds what it held at review. */
  | { kind: "unchanged" }
  /** Exactly the reviewed content against the current one. */
  | { kind: "exact"; patch: string }
  | { kind: "mode-only"; from: string | null; to: string | null }
  /** An empty file was added or deleted: there are no lines to show. */
  | { kind: "empty-file"; change: "added" | "deleted" }
  | { kind: "binary" }
  | { kind: "too-large" }
  /** A submodule, a conflicted or intent-to-add index entry: no file content to compare. */
  | { kind: "unsupported" }
  | {
      kind: "unavailable";
      reason: ReviewFileSinceUnavailableReason;
      /** Whether the comparison found this side's content changed. */
      changed: boolean;
      /** Never the change since review; the panel labels it as what it is. */
      standIn: ReviewFileSinceStandIn | null;
    };

export interface ReviewFileSinceRequest {
  path: string;
  /** Base64 of the path bytes when they aren't valid UTF-8, as a review point spells them. */
  pathBytes?: string;
  /** Absent: the working tree when it changed, else the index. */
  side?: ReviewFileSinceSide;
}

export type ReviewMarkFileSinceOutcome =
  /** The worktree has no mark. */
  | { status: "none" }
  /** The mark, the worktree or the comparison couldn't be read. */
  | { status: "unavailable"; markRevision: number }
  /** The comparison no longer lists the file, or lists it as unchanged on both sides. */
  | { status: "not-changed"; markRevision: number }
  | {
      status: "read";
      markRevision: number;
      side: ReviewFileSinceSide;
      /** What the comparison found for each side. */
      changes: Record<ReviewFileSinceSide, "unchanged" | "changed" | "unknown">;
      view: ReviewFileSinceView;
    };
