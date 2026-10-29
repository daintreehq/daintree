import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { SegmentedRadioGroup } from "@/components/ui/SegmentedRadioGroup";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { useReviewMarksStore } from "@/store/reviewMarksStore";
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
  /**
   * Null when the diff below is exactly the change since review: a quiet line
   * names it then, rather than a banner announcing the normal case.
   */
  banner: { severity: "info" | "warning"; title: string; description?: string } | null;
  /** Nothing below the notice is a diff of this file, so the viewer stands down. */
  replacesBody: boolean;
}

/** The hub's names for the two sides: its "Working tree" mode and its "Staged" section. */
const SIDE_LABEL: Record<ReviewFileSinceSide, string> = {
  worktree: "Working tree",
  index: "Staged",
};

const SIDE_VERSION: Record<ReviewFileSinceSide, string> = {
  worktree: "The working tree version",
  index: "The staged version",
};

const UNAVAILABLE_REASON: Record<ReviewFileSinceUnavailableReason, string> = {
  "reviewed-content-missing":
    "Git no longer has the version you reviewed: it only lived in the working tree, or has been cleaned up.",
  "reviewed-not-covered": "Your review mark didn't record this file's content.",
  "reviewed-not-raw":
    "Line-ending or filter settings change how git stores this file, so the exact version you reviewed wasn't kept.",
  "current-unreadable": "The current file couldn't be read the way the comparison saw it.",
};

const MODE_NAME: Record<string, string> = {
  "100644": "a regular file",
  "100755": "an executable file",
  "120000": "a symbolic link",
  "160000": "a submodule",
};

/** A git file mode change in words: the executable bit, or what kind of entry it is. */
function describeModeChange(
  from: string | null,
  to: string | null
): { title: string; description: string } {
  if (from === "100644" && to === "100755") {
    return {
      title: "Made executable since your review",
      description: "The content hasn't changed.",
    };
  }
  if (from === "100755" && to === "100644") {
    return {
      title: "No longer executable since your review",
      description: "The content hasn't changed.",
    };
  }
  const name = (mode: string | null) =>
    mode === null ? "nothing" : (MODE_NAME[mode] ?? `mode ${mode}`);
  return {
    title: "File type changed since your review",
    description: `It was ${name(from)} and is now ${name(to)}. The content hasn't changed.`,
  };
}

export function describeSinceReviewNotice(
  outcome: ReviewMarkFileSinceOutcome
): SinceReviewNoticeView {
  switch (outcome.status) {
    case "none":
      return {
        banner: {
          severity: "info",
          title: "No review mark",
          description: "Mark this worktree reviewed in Review & commit to compare with it later.",
        },
        replacesBody: true,
      };
    case "unavailable":
      return {
        banner: {
          severity: "warning",
          title: "Can't compare this file with your review",
          description: "The review mark or the worktree couldn't be read in full.",
        },
        replacesBody: true,
      };
    case "not-changed":
      return {
        banner: {
          severity: "info",
          title: "No changes since your review",
          description: "This file holds what it held when you marked the worktree reviewed.",
        },
        replacesBody: true,
      };
    case "read":
      break;
  }
  const { view } = outcome;
  switch (view.kind) {
    case "unchanged":
      return {
        banner: {
          severity: "info",
          title: `${SIDE_VERSION[outcome.side]} hasn't changed since your review`,
        },
        replacesBody: true,
      };
    case "exact":
    case "binary":
    case "too-large":
      return { banner: null, replacesBody: false };
    case "mode-only":
      return {
        banner: { severity: "info", ...describeModeChange(view.from, view.to) },
        replacesBody: true,
      };
    case "empty-file":
      return {
        banner: {
          severity: "info",
          title: `Empty file ${view.change} since your review`,
          description: "There are no lines to show.",
        },
        replacesBody: true,
      };
    case "unsupported":
      return {
        banner: {
          severity: "info",
          title: "Nothing to compare for this file",
          description:
            "This version has no file content to compare: it's a submodule, a conflicted staged entry, or a file only marked to add.",
        },
        replacesBody: true,
      };
    case "unavailable": {
      const reason = UNAVAILABLE_REASON[view.reason];
      if (view.standIn) {
        // The baseline leads: this diff is easy to read as the change since
        // review, and it isn't one.
        return {
          banner: {
            severity: "warning",
            title: `Showing changes since commit ${view.standIn.commit.slice(0, 7)}`,
            description: `${reason} This diff is against the reviewed commit instead, so it may include changes you'd already seen.`,
          },
          replacesBody: false,
        };
      }
      return {
        banner: {
          severity: "warning",
          title: "Can't show the change since your review",
          description: `${reason} ${
            view.changed
              ? "The file has changed since your review."
              : "Whether it changed since your review couldn't be told."
          }`,
        },
        replacesBody: true,
      };
    }
  }
}

