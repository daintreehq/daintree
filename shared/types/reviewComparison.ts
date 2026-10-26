import type {
  ReviewPointGapReason,
  ReviewPointGitEntry,
  ReviewPointHead,
  ReviewPointIncompleteReason,
  ReviewPointIndexIdentity,
  ReviewPointWorktreeIdentity,
} from "./reviewPoint.js";

/**
 * What changed in a worktree since a review point (#14583): the files whose
 * index or working tree differs from what the point recorded, and the commits
 * that arrived. Observations only: "changed" is a fact about content, never a
 * claim about whether anything was reviewed.
 */

/** One path as one side of the comparison knows it. */
export type ReviewComparisonSide =
  /** The path as that capture listed it. */
  | {
      kind: "listed";
      head: ReviewPointGitEntry | null;
      index: ReviewPointIndexIdentity;
      worktree: ReviewPointWorktreeIdentity;
    }
  /**
   * Outside that capture's change set: HEAD, the index and the working tree all
   * held this entry, as git compares them. Null when none of them had the path.
   */
  | { kind: "unlisted"; entry: ReviewPointGitEntry | null }
  /** That side couldn't cover the path, so nothing is known about it. */
  | { kind: "uncovered"; reason: ReviewPointIncompleteReason | "reviewed-state-unavailable" };

export type ReviewComparisonChange = "unchanged" | "changed" | "unknown";

export interface ReviewComparisonFile {
  /** As in a review point: exact unless `pathBytes` carries the bytes. */
  path: string;
  pathBytes?: string;
  status: "added" | "deleted" | "modified" | "unknown";
  /**
   * Whether the index holds content it didn't at review. An index that now
   * holds what the working tree held then (the reviewed edit staged or
   * committed) is unchanged.
   */
  index: ReviewComparisonChange;
  worktree: ReviewComparisonChange;
  /**
   * The part the base the branch is compared against played. `only`: outside
   * the branch's change set at both points, so it differs only because that
   * base moved. `also`: the base update changed this path and the branch
   * touches it too, so the change may hold both. `none`: the base update didn't
   * touch it, or the base didn't move. `unknown`: there was nothing to tell by.
   */
  baseUpdate: "only" | "also" | "none" | "unknown";
  reviewed: ReviewComparisonSide;
  current: ReviewComparisonSide;
}

export interface ReviewComparisonCommit {
  oid: string;
  parents: string[];
  subject: string;
  authorName: string;
  authorEmail: string;
  /** Epoch ms. */
  authoredAt: number;
  /** `patch-equivalent`: its change is the same as a reviewed commit's, whatever its message. */
  kind: "new" | "patch-equivalent";
}

export type ReviewComparisonCommits =
  | {
      kind: "listed";
      /**
       * `extended`: HEAD descends from the reviewed commit. `rewritten`: the
       * reviewed commit still exists but is no longer in HEAD's history.
       */
      history: "extended" | "rewritten";
      /** Newest first, without the base's own history. */
      commits: ReviewComparisonCommit[];
      /** More commits arrived than are listed. */
      truncated: boolean;
    }
  | {
      kind: "unavailable";
      /**
       * `limit`: listing them ran past the comparison's limits. `unreadable`:
       * git couldn't walk the whole history, as in a shallow or partial clone.
       * `base-unavailable`: the base the point was compared against no longer
       * resolves, so history merged in from it can't be told apart.
       */
      reason: "reviewed-commit-missing" | "limit" | "unreadable" | "base-unavailable";
    };

export const REVIEW_COMPARISON_INCOMPLETE_REASONS = [
  /** The review point itself didn't cover everything. */
  "reviewed-point-incomplete",
  /** The current state couldn't be captured in full. */
  "current-state-incomplete",
  /**
   * Neither the reviewed commit nor the base it was compared against still
   * exists, so paths outside the reviewed change set can't be compared.
   */
  "reviewed-state-unavailable",
  /** A listing the comparison needed was larger than its limits allow. */
  "change-set-too-large",
  /** More files differ than are listed. */
  "path-limit",
  /** The commit list couldn't be read, though the reviewed commit exists. */
  "commits-unavailable",
] as const;

export type ReviewComparisonIncompleteReason =
  (typeof REVIEW_COMPARISON_INCOMPLETE_REASONS)[number];

/** A path or subtree one side couldn't cover, as that side's point named it. */
export interface ReviewComparisonGap {
  path: string;
  pathBytes?: string;
  side: "reviewed" | "current";
  reason: ReviewPointGapReason;
}

interface ReviewComparisonCompared {
  /** Epoch ms when the current state was captured. */
  comparedAt: number;
  head: ReviewPointHead;
  base: {
    /** The base tip and merge bases the review point was captured against. */
    reviewed: { ref: string | null; tip: string | null; mergeBases: string[] };
    current: { ref: string | null; tip: string | null; mergeBases: string[] };
  };
  /** Sorted by path bytes; every path that differs or can't be shown not to. */
  files: ReviewComparisonFile[];
  commits: ReviewComparisonCommits;
}

export type ReviewComparisonFailure =
  | "not-a-repository"
  | "invalid-request"
  /** Not a review point, or one taken in another worktree or repository. */
  | "invalid-review-point"
  | "cancelled"
  /** A newer comparison of the same worktree replaced this one. */
  | "superseded"
  | "deadline"
  /** The worktree moved while it was being read; nothing mixed is returned. */
  | "changed-during-compare"
  | "git-failed";

export type ReviewComparisonResult =
  /** A complete comparison: the only state that can say nothing changed. */
  | ({ state: "comparable" } & ReviewComparisonCompared)
  /** Files are complete; the commit list isn't available. */
  | ({ state: "reviewed-commit-missing" } & ReviewComparisonCompared)
  /** Every listed file did change or couldn't be checked, but more may have. */
  | ({
      state: "incomplete";
      reasons: ReviewComparisonIncompleteReason[];
      /** Listed up to a cap. */
      gaps: ReviewComparisonGap[];
    } & ReviewComparisonCompared)
  /** The point was taken on another branch; it says nothing about this one. */
  | { state: "different-branch"; reviewed: ReviewPointHead; current: ReviewPointHead }
  | { state: "failed"; reason: ReviewComparisonFailure; message: string };
