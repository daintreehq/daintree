import type React from "react";
import type { WorktreeState } from "@/types";
import type { RetryAction } from "@/store";
import type { AppError } from "@/store/errorStore";
import { cn } from "@/lib/utils";
import { ActivityLight } from "../ActivityLight";
import { LiveTimeAgo } from "../LiveTimeAgo";
import { WorktreeDetails } from "../WorktreeDetails";
import { ChevronRight, GitCommitHorizontal, Loader2 } from "lucide-react";
import type { ComputedSubtitle } from "./hooks/useWorktreeStatus";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export interface WorktreeDetailsSectionProps {
  worktree: WorktreeState;
  homeDir?: string;
  isExpanded: boolean;
  hasChanges: boolean;
  computedSubtitle: ComputedSubtitle;
  effectiveNote?: string;
  effectiveSummary?: string | null;
  worktreeErrors: AppError[];
  isFocused: boolean;
  onToggleExpand: (e: React.MouseEvent) => void;
  onPathClick: () => void;
  onDismissError: (id: string) => void;
  onRetryError: (id: string, action: RetryAction, args?: Record<string, unknown>) => Promise<void>;
  onOpenReviewHub?: () => void;
  isLifecycleRunning?: boolean;
  lifecycleLabel?: string;
}

export function WorktreeDetailsSection({
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
}: WorktreeDetailsSectionProps) {
  const detailsId = `worktree-${worktree.id}-details`;
  const detailsPanelId = `worktree-${worktree.id}-details-panel`;

  return (
    <div
      id={detailsId}
      className="mt-3 rounded-[var(--radius-lg)] border border-border-default bg-surface-inset p-3"
    >
      {isExpanded ? (
        <div className="-m-3">
          <button
            onClick={onToggleExpand}
            aria-expanded={true}
            aria-controls={detailsPanelId}
            className="worktree-section-button flex w-full items-center justify-between rounded-t-[var(--radius-lg)] border-b border-border-default bg-surface-inset px-3 py-2.5 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-[-2px]"
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
          <button
            onClick={onToggleExpand}
            aria-expanded={false}
            aria-controls={detailsPanelId}
            className={cn(
              "worktree-section-button flex min-w-0 flex-1 items-center justify-between px-3 py-2.5 text-left transition-colors",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-[-2px]",
              onOpenReviewHub && hasChanges
                ? "rounded-l-[var(--radius-lg)]"
                : "rounded-[var(--radius-lg)]"
            )}
            id={`${detailsId}-button`}
          >
            <span className="text-xs truncate min-w-0 flex-1">
              {isLifecycleRunning && lifecycleLabel ? (
                <span className="flex items-center gap-1.5 text-text-secondary">
                  <Loader2 className="w-3 h-3 animate-spin shrink-0" aria-hidden="true" />
                  <span className="truncate">{lifecycleLabel}</span>
                </span>
              ) : lifecycleLabel &&
                !isLifecycleRunning &&
                worktree.lifecycleStatus?.state !== "success" ? (
                <span className="text-status-error">{lifecycleLabel}</span>
              ) : hasChanges && worktree.worktreeChanges ? (
                <span className="flex items-center gap-1.5 text-text-secondary">
                  <span>
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
                    computedSubtitle.tone === "error" && "text-status-error",
                    computedSubtitle.tone === "warning" && "text-status-warning",
                    computedSubtitle.tone === "info" && "text-status-info",
                    computedSubtitle.tone === "muted" && "text-text-muted"
                  )}
                >
                  {computedSubtitle.text}
                </span>
              )}
            </span>

            <Tooltip>
              <TooltipTrigger asChild>
                <div className="ml-3 flex shrink-0 items-center gap-1.5 text-xs text-text-muted">
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
          </button>

          {onOpenReviewHub && hasChanges && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={onOpenReviewHub}
                  className={cn(
                    "shrink-0 border-l border-border-default px-2 py-1 transition-colors",
                    "text-[var(--color-state-active)]/70 hover:bg-[var(--color-state-active)]/10 hover:text-[var(--color-state-active)]",
                    "rounded-r-[var(--radius-lg)]",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canopy-accent"
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
