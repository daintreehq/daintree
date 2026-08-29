import { useMemo, useRef } from "react";
import type { WorktreeState } from "../../types";
import type { ErrorRecord, RetryAction } from "../../store/errorStore";
import { CompactErrorList } from "../Errors/CompactErrorList";
import { FileChangeList, type FileChangeListHandle } from "./FileChangeList";
import { ActivityLight } from "./ActivityLight";
import { LiveTimeAgo } from "./LiveTimeAgo";
import { CommitAuthorAvatar } from "./WorktreeCard/CommitAuthorAvatar";
import { CommitInfoTooltip } from "./WorktreeCard/CommitInfoTooltip";
import { cn } from "../../lib/utils";
import { GitCommit, Copy, Check, FolderTree, FileDiff, Sparkles } from "lucide-react";
import { parseNoteWithLinks, formatPath, type TextSegment } from "../../utils/textParsing";
import { actionService } from "@/services/ActionService";
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isValidPastTimestamp } from "@/utils/timestamps";

const MAX_VISIBLE_FILES = 100;

/**
 * The narrative slot's shared shell. A quiet left rail marks derived
 * commentary as a distinct content role without adding another container.
 */
// `border-strong`, not `border-default`: the well's border reads because it
// sits between two different fills, but this rail sits on one, and at
// `border-default` it measured ~1.05:1 against the well on the dark palettes —
// present in the light themes, invisible in the dark ones. It is the only
// thing binding the label to the prose under it.
const NARRATIVE_RAIL = "border-l-2 border-border-strong pl-2.5";
// The rail's centre belongs on the point of the Details chevron above it, so
// the two read as one hanging line. Measured from the well's inner edge (both
// the trigger and this panel are its children, so its border cancels):
//
//   chevron point = button border (1) + `pl-1.5` (6) + half of `h-3`/`w-3` (6)
//                 = 13   — the glyph is symmetric about its box once rotated,
//                          so the apex is the icon's centre, not its ink edge
//   rail centre   = panel `px-2.5` (10) + half of `border-l-2` (1)
//                 = 11
//
// Hence 2px, and only in the sidebar. The grid runs the same sum with no well
// border, `px-3` and the same `pl-1.5` — 13 against 13 — so it already lands on
// the point and must not be nudged.
const NARRATIVE_RAIL_SIDEBAR_NUDGE = "ml-0.5";
// `text-secondary`, not `text-muted`: this label is the only thing that says
// whether the prose under it is an AI note, a summary, or a commit message,
// and `text-muted` has no contrast floor on the darkest palettes — 2.22:1 on
// namib, where it drops out of the rail entirely. The 10px uppercase size and
// the tracking already do the de-emphasis.
const NARRATIVE_LABEL =
  "flex items-center gap-1 text-3xs font-medium uppercase tracking-[0.06em] text-text-secondary";

export interface WorktreeDetailsProps {
  worktree: WorktreeState;
  homeDir?: string;
  /** See {@link WorktreeDetailsSectionProps.variant} — same reasoning. */
  variant?: "sidebar" | "grid";
  effectiveNote?: string;
  effectiveSummary?: string | null;
  worktreeErrors: ErrorRecord[];
  hasChanges: boolean;
  isFocused: boolean;
  isStale?: boolean;
  showLastCommit?: boolean;
  lastActivityTimestamp?: number | null;
  showTime?: boolean;
  /** Forge profile picture for the committer, tried before Gravatar. */
  forgeAvatarUrl?: string;

  onPathClick: () => void;
  onDismissError: (id: string) => void;
  onRetryError: (id: string, action: RetryAction, args?: Record<string, unknown>) => Promise<void>;
  onCancelRetry?: (id: string) => void;
}

