import { CircleCheck } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { PathTail } from "@/components/ui/PathTail";
import { SECTION_LABEL_CLASS } from "@/components/ui/sectionLabel";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
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
  /** The mark was made on another branch; the hub offers to drop it. */
  onClear: () => void;
  onRetry: () => void;
  /** Open one file's diff since review; `trigger` gets focus back when it closes. */
  onOpenFile: (path: string, trigger: HTMLElement) => void;
}

const STATUS_LETTER: Record<SinceReviewFile["status"], string> = {
  added: "A",
  deleted: "D",
  modified: "M",
  unknown: "?",
};

/**
 * Review Hub's "Since review" body (#14586): what the comparison against the
 * worktree's review mark found. A row opens that file's diff since review (#14587),
 * never the ordinary diff, which would pass for the change since review.
 */
export function SinceReviewPanel({ view, onClear, onRetry, onOpenFile }: SinceReviewPanelProps) {
  switch (view.kind) {
    case "comparing":
      return (
        <p
          className="px-3 py-3 text-xs text-text-secondary"
          role="status"
          data-testid="since-review-comparing"
        >
          Comparing with your review…
        </p>
      );
    case "unavailable":
      return (
        <EmptyState
          variant="zero-data"
          scale="canvas"
          className="py-12"
          title="Since review isn't available"
          description={view.reason}
          rootAttributes={{ "data-testid": "since-review-unavailable" }}
        />
      );
    case "other-branch":
      return (
        <InlineStatusBanner
          severity="info"
          role="status"
          ariaLive="polite"
          title="The review mark is from another branch"
          description="It says nothing about this branch. Clear it to mark this one."
          action={{ id: "since-review-clear", label: "Clear review mark", onClick: onClear }}
          data-testid="since-review-other-branch"
        />
      );
    case "failed":
      return (
        <InlineStatusBanner
          severity="error"
          role="status"
          ariaLive="polite"
          title={view.text}
          action={{ id: "since-review-retry", label: "Retry", onClick: onRetry }}
          data-testid="since-review-failed"
        />
      );
    case "unreadable":
      return (
        <InlineStatusBanner
          severity="warning"
          role="status"
          ariaLive="polite"
          title="Comparison incomplete"
          description={view.text}
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
        <div data-testid="since-review-listed">
          {view.incomplete && (
            <InlineStatusBanner
              severity="warning"
              role="status"
              ariaLive="polite"
              title="Comparison incomplete"
              description={view.incomplete}
              data-testid="since-review-incomplete"
            />
          )}
          <CommitsSection commits={view.commits} />
          <FilesSection group="branch" files={own} onOpenFile={onOpenFile} />
          <FilesSection group="base-update" files={baseUpdate} onOpenFile={onOpenFile} />
        </div>
      );
    }
  }
}

function Band({ label, count }: { label: string; count?: number }) {
  return (
    <div className={REVIEW_HUB_STICKY_BAND}>
      <div className={cn(REVIEW_HUB_SECTION_BAND, "border-b border-divider")}>
        <span className={SECTION_LABEL_CLASS}>
          {label}
          {count !== undefined && <span className={REVIEW_HUB_COUNT_CHIP}>{count}</span>}
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
        <p
          className="px-3 py-2 text-xs text-text-secondary"
          data-testid="since-review-commits-unavailable"
        >
          {commits.text}
        </p>
      </section>
    );
  }
  if (commits.commits.length === 0 && !commits.rewritten) return null;
  return (
    <section data-testid="since-review-commits">
      <Band label="Commits" count={commits.commits.length} />
      {commits.rewritten && (
        <p className="px-3 py-2 text-xs text-text-secondary">
          History was rewritten since your review.
        </p>
      )}
      <ul className="px-2 py-1 flex flex-col gap-0.5">
        {commits.commits.map((commit) => (
          <li
            key={commit.oid}
            className="flex items-baseline gap-2 rounded-[var(--radius-md)] px-1.5 py-1.5 text-xs"
            data-testid="since-review-commit"
            data-kind={commit.kind}
          >
            <span className="shrink-0 font-mono text-2xs text-text-secondary">
              {commit.oid.slice(0, 7)}
            </span>
            <span className="min-w-0 flex-1 truncate text-text-primary">{commit.subject}</span>
            {commit.kind === "patch-equivalent" && (
              <span className="shrink-0 text-2xs text-text-secondary">patch-equivalent</span>
            )}
            <TimeAgo
              timestamp={commit.authoredAt}
              className="shrink-0 text-2xs text-text-secondary"
            />
          </li>
        ))}
      </ul>
      {commits.truncated && (
        <p className="px-3 pb-2 text-xs text-text-secondary">
          More commits arrived than are listed.
        </p>
      )}
    </section>
  );
}

function FilesSection({
  group,
  files,
  onOpenFile,
}: {
  group: SinceReviewFileGroup;
  files: SinceReviewFile[];
  onOpenFile: SinceReviewPanelProps["onOpenFile"];
}) {
  if (files.length === 0) return null;
  const label = group === "branch" ? "Files changed since review" : "Changed only by a base update";
  return (
    <section data-testid={`since-review-files-${group}`}>
      <Band label={label} count={files.length} />
      <p className="sr-only">{pluralize(files.length, "file")}</p>
      <div className="px-2 py-1 flex flex-col gap-0.5">
        {files.map((file) => (
          <SinceReviewFileRow key={`${file.status}:${file.path}`} file={file} onOpen={onOpenFile} />
        ))}
      </div>
    </section>
  );
}

function SinceReviewFileRow({
  file,
  onOpen,
}: {
  file: SinceReviewFile;
  onOpen: SinceReviewPanelProps["onOpenFile"];
}) {
  // A panel names a file by a UTF-8 path; one git spells in other bytes can't be opened.
  const openable = file.pathBytes === undefined;
  const config = getBaseBranchStatusConfig(STATUS_LETTER[file.status]);
  const normalized = file.path.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  const dir = lastSlash === -1 ? "" : normalized.slice(0, lastSlash);
  const base = lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
  return (
    <TruncatedTooltip content={file.path}>
      <button
        type="button"
        disabled={!openable}
        onClick={(event) => onOpen(file.path, event.currentTarget)}
        className={cn(
          "flex w-full items-baseline rounded-[var(--radius-md)] px-1.5 py-1.5 text-left text-xs",
          openable && "hover:bg-overlay-subtle focus-visible:bg-overlay-subtle"
        )}
        data-testid="since-review-file-row"
      >
        <span
          aria-hidden="true"
          className={cn(
            "inline-flex items-center justify-center rounded-sm px-1 mr-2 shrink-0",
            "text-3xs font-medium leading-4 h-4 min-w-[16px]",
            config.bg,
            config.text
          )}
        >
          {config.label}
        </span>
        {dir && (
          <PathTail className="shrink font-mono text-2xs text-text-secondary">{`${dir}/`}</PathTail>
        )}
        <span className="shrink truncate font-medium font-mono text-2xs text-text-primary">
          {base}
        </span>
        {file.alsoBaseUpdate && (
          <span className="ml-2 shrink-0 text-2xs text-text-secondary">also in base update</span>
        )}
      </button>
    </TruncatedTooltip>
  );
}
