import type React from "react";
import { useEffect, useRef, useState } from "react";
import type { WorktreeState } from "@/types";
import type { RetryAction } from "@/store";
import type { ErrorRecord } from "@/store/errorStore";
import { cn } from "@/lib/utils";
import { ActivityLight } from "../ActivityLight";
import { LiveTimeAgo } from "../LiveTimeAgo";
import { WorktreeDetails } from "../WorktreeDetails";
import {
  ChevronRight,
  GitCommitHorizontal,
  Play,
  Square,
  Plug,
  Activity,
  Trash2,
} from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import type { ComputedSubtitle } from "./hooks/useWorktreeStatus";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";

export interface WorktreeDetailsSectionProps {
  worktree: WorktreeState;
  homeDir?: string;
  isExpanded: boolean;
  hasChanges: boolean;
  computedSubtitle: ComputedSubtitle;
  effectiveNote?: string;
  effectiveSummary?: string | null;
  worktreeErrors: ErrorRecord[];
  isFocused: boolean;
  onToggleExpand: (e: React.MouseEvent) => void;
  onPathClick: () => void;
  onDismissError: (id: string) => void;
  onRetryError: (id: string, action: RetryAction, args?: Record<string, unknown>) => Promise<void>;
  onOpenReviewHub?: () => void;
  isLifecycleRunning?: boolean;
  lifecycleLabel?: string;

  hasResourceConfig?: boolean;
  resourceStatus?: string;
  onResourceResume?: () => void;
  onResourcePause?: () => void;
  onResourceConnect?: () => void;
  onResourceProvision?: () => void;
  onResourceTeardown?: () => void;
  onResourceStatus?: () => void;
}

