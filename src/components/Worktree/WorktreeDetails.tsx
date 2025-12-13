import { useMemo, useState, useRef, useEffect } from "react";
import type { WorktreeState, DevServerState } from "../../types";
import type { AppError, RetryAction } from "../../store/errorStore";
import { ErrorBanner } from "../Errors/ErrorBanner";
import { FileChangeList } from "./FileChangeList";
import { ActivityLight } from "./ActivityLight";
import { LiveTimeAgo } from "./LiveTimeAgo";
import { cn } from "../../lib/utils";
import { systemClient } from "@/clients";
import { Globe, Play, GitCommit, Square, Copy, Check, ExternalLink } from "lucide-react";
import { parseNoteWithLinks, formatPath, type TextSegment } from "../../utils/textParsing";

export interface WorktreeDetailsProps {
  worktree: WorktreeState;
  homeDir?: string;
  effectiveNote?: string;
  effectiveSummary?: string | null;
  showDevServer: boolean;
  serverState: DevServerState | null;
  serverLoading: boolean;
  worktreeErrors: AppError[];
  hasChanges: boolean;
  isFocused: boolean;
  showLastCommit?: boolean;
  lastActivityTimestamp?: number | null;
  showTime?: boolean;

  onPathClick: () => void;
  onToggleServer: () => void;
  onDismissError: (id: string) => void;
  onRetryError: (id: string, action: RetryAction, args?: Record<string, unknown>) => Promise<void>;
}

function getServerStatusTooltip(serverState: DevServerState | null): string {
  if (!serverState) return "Dev server status unknown";
  switch (serverState.status) {
    case "running":
      return serverState.url ? `Dev server running at ${serverState.url}` : "Dev server is running";
    case "starting":
      return "Dev server is starting...";
    case "error":
      return "Dev server failed to start";
    case "stopped":
    default:
      return "Dev server is stopped";
  }
}

