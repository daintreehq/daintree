import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { SegmentedRadioGroup } from "@/components/ui/SegmentedRadioGroup";
import type {
  ReviewFileSinceSide,
  ReviewFileSinceUnavailableReason,
  ReviewMarkFileSinceOutcome,
} from "@shared/types/ipc/reviewMarks";

/**
 * What a since-review diff says about itself (#14587). The patch under it is
 * only ever the change since review when the host calls it exact; anything
 * else is named for what it is here, so a diff against the reviewed commit
 * can't pass for the reviewed-to-current one.
 */
export interface SinceReviewNoticeView {
  severity: "info" | "warning";
  title: string;
  description?: string;
  /** Nothing below the notice is a diff of this file, so the viewer stands down. */
  replacesBody: boolean;
}

const SIDE_LABEL: Record<ReviewFileSinceSide, string> = {
  worktree: "Working tree",
  index: "Index",
};

const UNAVAILABLE_REASON: Record<ReviewFileSinceUnavailableReason, string> = {
  "reviewed-content-missing":
    "Git doesn't hold the version you reviewed: it only ever lived in the working tree, or it has been cleaned up.",
  "reviewed-not-covered": "The review didn't cover this file's content.",
  "current-unreadable": "The current file couldn't be read as the comparison saw it.",
};

export function describeSinceReviewNotice(
  outcome: ReviewMarkFileSinceOutcome
): SinceReviewNoticeView | null {
  switch (outcome.status) {
    case "none":
      return {
        severity: "info",
        title: "No review mark",
        description: "This worktree has no review mark to compare with.",
        replacesBody: true,
      };
    case "unavailable":
      return {
        severity: "warning",
        title: "Comparison unavailable",
        description: "The review mark or the worktree couldn't be read in full.",
        replacesBody: true,
      };
    case "not-changed":
      return {
        severity: "info",
        title: "No changes since your review",
        description: "This file holds what it held when you marked the worktree reviewed.",
        replacesBody: true,
      };
    case "read":
      break;
  }
  const side = SIDE_LABEL[outcome.side];
  const { view } = outcome;
  switch (view.kind) {
    case "unchanged":
      return {
        severity: "info",
        title: `${side}: no changes since your review`,
        replacesBody: true,
      };
    case "exact":
      return { severity: "info", title: `${side} since your review`, replacesBody: false };
    case "mode-only":
      return {
        severity: "info",
        title: `${side}: file mode changed since your review`,
        description: `From ${view.from ?? "none"} to ${view.to ?? "none"}.`,
        replacesBody: true,
      };
    case "binary":
    case "too-large":
      return { severity: "info", title: `${side} since your review`, replacesBody: false };
    case "unsupported":
      return {
        severity: "info",
        title: `${side}: no file content to compare`,
        description: "A submodule, or an index entry that is conflicted or intent-to-add.",
        replacesBody: true,
      };
    case "unavailable": {
      const outcomeText = view.changed
        ? "This file changed since your review."
        : "Whether this file changed since your review couldn't be told.";
      const standIn = view.standIn
        ? ` Showing the current version against the reviewed commit ${view.standIn.commit.slice(0, 7)}, not the change since your review.`
        : "";
      return {
        severity: "warning",
        title: `${side}: the reviewed version is unavailable`,
        description: `${UNAVAILABLE_REASON[view.reason]} ${outcomeText}${standIn}`,
        replacesBody: view.standIn === null,
      };
    }
  }
}

interface SinceReviewNoticeProps {
  outcome: ReviewMarkFileSinceOutcome;
  view: SinceReviewNoticeView;
  onSideChange: (side: ReviewFileSinceSide) => void;
}

export function SinceReviewNotice({ outcome, view, onSideChange }: SinceReviewNoticeProps) {
  const bothSides =
    outcome.status === "read" &&
    outcome.changes.worktree !== "unchanged" &&
    outcome.changes.index !== "unchanged";
  return (
    <div data-testid="since-review-notice">
      <InlineStatusBanner
        severity={view.severity}
        role="status"
        ariaLive="polite"
        title={view.title}
        description={view.description}
        data-testid="since-review-notice-banner"
      />
      {bothSides && outcome.status === "read" && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-divider">
          <SegmentedRadioGroup<ReviewFileSinceSide>
            aria-label="Compare the"
            density="compact"
            testId="since-review-side"
            value={outcome.side}
            onChange={onSideChange}
            options={[
              { value: "worktree", label: SIDE_LABEL.worktree },
              { value: "index", label: SIDE_LABEL.index },
            ]}
          />
        </div>
      )}
    </div>
  );
}