export function WorktreeDetailsSection(props: WorktreeDetailsSectionProps) {
  const {
    worktree,
    homeDir,
    isExpanded,
    hasChanges,
    computedSubtitle,
    effectiveNote,
    effectiveSummary,
    worktreeErrors,
    isFocused,
    onToggleExpand,
    onPathClick,
    onDismissError,
    onRetryError,
    onOpenReviewHub,
    isLifecycleRunning,
    lifecycleLabel,

    hasResourceConfig,
    resourceStatus,
    onResourceResume,
    onResourcePause,
    onResourceConnect,
    onResourceTeardown,
    onResourceStatus,
  } = props;
  const detailsId = `worktree-${worktree.id}-details`;
  const detailsPanelId = `worktree-${worktree.id}-details-panel`;

  // One-shot bump on file-count change. Counter increments on every change
  // and is used as a `key` on the count span so back-to-back updates remount
  // the node and restart the animation (a plain boolean latch would silently
  // drop a second update arriving inside the 200ms animation window).
  // prevRef seeded to current value so mount produces no bump.
  const changedFileCount = worktree.worktreeChanges?.changedFileCount ?? 0;
  const prevCountRef = useRef(changedFileCount);
  const [bumpKey, setBumpKey] = useState(0);

  useEffect(() => {
    if (prevCountRef.current !== changedFileCount) {
      prevCountRef.current = changedFileCount;
      setBumpKey((k) => k + 1);
    }
  }, [changedFileCount]);

  const rsLower = resourceStatus?.toLowerCase();
  const showResourceResume =
    hasResourceConfig &&
    (!rsLower ||
      rsLower === "paused" ||
      rsLower === "stopped" ||
      rsLower === "unknown" ||
      rsLower === "terminated" ||
      rsLower === "down");
  const showResourcePause = hasResourceConfig && (rsLower === "running" || rsLower === "starting");
  const showResourceConnect = hasResourceConfig && !!onResourceConnect && rsLower === "running";

  return (
    <div
      id={detailsId}
      className="mt-2 rounded-[var(--radius-lg)] border border-border-default bg-surface-inset p-3"
    >
      {isExpanded ? (
        <div className="-m-3">
          <button
            onClick={onToggleExpand}
            aria-expanded={true}
            aria-controls={detailsPanelId}
            className="worktree-section-button flex w-full items-center justify-between rounded-t-[var(--radius-lg)] border-b border-border-default bg-surface-inset px-3 py-2.5 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-[-2px]"
            id={`${detailsId}-button`}
          >
            <span className="text-xs font-medium text-text-muted">Details</span>
            <ChevronRight className="h-3 w-3 rotate-90 text-text-muted" />
          </button>
          <div
            id={detailsPanelId}
            role="region"
            aria-labelledby={`${detailsId}-button`}
            className="p-3"
          >
            <WorktreeDetails
              worktree={worktree}
              homeDir={homeDir}
              effectiveNote={effectiveNote}
              effectiveSummary={effectiveSummary}
              worktreeErrors={worktreeErrors}
              hasChanges={hasChanges}
              isFocused={isFocused}
              onPathClick={onPathClick}
              onDismissError={onDismissError}
              onRetryError={onRetryError}
              showLastCommit={true}
              lastActivityTimestamp={worktree.lastActivityTimestamp}
              showTime={true}
            />
          </div>
        </div>
      ) : (
        <div className="-m-3 flex items-stretch">
          <div
            onClick={onToggleExpand}
            className={cn(
              "worktree-section-button relative flex min-w-0 flex-1 items-center justify-between px-3 py-2.5 text-left transition-colors",
              onOpenReviewHub && hasChanges
                ? "rounded-l-[var(--radius-lg)]"
                : "rounded-[var(--radius-lg)]"
            )}
          >
            <button
              type="button"
              aria-expanded={false}
              aria-controls={detailsPanelId}
              id={`${detailsId}-button`}
              aria-label="Show details"
              className={cn(
                "absolute inset-0",
                onOpenReviewHub && hasChanges
                  ? "rounded-l-[var(--radius-lg)]"
                  : "rounded-[var(--radius-lg)]",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-[-2px]"
              )}
            />
            <span className="relative z-10 text-xs truncate min-w-0 flex-1 pointer-events-none">
              {isLifecycleRunning && lifecycleLabel ? (
                <span className="flex items-center gap-1.5 text-text-secondary">
                  <Spinner size="xs" className="shrink-0" />
                  <span className="truncate">{lifecycleLabel}</span>
                </span>
              ) : lifecycleLabel &&
                !isLifecycleRunning &&
                worktree.lifecycleStatus?.state !== "success" ? (
                <span className="text-status-error">{lifecycleLabel}</span>
              ) : hasChanges && worktree.worktreeChanges ? (
                <span className="flex items-center gap-1.5 text-text-secondary">
                  <span
                    key={bumpKey}
                    className={cn("inline-block", bumpKey > 0 && "animate-badge-bump")}
                  >
                    {worktree.worktreeChanges.changedFileCount} file
                    {worktree.worktreeChanges.changedFileCount !== 1 ? "s" : ""}
                  </span>
                  {((worktree.worktreeChanges.insertions ?? 0) > 0 ||
                    (worktree.worktreeChanges.deletions ?? 0) > 0) && (
                    <span className="flex items-center gap-0.5">
                      {(worktree.worktreeChanges.insertions ?? 0) > 0 && (
                        <span className="text-status-success">
                          +{worktree.worktreeChanges.insertions}
                        </span>
                      )}
                      {(worktree.worktreeChanges.insertions ?? 0) > 0 &&
                        (worktree.worktreeChanges.deletions ?? 0) > 0 && (
                          <span className="text-text-muted">/</span>
                        )}
                      {(worktree.worktreeChanges.deletions ?? 0) > 0 && (
                        <span className="text-status-error">
                          -{worktree.worktreeChanges.deletions}
                        </span>
                      )}
                    </span>
                  )}
                </span>
              ) : (
                <span
                  className={cn(
                    computedSubtitle.tone === "warning" && "text-status-warning",
                    computedSubtitle.tone === "info" && "text-status-info",
                    computedSubtitle.tone === "muted" && "text-text-muted"
                  )}
                >
                  {computedSubtitle.text}
                </span>
              )}
            </span>

            {hasResourceConfig && (
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <span className="sr-only">Resource actions</span>
                </ContextMenuTrigger>
                <ContextMenuContent onClick={(e) => e.stopPropagation()}>
                  {showResourceResume && onResourceResume && (
                    <ContextMenuItem onClick={onResourceResume}>
                      <Play className="w-3.5 h-3.5 mr-2" />
                      Resume
                    </ContextMenuItem>
                  )}
                  {showResourcePause && onResourcePause && (
                    <ContextMenuItem onClick={onResourcePause}>
                      <Square className="w-3.5 h-3.5 mr-2" />
                      Pause
                    </ContextMenuItem>
                  )}
                  {showResourceConnect && (
                    <ContextMenuItem onClick={onResourceConnect}>
                      <Plug className="w-3.5 h-3.5 mr-2" />
                      Connect
                    </ContextMenuItem>
                  )}
                  {(showResourceResume || showResourcePause || showResourceConnect) &&
                    onResourceStatus && <ContextMenuSeparator />}
                  {onResourceStatus && (
                    <ContextMenuItem onClick={onResourceStatus}>
                      <Activity className="w-3.5 h-3.5 mr-2" />
                      Check Status
                    </ContextMenuItem>
                  )}
                  {onResourceTeardown && (
                    <>
                      <ContextMenuSeparator />
                      <ContextMenuItem onClick={onResourceTeardown} className="text-status-error">
                        <Trash2 className="w-3.5 h-3.5 mr-2" />
                        Teardown
                      </ContextMenuItem>
                    </>
                  )}
                </ContextMenuContent>
              </ContextMenu>
            )}

            {hasResourceConfig &&
              (showResourceResume || showResourcePause || showResourceConnect) && (
                <span className="relative z-10 ml-1 inline-flex shrink-0 items-center gap-0.5">
                  {showResourceResume && onResourceResume && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onResourceResume();
                          }}
                          className="shrink-0 p-1 rounded transition-colors text-status-success/70 hover:text-status-success hover:bg-overlay-emphasis focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent"
                          aria-label="Resume Resource"
                        >
                          <Play className="w-3 h-3" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">Resume Resource</TooltipContent>
                    </Tooltip>
                  )}
                  {showResourcePause && onResourcePause && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onResourcePause();
                          }}
                          className="shrink-0 p-1 rounded transition-colors text-status-error/70 hover:text-status-error hover:bg-overlay-emphasis focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent"
                          aria-label="Pause Resource"
                        >
                          <Square className="w-3 h-3" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">Pause Resource</TooltipContent>
                    </Tooltip>
                  )}
                  {showResourceConnect && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onResourceConnect!();
                          }}
                          className="shrink-0 p-1 rounded transition-colors text-status-info/70 hover:text-status-info hover:bg-overlay-emphasis focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent"
                          aria-label="Connect to Resource"
                        >
                          <Plug className="w-3 h-3" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">Connect to Resource</TooltipContent>
                    </Tooltip>
                  )}
                </span>
              )}

            <Tooltip>
              <TooltipTrigger asChild>
                <div className="relative z-10 ml-3 flex shrink-0 items-center gap-1.5 text-xs text-text-muted">
                  <ActivityLight
                    lastActivityTimestamp={worktree.lastActivityTimestamp}
                    className="w-1.5 h-1.5"
                  />
                  <LiveTimeAgo timestamp={worktree.lastActivityTimestamp} />
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {worktree.lastActivityTimestamp
                  ? `Last activity: ${new Date(worktree.lastActivityTimestamp).toLocaleString()}`
                  : "No recent activity recorded"}
              </TooltipContent>
            </Tooltip>
          </div>

          {onOpenReviewHub && hasChanges && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={onOpenReviewHub}
                  className={cn(
                    "shrink-0 border-l border-border-default px-2 py-1 transition-colors",
                    "text-[var(--color-state-active)]/70 hover:bg-[var(--color-state-active)]/10 hover:text-[var(--color-state-active)]",
                    "rounded-r-[var(--radius-lg)]",
                    "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent"
                  )}
                  aria-label="Open Review & Commit"
                >
                  <GitCommitHorizontal className="w-3.5 h-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Review & Commit</TooltipContent>
            </Tooltip>
          )}
        </div>
      )}
    </div>
  );
}