export function WorktreeDetails({
  worktree,
  homeDir,
  effectiveNote,
  effectiveSummary,
  showDevServer,
  serverState,
  serverLoading,
  worktreeErrors,
  hasChanges,
  isFocused,
  onPathClick,
  onToggleServer,
  onDismissError,
  onRetryError,
  showLastCommit,
  lastActivityTimestamp,
  showTime = false,
}: WorktreeDetailsProps) {
  const displayPath = formatPath(worktree.path, homeDir);
  const rawLastCommitMsg = worktree.worktreeChanges?.lastCommitMessage;
  const [pathCopied, setPathCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
        copyTimeoutRef.current = null;
      }
    };
  }, []);

  const parsedNoteSegments: TextSegment[] = useMemo(() => {
    return effectiveNote ? parseNoteWithLinks(effectiveNote) : [];
  }, [effectiveNote]);

  const handleLinkClick = (e: React.MouseEvent, url: string) => {
    e.stopPropagation();
    e.preventDefault();
    systemClient.openExternal(url);
  };

  const handleCopyPath = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(worktree.path);
      } else {
        throw new Error("Clipboard API not available");
      }

      if (!isMountedRef.current) return;

      setPathCopied(true);

      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }

      copyTimeoutRef.current = setTimeout(() => {
        if (isMountedRef.current) {
          setPathCopied(false);
          copyTimeoutRef.current = null;
        }
      }, 2000);
    } catch (err) {
      console.error("Failed to copy path:", err);
    }
  };

  const hasContent =
    (showDevServer && serverState) ||
    worktreeErrors.length > 0 ||
    effectiveNote ||
    effectiveSummary ||
    (showLastCommit && rawLastCommitMsg) ||
    (hasChanges && worktree.worktreeChanges) ||
    (showTime && lastActivityTimestamp);

  if (!hasContent) {
    return (
      <div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onPathClick();
            }}
            className={cn(
              "text-xs text-canopy-text/40 hover:text-canopy-text/60 text-left font-mono truncate flex-1 min-w-0 flex items-center gap-1.5 rounded",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent",
              isFocused && "text-canopy-text/60"
            )}
            title={`Open folder: ${worktree.path}`}
          >
            <ExternalLink className="w-3 h-3 shrink-0 opacity-60" />
            <span className="truncate">{displayPath}</span>
          </button>

          <button
            type="button"
            onClick={handleCopyPath}
            className="shrink-0 p-1 text-canopy-text/40 hover:text-canopy-text/60 hover:bg-white/5 rounded transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
            title={pathCopied ? "Copied!" : "Copy full path"}
            aria-label={pathCopied ? "Path copied to clipboard" : "Copy path to clipboard"}
          >
            {pathCopied ? (
              <Check className="w-3 h-3 text-green-400" />
            ) : (
              <Copy className="w-3 h-3" />
            )}
          </button>
          <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {pathCopied ? "Path copied to clipboard" : ""}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Time Display for Expanded View */}
      {showTime && lastActivityTimestamp && (
        <div className="flex items-center gap-2 pb-2 border-b border-white/5">
          <div className="flex items-center gap-1.5 text-xs text-canopy-text/50">
            <span className="text-xs font-medium">Last active:</span>
            <ActivityLight lastActivityTimestamp={lastActivityTimestamp} />
            <LiveTimeAgo timestamp={lastActivityTimestamp} />
          </div>
        </div>
      )}

      {/* Dev Server Controls */}
      {showDevServer && serverState && (
        <div className="space-y-2">
          <div className="text-xs text-canopy-text/60 font-medium">Dev Server</div>
          <div className="flex items-center gap-3">
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (!serverLoading && serverState.status !== "starting") {
                  onToggleServer();
                }
              }}
              disabled={serverLoading || serverState.status === "starting"}
              title={getServerStatusTooltip(serverState)}
              aria-label={
                serverState.status === "running"
                  ? "Stop dev server"
                  : serverState.status === "starting"
                    ? "Dev server is starting"
                    : serverState.status === "error"
                      ? "Retry dev server"
                      : "Start dev server"
              }
              className={cn(
                "py-1.5 px-3 rounded-[var(--radius-lg)] font-medium text-xs transition-colors",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent",
                serverState.status === "running"
                  ? "bg-[color-mix(in_oklab,var(--color-server-running)_20%,transparent)] text-[var(--color-server-running)] hover:bg-[color-mix(in_oklab,var(--color-server-running)_30%,transparent)]"
                  : serverState.status === "error"
                    ? "bg-[color-mix(in_oklab,var(--color-server-error)_10%,transparent)] text-[var(--color-server-error)] hover:bg-[color-mix(in_oklab,var(--color-server-error)_20%,transparent)]"
                    : "bg-white/5 text-canopy-text/60 hover:bg-white/10",
                (serverLoading || serverState.status === "starting") &&
                  "opacity-50 cursor-not-allowed"
              )}
            >
              <div className="flex items-center gap-1.5">
                {serverState.status === "running" ? (
                  <>
                    <div className="w-1.5 h-1.5 bg-[var(--color-server-running)] rounded-full animate-pulse" />
                    <span>Running</span>
                  </>
                ) : serverState.status === "starting" ? (
                  <>
                    <div className="w-1.5 h-1.5 bg-[var(--color-server-starting)] rounded-full animate-breathe" />
                    <span>Starting...</span>
                  </>
                ) : serverState.status === "error" ? (
                  <>
                    <Square className="w-3 h-3" />
                    <span>Retry</span>
                  </>
                ) : (
                  <>
                    <Play className="w-3 h-3" />
                    <span>Start</span>
                  </>
                )}
              </div>
            </button>
            {serverState.status === "running" && serverState.url && (
              <a
                href={serverState.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  systemClient.openExternal(serverState.url!);
                }}
                className="flex items-center gap-1.5 text-xs text-[var(--color-status-info)] hover:brightness-110 hover:underline"
              >
                <Globe className="w-3 h-3" />
                {serverState.url.replace(/^https?:\/\//, "")}
              </a>
            )}
          </div>
        </div>
      )}

      {/* Errors (if any) */}
      {worktreeErrors.length > 0 && (
        <div className="space-y-1">
          {worktreeErrors.slice(0, 3).map((error) => (
            <ErrorBanner
              key={error.id}
              error={error}
              onDismiss={onDismissError}
              onRetry={onRetryError}
              compact
            />
          ))}
          {worktreeErrors.length > 3 && (
            <div className="text-[0.65rem] text-canopy-text/60 text-center">
              +{worktreeErrors.length - 3} more errors
            </div>
          )}
        </div>
      )}

      {/* Block 2: Narrative (AI note, summary, or commit message) */}
      {effectiveNote && (
        <div className="p-3 rounded-[var(--radius-lg)] bg-yellow-500/5 border border-yellow-500/20">
          <div className="text-xs text-yellow-200/90 whitespace-pre-wrap font-mono">
            {parsedNoteSegments.map((segment, index) =>
              segment.type === "link" ? (
                <a
                  key={index}
                  href={segment.content}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--color-status-info)] underline hover:brightness-110 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2"
                  onClick={(e) => handleLinkClick(e, segment.content)}
                >
                  {segment.content}
                </a>
              ) : (
                <span key={index}>{segment.content}</span>
              )
            )}
          </div>
        </div>
      )}
      {!effectiveNote && effectiveSummary && (
        <div className="text-xs text-canopy-text/70 whitespace-pre-wrap leading-relaxed p-2 bg-white/[0.02] rounded">
          {effectiveSummary}
        </div>
      )}
      {!effectiveNote && !effectiveSummary && showLastCommit && rawLastCommitMsg && (
        <div className="text-xs text-canopy-text/60 italic flex gap-2 p-2 bg-white/[0.02] rounded">
          <GitCommit className="w-3.5 h-3.5 mt-0.5 shrink-0 opacity-60" />
          <div className="whitespace-pre-wrap leading-relaxed min-w-0">{rawLastCommitMsg}</div>
        </div>
      )}

      {/* Placeholder when no AI summary or note exists */}
      {!effectiveNote && !effectiveSummary && !rawLastCommitMsg && (
        <div className="text-xs text-canopy-text/40 italic">
          No AI summary yet. Run an agent task or use Copy Context to generate one.
        </div>
      )}

      {/* Block 3: Artifacts (grouped file changes + system path) */}
      {hasChanges && worktree.worktreeChanges && (
        <div className="space-y-2">
          <div className="text-xs text-canopy-text/60 font-medium">Changed Files</div>
          <FileChangeList
            changes={worktree.worktreeChanges.changes}
            rootPath={worktree.worktreeChanges.rootPath}
            maxVisible={worktree.worktreeChanges.changes.length}
            groupByFolder={worktree.worktreeChanges.changedFileCount > 5}
          />
        </div>
      )}

      {/* System path footer */}
      <div className="pt-3 border-t border-white/5">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onPathClick();
            }}
            className={cn(
              "text-xs text-canopy-text/40 hover:text-canopy-text/60 text-left font-mono truncate flex-1 min-w-0 flex items-center gap-1.5 rounded",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent",
              isFocused && "text-canopy-text/60"
            )}
            title={`Open folder: ${worktree.path}`}
          >
            <ExternalLink className="w-3 h-3 shrink-0 opacity-60" />
            <span className="truncate">{displayPath}</span>
          </button>

          <button
            type="button"
            onClick={handleCopyPath}
            className="shrink-0 p-1 text-canopy-text/40 hover:text-canopy-text/60 hover:bg-white/5 rounded transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
            title={pathCopied ? "Copied!" : "Copy full path"}
            aria-label={pathCopied ? "Path copied to clipboard" : "Copy path to clipboard"}
          >
            {pathCopied ? (
              <Check className="w-3 h-3 text-green-400" />
            ) : (
              <Copy className="w-3 h-3" />
            )}
          </button>
          <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {pathCopied ? "Path copied to clipboard" : ""}
          </div>
        </div>
      </div>
    </div>
  );
}
