import { RefreshCw, X } from "lucide-react";
import { BookmarkCheck } from "@/components/icons";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import type { ReviewMarkCompareOutcome } from "@shared/types/ipc/reviewMarks";
import type { WorktreeReviewMark } from "@/store/reviewMarksStore";
import {
  describeNotCovered,
  describeReviewMarkComparison,
  type ReviewMarkNotice,
} from "./reviewMarkComparison";

interface ReviewMarkLineProps {
  reviewMark: WorktreeReviewMark | null;
  comparison: ReviewMarkCompareOutcome | null;
  notice: ReviewMarkNotice | null;
  /** The mark was just recorded and its first comparison hasn't landed. */
  isRecording: boolean;
  isClearing: boolean;
  onClear: () => void;
  onRetry: () => void;
  onDismissNotice: () => void;
}

/**
 * The quiet line under Review Hub's header once a worktree has a review mark
 * (#14585): when, at which commit, and how much is new since. Below it, once a
 * mark is recorded, what changed after the hub read the worktree and so isn't
 * covered by it.
 */
export function ReviewMarkLine({
  reviewMark,
  comparison,
  notice,
  isRecording,
  isClearing,
  onClear,
  onRetry,
  onDismissNotice,
}: ReviewMarkLineProps) {
  if (!reviewMark) return null;
  const { mark, applicability } = reviewMark;
  const view = describeReviewMarkComparison(applicability, comparison);
  const at =
    mark.head.kind === "unborn" ? (
      <span>on an unborn branch</span>
    ) : (
      <span>
        at <span className="font-mono text-text-primary">{mark.head.commit.slice(0, 7)}</span>
      </span>
    );
  const since =
    view.kind === "comparing"
      ? "Comparing…"
      : view.kind === "nothing-new"
        ? "Nothing new since review"
        : view.kind === "other-branch"
          ? mark.head.kind === "detached"
            ? "Marked on a detached HEAD, not this branch"
            : `Marked on ${mark.head.branch}, not this branch`
          : view.kind === "branch-unknown"
            ? "The worktree's branch isn't known yet"
            : view.text;

  return (
    <>
      <div
        className="flex items-center gap-1.5 min-w-0 px-3 py-1.5 border-b border-divider text-xs text-text-secondary"
        data-testid="review-hub-review-mark"
      >
        <BookmarkCheck className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="shrink-0">
          Reviewed <TimeAgo timestamp={mark.markedAt} /> {at}
        </span>
        <span className="shrink-0" aria-hidden="true">
          ·
        </span>
        <span
          className="truncate"
          role="status"
          aria-live="polite"
          data-testid="review-hub-review-mark-since"
          data-state={view.kind}
        >
          {since}
        </span>
        {view.kind === "failed" && (
          <button
            type="button"
            className="shrink-0 inline-flex items-center gap-1 text-text-secondary hover:text-text-primary"
            onClick={onRetry}
            data-testid="review-hub-review-mark-retry"
          >
            <RefreshCw className="size-3" aria-hidden="true" />
            <span>Retry</span>
          </button>
        )}
        <button
          type="button"
          className="ml-auto shrink-0 inline-flex items-center gap-1 text-text-secondary hover:text-text-primary"
          onClick={onClear}
          aria-disabled={isClearing || undefined}
          data-testid="review-hub-review-mark-clear"
        >
          <X className="size-3" aria-hidden="true" />
          <span>Clear review mark</span>
        </button>
      </div>
      {isRecording && (
        <p
          className="px-3 py-1.5 border-b border-divider text-xs text-text-secondary"
          role="status"
          data-testid="review-hub-review-mark-recording"
        >
          Marked reviewed. Checking what changed after Review Hub read the worktree…
        </p>
      )}
      {notice && (
        <InlineStatusBanner
          severity={notice.kind === "other-branch" ? "info" : "warning"}
          role="status"
          ariaLive="polite"
          title={
            notice.kind === "not-covered"
              ? "Marked reviewed, except what changed after Review Hub read it"
              : "Marked reviewed"
          }
          description={
            notice.kind === "not-covered"
              ? describeNotCovered(notice)
              : notice.kind === "other-branch"
                ? "The worktree has since moved to another branch."
                : "Review Hub couldn't check whether anything changed after it read the worktree."
          }
          onClose={onDismissNotice}
          data-testid="review-hub-review-mark-notice"
        />
      )}
    </>
  );
}
