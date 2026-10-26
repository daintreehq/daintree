import type { ReviewComparisonResult } from "@shared/types/reviewComparison";
import type { WorktreeReviewMark } from "@/store/reviewMarksStore";
import { pluralize } from "./pluralize";

/** What the worktree card has observed of a worktree, beside a mark made earlier (#14588). */
export interface ReviewChangeObservation {
  headOid?: string | null;
  /** Newest file modification time the host has seen, epoch ms. */
  latestFileMtime?: number | null;
  lastActivityTimestamp?: number | null;
}

export const CHANGED_SINCE_REVIEW = "Changed since review";

/**
 * The line a reviewed worktree's card shows once Daintree has observed it move
 * on, or null. A positive signal only: null says nothing was observed, never
 * that nothing changed or that the work is reviewed. The mark's own clock is
 * the host's, as are the times observed.
 *
 * A count comes only from a complete comparison of the current state; every
 * other input yields the plain hint.
 */
export function reviewChangeHint(
  reviewMark: WorktreeReviewMark | null,
  observed: ReviewChangeObservation,
  comparison?: ReviewComparisonResult | null
): string | null {
  if (!reviewMark || reviewMark.applicability !== "applicable") return null;
  const { mark } = reviewMark;

  if (comparison?.state === "comparable") {
    const changed = comparison.files.filter(
      (file) => file.index !== "unchanged" || file.worktree !== "unchanged"
    );
    const wholeFiles = changed.every((f) => f.index !== "unknown" && f.worktree !== "unknown");
    if (changed.length > 0 && wholeFiles && comparison.commits.kind === "listed") {
      return `${pluralize(changed.length, "file")} since review`;
    }
    if (changed.length > 0) return CHANGED_SINCE_REVIEW;
    if (comparison.commits.kind !== "listed" || comparison.commits.commits.length > 0) {
      return CHANGED_SINCE_REVIEW;
    }
    return null;
  }
  if (comparison && comparison.state !== "different-branch" && comparison.state !== "failed") {
    return CHANGED_SINCE_REVIEW;
  }

  const reviewedCommit = mark.head.kind === "unborn" ? null : mark.head.commit;
  if (observed.headOid && observed.headOid !== reviewedCommit) return CHANGED_SINCE_REVIEW;

  const activity = Math.max(observed.latestFileMtime ?? 0, observed.lastActivityTimestamp ?? 0);
  if (activity > mark.capturedAt) return CHANGED_SINCE_REVIEW;
  return null;
}
