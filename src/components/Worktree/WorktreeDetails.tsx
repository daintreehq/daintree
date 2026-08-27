import { useMemo, useRef } from "react";
import type { WorktreeState } from "../../types";
import type { ErrorRecord, RetryAction } from "../../store/errorStore";
import { ErrorBanner } from "../Errors/ErrorBanner";
import { FileChangeList, type FileChangeListHandle } from "./FileChangeList";
import { ActivityLight } from "./ActivityLight";
import { LiveTimeAgo } from "./LiveTimeAgo";
import { CommitAuthorAvatar } from "./WorktreeCard/CommitAuthorAvatar";
import { CommitInfoTooltip } from "./WorktreeCard/CommitInfoTooltip";
import { cn } from "../../lib/utils";
import { GitCommit, Copy, Check, ExternalLink, FileDiff, Sparkles } from "lucide-react";
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
const NARRATIVE_RAIL = "border-l-2 border-border-default pl-2.5";
const NARRATIVE_LABEL =
  "flex items-center gap-1 text-[10px] font-medium uppercase tracking-[0.06em] text-text-muted";

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
            <div className="space-y-1">
              {worktreeErrors.slice(0, 3).map((error) => (
                <ErrorBanner
                  key={error.id}
                  error={error}
                  onDismiss={onDismissError}
                  onRetry={onRetryError}
                  onCancelRetry={onCancelRetry}
                  compact
                />
              ))}
              {worktreeErrors.length > 3 && (
                <div className="text-[0.65rem] text-daintree-text/60 text-center">
                  +{worktreeErrors.length - 3} more errors
                </div>
              )}
            </div>
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
            <div className={NARRATIVE_RAIL}>
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
                      className="rounded break-all text-text-link underline hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
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
            <div className={NARRATIVE_RAIL}>
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
            <div className={NARRATIVE_RAIL}>
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

          {/* Block 3: Artifacts (grouped file changes + system path). In the
              GRID variant the list sits in a well painted the
              selected-worktree-card color (`.sidebar-active-well`,
              sidebar.css), with a hairline to carry the shape on themes where
              that fill lands close to the panel's. The sidebar drops both: the
              row is already inside a card and a Details region, and the rows'
              own hover backplates give it all the shape it needs. */}
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
                        className="shrink-0 rounded p-1 text-text-muted transition-colors hover:bg-overlay-soft hover:text-text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
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
                className={cn(
                  "rounded-[var(--radius-md)] p-2",
                  // Sidebar: the list is already inside the card and the
                  // Details region; a filled, hairlined well here is the
                  // third containment level in a 240-360px column. The rows
                  // carry their own hover backplate, which is enough shape.
                  !isSidebar && "sidebar-active-well border border-border-subtle"
                )}
              />
            </div>
          )}
        </>
      )}

      {/* Footer: system path, then the last-active line. Separated by an
          asymmetric gap rather than a rule — a full-width hairline in a
          300px column reads as another section boundary, and the tertiary
          tone already terminates the block. */}
      <div
        className={cn("space-y-2.5", isSidebar ? "pt-1.5" : "border-t border-border-subtle pt-3")}
      >
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
                  "flex min-w-0 flex-1 items-center gap-1.5 truncate rounded text-left font-mono text-xs text-text-muted hover:text-text-secondary",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent",
                  isFocused && "text-text-secondary"
                )}
              >
                <ExternalLink className="w-3 h-3 shrink-0 text-text-muted" />
                <span className="truncate">{displayPath}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{`Open folder: ${worktree.path}`}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleCopyPath}
                className="shrink-0 rounded p-1 text-text-muted transition-colors hover:bg-overlay-soft hover:text-text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
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
