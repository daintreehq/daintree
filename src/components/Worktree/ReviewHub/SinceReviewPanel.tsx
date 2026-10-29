import type { KeyboardEvent } from "react";
import { CircleCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { PathTail } from "@/components/ui/PathTail";
import { SECTION_LABEL_CLASS } from "@/components/ui/sectionLabel";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { useDohertyGate, useSkeletonDisplayFloor } from "@/hooks/useDeferredLoading";
import { useTruncationDetection } from "@/hooks/useTruncationDetection";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import type { ReviewComparisonCommit } from "@shared/types/reviewComparison";
import { ReviewHubListSkeleton } from "./ReviewHubListSkeleton";
import {
  getBaseBranchStatusConfig,
  REVIEW_HUB_COUNT_CHIP,
  REVIEW_HUB_SECTION_BAND,
  REVIEW_HUB_STICKY_BAND,
} from "./reviewHubUtils";
import type {
  SinceReviewCommitsView,
  SinceReviewFile,
  SinceReviewFileGroup,
  SinceReviewView,
} from "./reviewMarkComparison";

interface SinceReviewPanelProps {
  view: SinceReviewView;
  /** The branch the hub compares against ("vs main"), named where a base update is. */
  baseBranch: string;
  /** Drop the mark, for one made on another branch. */
  onClear: () => void;
  onRetry: () => void;
  /** Back to the working tree, where reviewing goes on without a comparison. */
  onShowWorkingTree: () => void;
  /** Open one file's diff since review; `trigger` gets focus back when it closes. */
  onOpenFile: (path: string, trigger: HTMLElement) => void;
}

const STATUS_LETTER: Record<SinceReviewFile["status"], string> = {
  added: "A",
  deleted: "D",
  modified: "M",
  unknown: "?",
};

const STATUS_NAME: Record<SinceReviewFile["status"], string> = {
  added: "added",
  deleted: "deleted",
  modified: "modified",
  unknown: "status unknown",
};

const BAND_NOTE_CLASS = "px-3 py-2 text-xs text-text-secondary";

const OPENABLE_ROW = '[data-testid="since-review-file-row"]:not(:disabled)';

/**
 * Up, Down, Home and End step through the file rows of both bands, as the
 * working-tree list moves its cursor, rather than leaving a long comparison
 * to one Tab stop per file.
 */
function moveRowFocus(event: KeyboardEvent<HTMLButtonElement>) {
  const { key, currentTarget } = event;
  if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return;
  const list = currentTarget.closest('[data-testid="since-review-listed"]');
  if (!list) return;
  const rows = Array.from(list.querySelectorAll<HTMLButtonElement>(OPENABLE_ROW));
  const index = rows.indexOf(currentTarget);
  const next =
    key === "Home" ? 0 : key === "End" ? rows.length - 1 : index + (key === "ArrowDown" ? 1 : -1);
  const row = rows[next];
  if (!row) return;
  event.preventDefault();
  // Scrolled by hand so the list's scroll padding keeps the row clear of
  // the sticky band above it.
  row.focus({ preventScroll: true });
  row.scrollIntoView({ block: "nearest" });
}

/**
 * Review Hub's "Since review" body (#14586): what the comparison against the
 * worktree's review mark found. A row opens that file's diff since review (#14587),
 * never the ordinary diff, which would pass for the change since review.
 */
export function SinceReviewPanel({
  view,
  baseBranch,
  onClear,
  onRetry,
  onShowWorkingTree,
  onOpenFile,
}: SinceReviewPanelProps) {
  const comparing = view.kind === "comparing";
  // Same gate and dwell as the vs-base list, so a fast comparison paints
  // nothing and a slow one never flashes its skeleton for a frame.
  const showSkeleton = useSkeletonDisplayFloor(useDohertyGate(comparing));
  if (comparing || showSkeleton) {
    return (
      <div data-testid="since-review-comparing" aria-busy={comparing || undefined}>
        {showSkeleton && (
          <ReviewHubListSkeleton label="Comparing with your review" onRetry={onRetry} />
        )}
      </div>
    );
  }

  const showWorkingTree = (
    <Button variant="ghost" size="sm" onClick={onShowWorkingTree}>
      Show working tree
    </Button>
  );

  switch (view.kind) {
    case "unavailable":
      return (
        <EmptyState
          variant="zero-data"
          scale="canvas"
          className="py-12"
          title={
            view.reason === "no-mark"
              ? "Mark this worktree reviewed to compare later"
              : "Review the working tree for now"
          }
          description={
            view.reason === "no-mark"
              ? "Since review lists what changes after the mark."
              : "Since review can compare once Review Hub knows this worktree's branch."
          }
          action={
            <Button variant="outline" size="sm" onClick={onShowWorkingTree}>
              Show working tree
            </Button>
          }
          rootAttributes={{ "data-testid": "since-review-unavailable" }}
        />
      );
    case "other-branch":
      return (
        <InlineStatusBanner
          severity="info"
          role="status"
          ariaLive="polite"
          title="Your review mark is from another branch"
          description={`It was made on ${view.markedOn ?? "a detached HEAD"}, so it says nothing about this branch. Clear it, then mark this branch reviewed.`}
          action={{ id: "since-review-clear", label: "Clear review mark", onClick: onClear }}
          trailingSlot={showWorkingTree}
          data-testid="since-review-other-branch"
        />
      );
    case "failed":
      return (
        <InlineStatusBanner
          severity="error"
          role="status"
          ariaLive="polite"
          title="Couldn't compare with your review"
          description={view.detail ?? undefined}
          action={{ id: "since-review-retry", label: "Retry", onClick: onRetry }}
          trailingSlot={showWorkingTree}
          data-testid="since-review-failed"
        />
      );
    case "unreadable":
      return (
        <InlineStatusBanner
          severity="warning"
          role="status"
          ariaLive="polite"
          title={
            view.cause === "too-large"
              ? "Too many changes to compare"
              : "Can't read the state you reviewed"
          }
          description={
            view.cause === "too-large"
              ? "There's more since your review than one comparison can carry. Review the working tree, then update the review mark."
              : "Review Hub couldn't read what you marked reviewed. Review the working tree, then update the review mark."
          }
          action={{
            id: "since-review-show-working-tree",
            label: "Show working tree",
            onClick: onShowWorkingTree,
          }}
          trailingSlot={
            view.cause === "unavailable" ? (
              <Button variant="ghost" size="sm" onClick={onRetry}>
                Retry
              </Button>
            ) : undefined
          }
          data-testid="since-review-unreadable"
        />
      );
    case "empty":
      return (
        <EmptyState
          variant="user-cleared"
          scale="canvas"
          className="py-12"
          icon={<CircleCheck />}
          title="No changes since your review"
          rootAttributes={{ "data-testid": "since-review-empty" }}
        />
      );
    case "listed": {
      const own = view.files.filter((file) => file.group === "branch");
      const baseUpdate = view.files.filter((file) => file.group === "base-update");
      return (
        <div className="@container/since-review" data-testid="since-review-listed">
          {view.incomplete && (
            <InlineStatusBanner
              severity="warning"
              role="status"
              ariaLive="polite"
              title="Some changes may not be listed"
              description={view.incomplete.join(" ")}
              data-testid="since-review-incomplete"
            />
          )}
          <CommitsSection commits={view.commits} />
          <FilesSection
            group="branch"
            files={own}
            partial={view.filesPartial}
            baseBranch={baseBranch}
            onOpenFile={onOpenFile}
          />
          <FilesSection
            group="base-update"
            files={baseUpdate}
            partial={view.filesPartial}
            baseBranch={baseBranch}
            onOpenFile={onOpenFile}
          />
        </div>
      );
    }
  }
}

function Band({ label, count, partial }: { label: string; count?: number; partial?: boolean }) {
  return (
    <div className={REVIEW_HUB_STICKY_BAND}>
      <div className={cn(REVIEW_HUB_SECTION_BAND, "border-b border-divider")}>
        <span className={SECTION_LABEL_CLASS}>
          {label}
          {count !== undefined && (
            <span className={REVIEW_HUB_COUNT_CHIP}>
              {partial ? (
                <>
                  <span aria-hidden="true">{count}+</span>
                  <span className="sr-only">{`${count} shown, more not listed`}</span>
                </>
              ) : (
                count
              )}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

function CommitsSection({ commits }: { commits: SinceReviewCommitsView }) {
  if (commits.kind === "unavailable") {
    return (
      <section data-testid="since-review-commits">
        <Band label="Commits" />
        <p className={BAND_NOTE_CLASS} data-testid="since-review-commits-unavailable">
          {commits.text}
        </p>
      </section>
    );
  }
  const total = commits.fresh.length + commits.equivalent.length;
  if (total === 0 && !commits.rewritten) return null;
  return (
    <section data-testid="since-review-commits">
      <Band label="Commits" count={total} partial={commits.truncated} />
      {commits.rewritten && (
        <p className={BAND_NOTE_CLASS} data-testid="since-review-history-rewritten">
          The reviewed commit is no longer in this branch's history. Files still compare with what
          you reviewed.
        </p>
      )}
      {commits.fresh.length > 0 && (
        <ul className="px-2 py-1 flex flex-col gap-0.5">
          {commits.fresh.map((commit) => (
            <CommitRow key={commit.oid} commit={commit} />
          ))}
        </ul>
      )}
      {commits.equivalent.length > 0 && (
        <div data-testid="since-review-equivalent">
          <p className="px-3 pt-2 pb-0.5 text-2xs text-text-secondary">
            Same change as a reviewed commit
          </p>
          <ul className="px-2 pb-1 flex flex-col gap-0.5">
            {commits.equivalent.map((commit) => (
              <CommitRow key={commit.oid} commit={commit} />
            ))}
          </ul>
        </div>
      )}
      {commits.truncated && (
        <p className={cn(BAND_NOTE_CLASS, "pt-1")} data-testid="since-review-commits-truncated">
          {`Newest ${pluralize(total, "commit")} shown. More arrived than can be listed.`}
        </p>
      )}
    </section>
  );
}

function CommitRow({ commit }: { commit: ReviewComparisonCommit }) {
  const { ref: subjectRef, isTruncated: subjectTruncated } = useTruncationDetection();
  const equivalent = commit.kind === "patch-equivalent";
  return (
    <li
      className="flex items-baseline gap-2 px-1.5 py-1.5 text-xs"
      data-testid="since-review-commit"
      data-kind={commit.kind}
    >
      <span className="shrink-0 font-mono text-2xs text-text-secondary">
        {commit.oid.slice(0, 7)}
      </span>
      <TruncatedTooltip content={commit.subject} isTruncated={subjectTruncated}>
        <span
          ref={subjectRef}
          className={cn(
            "min-w-0 flex-1 truncate",
            equivalent ? "text-text-secondary" : "text-text-primary"
          )}
        >
          {commit.subject}
        </span>
      </TruncatedTooltip>
      <TimeAgo timestamp={commit.authoredAt} className="shrink-0 text-2xs text-text-secondary" />
    </li>
  );
}

function FilesSection({
  group,
  files,
  partial,
  baseBranch,
  onOpenFile,
}: {
  group: SinceReviewFileGroup;
  files: SinceReviewFile[];
  partial: boolean;
  baseBranch: string;
  onOpenFile: SinceReviewPanelProps["onOpenFile"];
}) {
  if (files.length === 0) return null;
  const label = group === "branch" ? "Files changed since review" : `Changed on ${baseBranch} only`;
  return (
    <section data-testid={`since-review-files-${group}`}>
      <Band label={label} count={files.length} partial={partial} />
      <p className="sr-only">{pluralize(files.length, "file")}</p>
      {group === "base-update" && (
        <p className={cn(BAND_NOTE_CLASS, "pb-1")}>
          {`This branch didn't change these; they differ because ${baseBranch} moved.`}
        </p>
      )}
      <div className="px-2 py-1 flex flex-col gap-0.5">
        {files.map((file) => (
          <SinceReviewFileRow
            key={`${file.status}:${file.path}`}
            file={file}
            baseBranch={baseBranch}
            onOpen={onOpenFile}
          />
        ))}
      </div>
    </section>
  );
}

function SinceReviewFileRow({
  file,
  baseBranch,
  onOpen,
}: {
  file: SinceReviewFile;
  baseBranch: string;
  onOpen: SinceReviewPanelProps["onOpenFile"];
}) {
  const { ref: dirRef, isTruncated: dirTruncated } = useTruncationDetection();
  const { ref: baseRef, isTruncated: baseTruncated } = useTruncationDetection();
  // A panel names a file by a UTF-8 path; one git spells in other bytes can't be opened.
  const openable = file.pathBytes === undefined;
  const config = getBaseBranchStatusConfig(STATUS_LETTER[file.status]);
  const normalized = file.path.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  const dir = lastSlash === -1 ? "" : normalized.slice(0, lastSlash);
  const base = lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
  const tags = [
    file.alsoBaseUpdate ? `also changed on ${baseBranch}` : null,
    file.unverified ? "not checked" : null,
  ].filter((tag): tag is string => tag !== null);
  return (
    <TruncatedTooltip
      content={file.path}
      isTruncated={dirTruncated || baseTruncated}
      focusable={false}
    >
      <button
        type="button"
        disabled={!openable}
        onClick={(event) => onOpen(file.path, event.currentTarget)}
        onKeyDown={moveRowFocus}
        aria-label={[file.path, STATUS_NAME[file.status], ...tags].join(", ")}
        className={cn(
          "flex w-full min-w-0 flex-wrap items-baseline rounded-[var(--radius-md)] px-1.5 py-1.5 text-left text-xs",
          openable && "hover:bg-overlay-subtle focus-visible:bg-overlay-subtle"
        )}
        data-testid="since-review-file-row"
      >
        <span
          aria-hidden="true"
          className={cn(
            "inline-flex items-center justify-center rounded-sm mr-2 shrink-0",
            "text-3xs font-medium leading-4 h-4 w-4",
            config.bg,
            config.text
          )}
        >
          {config.label}
        </span>
        {/* The directory gives way first; the file name only once it is
            all that's left. Shrinking is shared out in proportion, so a name
            that could shrink at all would lose its last character to any
            overflow — it holds its width and truncates only at the box's. */}
        <span className="flex min-w-0 flex-1 items-baseline">
          {dir && (
            <PathTail ref={dirRef} className="min-w-[2ch] font-mono text-2xs text-text-secondary">
              {`${dir}/`}
            </PathTail>
          )}
          <span
            ref={baseRef}
            className="shrink-0 max-w-full truncate font-medium font-mono text-2xs text-text-primary"
          >
            {base}
          </span>
        </span>
        {tags.map((tag) => (
          <span
            key={tag}
            aria-hidden="true"
            className={cn(
              "ml-2 shrink-0 text-2xs text-text-secondary",
              // Narrow: under the path, so the file name keeps the width.
              "@max-[30rem]/since-review:ml-0 @max-[30rem]/since-review:basis-full @max-[30rem]/since-review:pl-6"
            )}
          >
            {tag}
          </span>
        ))}
      </button>
    </TruncatedTooltip>
  );
}
