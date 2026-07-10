import { useMemo, useRef } from "react";
import type { WorktreeState } from "../../types";
import type { ErrorRecord, RetryAction } from "../../store/errorStore";
import { ErrorBanner } from "../Errors/ErrorBanner";
import { FileChangeList, type FileChangeListHandle } from "./FileChangeList";
import { LiveTimeAgo } from "./LiveTimeAgo";
import { CommitAuthorAvatar } from "./WorktreeCard/CommitAuthorAvatar";
import { CommitInfoTooltip } from "./WorktreeCard/CommitInfoTooltip";
import { cn } from "../../lib/utils";
import { GitCommit, Copy, Check, ExternalLink, FileDiff } from "lucide-react";
import { parseNoteWithLinks, formatPath, type TextSegment } from "../../utils/textParsing";
import { actionService } from "@/services/ActionService";
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const MAX_VISIBLE_FILES = 100;

export interface WorktreeDetailsProps {
  worktree: WorktreeState;
  homeDir?: string;
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
  const displayPath = formatPath(worktree.path, homeDir);
  const rawLastCommitMsg = worktree.worktreeChanges?.lastCommitMessage;
  const { copied: pathCopied, copy: copyPath } = useCopyWithFeedback();
  const fileChangeListRef = useRef<FileChangeListHandle>(null);

  // "Last active" footer line. Prefers the worktree's activity timestamp, but
  // falls back to the last-commit time so a worktree with no in-session
  // activity still reports something meaningful.
  const lastCommitAuthor = worktree.worktreeChanges?.lastCommitAuthor ?? null;
  const lastCommitTs = worktree.worktreeChanges?.lastCommitTimestampMs;
  const hasCommit = lastCommitTs != null && Number.isFinite(lastCommitTs);
  const activityTime =
    lastActivityTimestamp != null && Number.isFinite(lastActivityTimestamp)
      ? lastActivityTimestamp
      : hasCommit
        ? lastCommitTs!
        : null;
  const showLastActive = showTime && activityTime != null;

  const lastActiveLine = (
    <div className="flex items-center gap-2 text-xs">
      {lastCommitAuthor && (
        <CommitAuthorAvatar author={lastCommitAuthor} forgeAvatarUrl={forgeAvatarUrl} size={20} />
      )}
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 font-medium text-text-secondary">Last active</span>
        <LiveTimeAgo timestamp={activityTime} className="shrink-0 text-text-muted" />
        {lastCommitAuthor && (
          <>
            <span className="shrink-0 text-text-muted" aria-hidden="true">
              ·
            </span>
            <span className="min-w-0 truncate text-text-muted">{lastCommitAuthor.name}</span>
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

          {/* Block 2: Narrative (AI note, summary, or commit message) */}
          {effectiveNote && (
            <div className="p-3 rounded-[var(--radius-lg)] bg-status-warning/5 border border-status-warning/20">
              <div className="text-xs text-status-warning/90 whitespace-pre-wrap font-mono">
                {parsedNoteSegments.map((segment) =>
                  segment.type === "link" ? (
                    <a
                      key={`${segment.type}-${segment.start}`}
                      href={segment.content}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-text-link underline hover:brightness-110 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
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
            <div className="rounded bg-overlay-subtle p-2 text-xs leading-relaxed whitespace-pre-wrap text-text-secondary">
              {effectiveSummary}
            </div>
          )}
          {!effectiveNote && !effectiveSummary && showLastCommit && rawLastCommitMsg && (
            <div className="flex gap-2 rounded bg-overlay-subtle p-2 text-xs italic text-text-secondary">
              <GitCommit className="w-3.5 h-3.5 mt-0.5 shrink-0 text-text-muted" />
              <div className="whitespace-pre-wrap leading-relaxed min-w-0">{rawLastCommitMsg}</div>
            </div>
          )}

          {/* Placeholder when no AI summary or note exists */}
          {!effectiveNote && !effectiveSummary && !rawLastCommitMsg && (
            <div className="rounded bg-overlay-subtle px-2 py-2 text-xs italic text-text-muted">
              No AI summary yet
            </div>
          )}

          {/* Block 3: Artifacts (grouped file changes + system path). The list
              sits in a well painted the selected-worktree-card color
              (`.sidebar-active-well`, sidebar.css) — a hairline carries the
              shape on themes where that fill lands close to the panel's. */}
          {hasChanges && worktree.worktreeChanges && (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between gap-2 px-2">
                <span className="text-xs font-medium text-text-secondary">Changed Files</span>
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
                className="sidebar-active-well rounded-[var(--radius-md)] border border-border-subtle p-2"
              />
            </div>
          )}
        </>
      )}

      {/* Footer: system path, then the last-active line */}
      <div className="space-y-2.5 border-t border-border-subtle pt-3">
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

        {showLastActive &&
          (hasCommit ? (
            <Tooltip autoDismiss={false}>
              <TooltipTrigger asChild>{lastActiveLine}</TooltipTrigger>
              <TooltipContent side="bottom" className="p-3">
                <CommitInfoTooltip
                  lastCommitTimestampMs={lastCommitTs!}
                  author={lastCommitAuthor}
                  commitMessage={rawLastCommitMsg}
                  forgeAvatarUrl={forgeAvatarUrl}
                  lastActivityTimestamp={lastActivityTimestamp}
                />
              </TooltipContent>
            </Tooltip>
          ) : (
            lastActiveLine
          ))}
      </div>
    </div>
  );
}