export function WorktreeDetails({
  worktree,
  homeDir,
  variant = "sidebar",
  effectiveNote,
  effectiveSummary,
  worktreeErrors,
  hasChanges,
  isFocused,
  isStale = false,
  onPathClick,
  onDismissError,
  onRetryError,
  onCancelRetry,
  showLastCommit,
  lastActivityTimestamp,
  showTime = false,
  forgeAvatarUrl,
}: WorktreeDetailsProps) {
  const isSidebar = variant === "sidebar";
  const railClass = cn(NARRATIVE_RAIL, isSidebar && NARRATIVE_RAIL_SIDEBAR_NUDGE);
  const displayPath = formatPath(worktree.path, homeDir);
  const rawLastCommitMsg = worktree.worktreeChanges?.lastCommitMessage;
  const { copied: pathCopied, copy: copyPath } = useCopyWithFeedback();
  const fileChangeListRef = useRef<FileChangeListHandle>(null);

  const lastCommitAuthor = worktree.worktreeChanges?.lastCommitAuthor ?? null;
  const lastCommitTs = worktree.worktreeChanges?.lastCommitTimestampMs;
  const now = Date.now();
  const hasCommit = isValidPastTimestamp(lastCommitTs, now);
  const activityTime = isValidPastTimestamp(lastActivityTimestamp, now)
    ? lastActivityTimestamp
    : hasCommit
      ? lastCommitTs
      : null;
  const showLastActive = showTime && activityTime !== null;
  const activityAuthor = hasCommit && activityTime === lastCommitTs ? lastCommitAuthor : null;

  const lastActiveLine = (
    <div
      className="flex items-center gap-2 text-xs"
      role="group"
      aria-label="Last activity"
      tabIndex={0}
    >
      <ActivityLight lastActivityTimestamp={activityTime} className="h-1.5 w-1.5 shrink-0" />
      {activityAuthor && (
        <CommitAuthorAvatar author={activityAuthor} forgeAvatarUrl={forgeAvatarUrl} size={20} />
      )}
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 font-medium text-text-secondary">Last active</span>
        <LiveTimeAgo timestamp={activityTime} className="shrink-0 text-text-muted" noTooltip />
        {activityAuthor && (
          <>
            <span className="shrink-0 text-text-muted" aria-hidden="true">
              ·
            </span>
            <span className="min-w-0 truncate text-text-muted">{activityAuthor.name}</span>
          </>
        )}
      </div>
    </div>
  );

  const parsedNoteSegments: TextSegment[] = useMemo(() => {
    return effectiveNote ? parseNoteWithLinks(effectiveNote) : [];
  }, [effectiveNote]);

  const handleLinkClick = (e: React.MouseEvent, url: string) => {
    e.stopPropagation();
    e.preventDefault();
    void actionService.dispatch("system.openExternal", { url }, { source: "user" });
  };

  const handleCopyPath = (e: React.MouseEvent) => {
    e.stopPropagation();
    void copyPath(worktree.path);
  };

  const hasDetailsContent =
    worktreeErrors.length > 0 ||
    effectiveNote ||
    effectiveSummary ||
    (showLastCommit && rawLastCommitMsg) ||
    (hasChanges && worktree.worktreeChanges);

  return (
    <div className="space-y-4">
      {hasDetailsContent && (
        <>
          {/* Errors (if any) */}
          {worktreeErrors.length > 0 && (
            <CompactErrorList
              errors={worktreeErrors}
              maxInline={3}
              onDismiss={onDismissError}
              onRetry={onRetryError}
              onCancelRetry={onCancelRetry}
            />
          )}

          {/* Block 2: Narrative — the AI note, the AI summary, or the last
              commit message, whichever is current. Exactly one of these ever
              renders, so they are one slot wearing four costumes. They used to
              wear four: a bordered amber well in monospace, a filled sans
              well, a filled italic well, and a filled italic placeholder — so
              the card changed material and typeface depending on which backend
              field happened to resolve. One rail, one type ramp, and a
              micro-label to say which it is.

              The rail is `border-l`, not a fill plus a border: a filled well
              with an outline draws the same boundary twice, and this content
              is derived commentary, not a warning. Prose stays sans — the
              monospace note cost ~15% more measure in a 240-360px column for
              text that is not a machine artefact. */}
          {effectiveNote && (
            <div className={railClass}>
              <div className={NARRATIVE_LABEL}>
                <Sparkles className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span>AI note</span>
              </div>
              <div className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-text-secondary">
                {parsedNoteSegments.map((segment) =>
                  segment.type === "link" ? (
                    <a
                      key={`${segment.type}-${segment.start}`}
                      href={segment.content}
                      target="_blank"
                      rel="noopener noreferrer"
                      // `break-all` rather than the inherited word wrap: a bare
                      // GitHub URL has no break opportunity and used to run
                      // straight out of the card and off the sidebar.
                      className="rounded-[var(--radius-md)] break-all text-text-link underline hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
                      onClick={(e) => handleLinkClick(e, segment.content)}
                    >
                      {segment.content}
                    </a>
                  ) : (
                    <span key={`${segment.type}-${segment.start}`}>{segment.content}</span>
                  )
                )}
              </div>
            </div>
          )}
          {!effectiveNote && effectiveSummary && (
            <div className={railClass}>
              <div className={NARRATIVE_LABEL}>
                <Sparkles className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span>Summary</span>
              </div>
              <div className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-text-secondary">
                {effectiveSummary}
              </div>
            </div>
          )}
          {!effectiveNote && !effectiveSummary && showLastCommit && rawLastCommitMsg && (
            <div className={railClass}>
              <div className={NARRATIVE_LABEL}>
                <GitCommit className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span>Last commit</span>
              </div>
              <div className="mt-1 min-w-0 whitespace-pre-wrap break-words text-xs leading-relaxed text-text-secondary">
                {rawLastCommitMsg}
              </div>
            </div>
          )}

          {/* Nothing to say yet. A filled box here occupied the footprint of
              real content and read as data; a single muted line does not. */}
          {!effectiveNote && !effectiveSummary && !rawLastCommitMsg && (
            <div className="text-xs text-text-muted">No AI summary yet</div>
          )}

          {/* Block 3: Artifacts (grouped file changes + system path).

              The list is flat in BOTH variants. The grid used to paint it in
              a filled, hairlined well — which, once Details itself is a well
              inside a card inside a grid cell, is the fourth closed contour
              around one list of filenames. The rows carry their own hover
              backplates, and that is all the shape a list nested this deep
              can use. */}
          {hasChanges && worktree.worktreeChanges && (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between gap-2 px-2">
                <span className="text-xs font-medium text-text-secondary">Changed files</span>
                {worktree.worktreeChanges.changes.length > 0 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={(e) => {
                          // Stop the click reaching WorktreeCard's onSelect — in the
                          // overview modal that closes the card and unmounts this list
                          // before the diff can open (matches the sibling path buttons).
                          e.stopPropagation();
                          fileChangeListRef.current?.openFirstFile(e.currentTarget);
                        }}
                        className="flex min-h-6 min-w-6 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-text-secondary transition-colors hover:bg-overlay-soft hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
                        aria-label="Open changes"
                      >
                        <FileDiff className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Open changes</TooltipContent>
                  </Tooltip>
                )}
              </div>
              <FileChangeList
                ref={fileChangeListRef}
                changes={worktree.worktreeChanges.changes}
                rootPath={worktree.worktreeChanges.rootPath}
                maxVisible={MAX_VISIBLE_FILES}
                groupByFolder={worktree.worktreeChanges.changedFileCount > 5}
                isStale={isStale}
                className="rounded-[var(--radius-md)] p-2"
              />
            </div>
          )}
        </>
      )}

      {/* Footer: system path, then the last-active line. Both variants
          separate it by an asymmetric gap rather than a rule — a full-width
          hairline inside a well that is already inside a card reads as another
          section boundary, and the tertiary tone already terminates the
          block. */}
      <div className={cn("space-y-2.5", isSidebar ? "pt-1.5" : "pt-2.5")}>
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onPathClick();
                }}
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-1.5 truncate rounded-[var(--radius-md)] text-left font-mono text-xs text-text-muted hover:text-text-secondary",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary",
                  isFocused && "text-text-secondary"
                )}
              >
                <FolderTree className="w-3 h-3 shrink-0 text-text-muted" />
                <span className="truncate">{displayPath}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{`Browse files: ${worktree.path}`}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleCopyPath}
                className="flex min-h-6 min-w-6 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-text-secondary transition-colors hover:bg-overlay-soft hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
                aria-label="Copy path to clipboard"
              >
                {pathCopied ? (
                  <Check key="check" className="w-3 h-3 text-status-success animate-badge-bump" />
                ) : (
                  <Copy key="copy" className="w-3 h-3" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {pathCopied ? "Copied!" : "Copy full path"}
            </TooltipContent>
          </Tooltip>
        </div>

        {showLastActive && (
          <Tooltip autoDismiss={false}>
            <TooltipTrigger asChild>{lastActiveLine}</TooltipTrigger>
            <TooltipContent side="bottom" className="p-3">
              <CommitInfoTooltip
                lastCommitTimestampMs={lastCommitTs}
                author={lastCommitAuthor}
                commitMessage={rawLastCommitMsg}
                forgeAvatarUrl={forgeAvatarUrl}
                lastActivityTimestamp={activityTime}
              />
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
