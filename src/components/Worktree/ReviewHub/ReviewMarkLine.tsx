import { RefreshCw, X } from "lucide-react";
import { BookmarkCheck } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
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
  /**
   * The hub is showing Since review: the line names what that view compares,
   * and the view itself owns the counts and every recovery.
   */
  inSinceReview: boolean;
  onClear: () => void;
  onRetry: () => void;
  onOpenSinceReview: () => void;
  /** Open one file's diff since review; `trigger` gets focus back when it closes. */
  onOpenFile: (path: string, trigger: HTMLElement) => void;
  onDismissNotice: () => void;
}

/** Not-covered files named by button before the rest collapse into a count. */
const NOTICE_FILES = 3;

const LINE_ACTION_CLASS =
  "shrink-0 inline-flex items-center gap-1 text-text-secondary hover:text-text-primary";

/**
 * The quiet line under Review Hub's header once a worktree has a review mark
 * (#14585): when, at which commit, and how much is new since. Right after a
 * mark is recorded, what changed after the hub read the worktree, and so isn't
 * covered by it, takes over from the counts in one notice below the line.
 */
export function ReviewMarkLine({
  reviewMark,
  comparison,
  notice,
  isRecording,
  isClearing,
  inSinceReview,
  onClear,
  onRetry,
  onOpenSinceReview,
  onOpenFile,
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
  const anchor =
    inSinceReview && applicability === "applicable" ? (
      <>
        Since your review {at}, <TimeAgo timestamp={mark.markedAt} />
      </>
    ) : (
      <>
        Reviewed <TimeAgo timestamp={mark.markedAt} /> {at}
      </>
    );
  // In Since review the view below owns the result; right after marking, the
  // check (and then its notice) owns it, so the counts never say it twice.
  const showNotice = notice !== null && !inSinceReview;
  const result = inSinceReview
    ? null
    : isRecording
      ? "Checking what changed after Review Hub read the worktree…"
      : showNotice
        ? null
        : view.kind === "comparing"
          ? "Comparing…"
          : view.kind === "nothing-new"
            ? "No changes since your review"
            : view.kind === "other-branch"
              ? mark.head.kind === "detached"
                ? "Marked on a detached HEAD, not this branch"
                : `Marked on ${mark.head.branch}, not this branch`
              : view.kind === "branch-unknown"
                ? "Waiting for the worktree's branch"
                : view.text;
  // Only where Since review would show something to review: a comparison it
  // can't make is said here, and the view would only say it again.
  const canReview =
    !inSinceReview &&
    !isRecording &&
    !showNotice &&
    applicability === "applicable" &&
    (view.kind === "counts" || view.kind === "incomplete");
  const canRetry = !inSinceReview && !isRecording && view.kind === "failed";
  // Since review's own banner offers Clear for a mark from another branch.
  const showClear = !(inSinceReview && applicability === "branch-changed");

  return (
    <>
      <div className="@container/mark-line border-b border-divider">
        <div
          className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 min-w-0 px-3 py-1.5 text-xs text-text-secondary"
          data-testid="review-hub-review-mark"
        >
          <BookmarkCheck className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 @[30rem]/mark-line:flex-none truncate">{anchor}</span>
          {result !== null && (
            <span
              className={cn(
                "flex min-w-0 items-center gap-1.5",
                // Narrow: the result gets a row of its own, under the anchor,
                // rather than being the first thing truncated away.
                "order-2 basis-full pl-5 @[30rem]/mark-line:order-none @[30rem]/mark-line:basis-auto @[30rem]/mark-line:pl-0 @[30rem]/mark-line:flex-1"
              )}
            >
              <span aria-hidden="true" className="hidden @[30rem]/mark-line:inline">
                ·
              </span>
              <span
                className="truncate"
                role="status"
                aria-live="polite"
                data-testid="review-hub-review-mark-since"
                data-state={isRecording ? "recording" : view.kind}
              >
                {result}
              </span>
              {(canRetry || canReview) && (
                <span aria-hidden="true" className="shrink-0">
                  ·
                </span>
              )}
              {canRetry && (
                <Button
                  variant="link"
                  className="shrink-0"
                  onClick={onRetry}
                  data-testid="review-hub-review-mark-retry"
                >
                  <RefreshCw aria-hidden="true" />
                  Retry
                </Button>
              )}
              {canReview && (
                <Button
                  variant="link"
                  className="shrink-0"
                  onClick={onOpenSinceReview}
                  data-testid="review-hub-review-mark-open"
                >
                  Review changes
                </Button>
              )}
            </span>
          )}
          {showClear && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className={cn(LINE_ACTION_CLASS, "ml-auto")}
                  onClick={onClear}
                  aria-label="Clear review mark"
                  aria-disabled={isClearing || undefined}
                  aria-busy={isClearing || undefined}
                  data-testid="review-hub-review-mark-clear"
                >
                  <X className="size-3" aria-hidden="true" />
                  <span aria-hidden="true" className="hidden @[30rem]/mark-line:inline">
                    {isClearing ? "Clearing…" : "Clear review mark"}
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Clear review mark</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
      {showNotice && (
        <MarkNotice
          notice={notice}
          onOpenSinceReview={onOpenSinceReview}
          onOpenFile={onOpenFile}
          onDismiss={onDismissNotice}
        />
      )}
    </>
  );
}

function MarkNotice({
  notice,
  onOpenSinceReview,
  onOpenFile,
  onDismiss,
}: {
  notice: ReviewMarkNotice;
  onOpenSinceReview: () => void;
  onOpenFile: ReviewMarkLineProps["onOpenFile"];
  onDismiss: () => void;
}) {
  if (notice.kind !== "not-covered") {
    return (
      <InlineStatusBanner
        severity="info"
        role="status"
        ariaLive="polite"
        title={
          notice.kind === "other-branch"
            ? "The worktree moved to another branch"
            : "Couldn't check what the mark covers"
        }
        description={
          notice.kind === "other-branch"
            ? "The mark is saved for the branch you marked."
            : "The mark is saved, but Review Hub couldn't check whether anything changed after it read the worktree."
        }
        action={
          notice.kind === "unchecked"
            ? {
                id: "review-hub-review-mark-notice-review",
                label: "Review changes",
                onClick: onOpenSinceReview,
              }
            : undefined
        }
        onClose={onDismiss}
        data-testid="review-hub-review-mark-notice"
      />
    );
  }
  const shown = notice.openablePaths.slice(0, NOTICE_FILES);
  const more = notice.paths.length - shown.length;
  return (
    <InlineStatusBanner
      severity="warning"
      role="status"
      ariaLive="polite"
      layout="pane"
      title="Not covered by this mark"
      description={describeNotCovered(notice)}
      descriptionExtras={
        shown.length > 0 ? (
          <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            {shown.map((path) => (
              <NotCoveredFile key={path} path={path} onOpen={onOpenFile} />
            ))}
            {more > 0 && (
              <span className="text-xs text-text-secondary">{`and ${pluralize(more, "more file")}`}</span>
            )}
          </span>
        ) : undefined
      }
      action={{
        id: "review-hub-review-mark-notice-review",
        label: "Review changes",
        onClick: onOpenSinceReview,
      }}
      onClose={onDismiss}
      data-testid="review-hub-review-mark-notice"
    />
  );
}

function NotCoveredFile({
  path,
  onOpen,
}: {
  path: string;
  onOpen: ReviewMarkLineProps["onOpenFile"];
}) {
  const normalized = path.replace(/\\/g, "/");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="link"
          className="font-mono text-2xs"
          aria-label={`Open diff since review: ${path}`}
          onClick={(event) => onOpen(path, event.currentTarget)}
          data-testid="review-hub-review-mark-notice-file"
        >
          {name}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{path}</TooltipContent>
    </Tooltip>
  );
}