/**
 * Whether reading again could change the answer: the host couldn't read the
 * comparison, or couldn't read the current file. A reviewed version that's
 * gone or never kept stays gone, so it gets no Retry.
 */
function isRetryable(outcome: ReviewMarkFileSinceOutcome): boolean {
  if (outcome.status === "unavailable") return true;
  return (
    outcome.status === "read" &&
    outcome.view.kind === "unavailable" &&
    outcome.view.reason === "current-unreadable"
  );
}

interface SinceReviewNoticeProps {
  outcome: ReviewMarkFileSinceOutcome;
  view: SinceReviewNoticeView;
  worktreeId: string | undefined;
  onSideChange: (side: ReviewFileSinceSide) => void;
  /** Read the comparison again; offered when the host couldn't read it. */
  onRetry: () => void;
}

export function SinceReviewNotice({
  outcome,
  view,
  worktreeId,
  onSideChange,
  onRetry,
}: SinceReviewNoticeProps) {
  const mark = useReviewMarksStore((state) =>
    worktreeId && Object.hasOwn(state.marks, worktreeId) ? state.marks[worktreeId] : undefined
  );
  // Both changed, or the chosen side went back to its reviewed state while the
  // other kept a change: either way the other side has to stay reachable.
  const bothSides =
    outcome.status === "read" &&
    ((outcome.changes.worktree !== "unchanged" && outcome.changes.index !== "unchanged") ||
      outcome.changes[outcome.side] === "unchanged");
  const provenance = view.banner === null;
  return (
    <div data-testid="since-review-notice">
      {view.banner && (
        <InlineStatusBanner
          severity={view.banner.severity}
          role="status"
          ariaLive="polite"
          title={view.banner.title}
          description={view.banner.description}
          action={
            isRetryable(outcome)
              ? { id: "since-review-notice-retry", label: "Retry", onClick: onRetry }
              : undefined
          }
          data-testid="since-review-notice-banner"
        />
      )}
      {(provenance || bothSides) && outcome.status === "read" && (
        <div
          className="flex items-center gap-2 min-h-8 px-3 py-1 border-b border-divider text-xs text-text-secondary"
          data-testid="since-review-notice-row"
        >
          {provenance && (
            <span className="min-w-0 flex-1 truncate" data-testid="since-review-provenance">
              {!bothSides && outcome.side === "index" ? "Staged changes since" : "Since"} your
              review
              {mark && mark.head.kind !== "unborn" && (
                <>
                  {" "}
                  at{" "}
                  <span className="font-mono text-text-primary">
                    {mark.head.commit.slice(0, 7)}
                  </span>
                  , <TimeAgo timestamp={mark.markedAt} />
                </>
              )}
            </span>
          )}
          {bothSides && (
            <SegmentedRadioGroup<ReviewFileSinceSide>
              aria-label="Version compared with your review"
              density="compact"
              testId="since-review-side"
              value={outcome.side}
              onChange={onSideChange}
              options={[
                { value: "worktree", label: SIDE_LABEL.worktree },
                { value: "index", label: SIDE_LABEL.index },
              ]}
            />
          )}
        </div>
      )}
    </div>
  );
}
