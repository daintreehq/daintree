import { useMemo } from "react";
import type React from "react";
import type { WorktreeState } from "@/types";
import type { RetryAction } from "@/store";
import type { AppError } from "@/store/errorStore";
import { cn } from "@/lib/utils";
import { ActivityLight } from "../ActivityLight";
import { LiveTimeAgo } from "../LiveTimeAgo";
import { WorktreeDetails } from "../WorktreeDetails";
import { ChevronRight } from "lucide-react";
import type { ComputedSubtitle } from "./hooks/useWorktreeStatus";

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
  showTimeInHeader: boolean;
  onToggleExpand: (e: React.MouseEvent) => void;
  onPathClick: () => void;
  onDismissError: (id: string) => void;
  onRetryError: (id: string, action: RetryAction, args?: Record<string, unknown>) => Promise<void>;
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
  showTimeInHeader,
  onToggleExpand,
  onPathClick,
  onDismissError,
  onRetryError,
}: WorktreeDetailsSectionProps) {
  const detailsId = useMemo(() => `worktree-${worktree.id}-details`, [worktree.id]);
  const detailsPanelId = useMemo(() => `worktree-${worktree.id}-details-panel`, [worktree.id]);

  return (
    <div
      id={detailsId}
      className="mt-3 p-3 bg-white/[0.01] rounded-[var(--radius-lg)] border border-white/5"
    >
      {isExpanded ? (
        <div className="-m-3">
          <button
            onClick={onToggleExpand}
            aria-expanded={true}
            aria-controls={detailsPanelId}
            className="w-full px-3 py-2.5 flex items-center justify-between text-left border-b border-white/5 transition-colors bg-white/[0.03] hover:bg-white/[0.05] focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-[-2px] rounded-t-[var(--radius-lg)]"
            id={`${detailsId}-button`}
          >
            <span className="text-xs text-canopy-text/50 font-medium">Details</span>
            <ChevronRight className="w-3 h-3 text-canopy-text/40 rotate-90" />
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
              showTime={!showTimeInHeader}
            />
          </div>
        </div>
      ) : (
        <div className="-m-3">
          <button
            onClick={onToggleExpand}
            aria-expanded={false}
            aria-controls={detailsPanelId}
            className="w-full px-3 py-2.5 flex items-center justify-between min-w-0 text-left rounded-[var(--radius-lg)] transition-colors hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-[-2px]"
            id={`${detailsId}-button`}
          >
            <span className="text-xs truncate min-w-0 flex-1">
              {hasChanges && worktree.worktreeChanges ? (
                <span className="flex items-center gap-1.5 text-canopy-text/60">
                  <span>
                    {worktree.worktreeChanges.changedFileCount} file
                    {worktree.worktreeChanges.changedFileCount !== 1 ? "s" : ""}
                  </span>
                  {((worktree.worktreeChanges.insertions ?? 0) > 0 ||
                    (worktree.worktreeChanges.deletions ?? 0) > 0) && (
                    <span className="flex items-center gap-0.5">
                      {(worktree.worktreeChanges.insertions ?? 0) > 0 && (
                        <span className="text-[var(--color-status-success)]">
                          +{worktree.worktreeChanges.insertions}
                        </span>
                      )}
                      {(worktree.worktreeChanges.insertions ?? 0) > 0 &&
                        (worktree.worktreeChanges.deletions ?? 0) > 0 && (
                          <span className="text-canopy-text/30">/</span>
                        )}
                      {(worktree.worktreeChanges.deletions ?? 0) > 0 && (
                        <span className="text-[var(--color-status-error)]">
                          -{worktree.worktreeChanges.deletions}
                        </span>
                      )}
                    </span>
                  )}
                </span>
              ) : (
                <span
                  className={cn(
                    computedSubtitle.tone === "error" && "text-[var(--color-status-error)]",
                    computedSubtitle.tone === "warning" && "text-[var(--color-status-warning)]",
                    computedSubtitle.tone === "info" && "text-[var(--color-status-info)]",
                    computedSubtitle.tone === "muted" && "text-canopy-text/50"
                  )}
                >
                  {computedSubtitle.text}
                </span>
              )}
            </span>

            {!showTimeInHeader && (
              <div
                className="flex items-center gap-1.5 text-xs text-canopy-text/40 shrink-0 ml-3"
                title={
                  worktree.lastActivityTimestamp
                    ? `Last activity: ${new Date(worktree.lastActivityTimestamp).toLocaleString()}`
                    : "No recent activity recorded"
                }
              >
                <ActivityLight
                  lastActivityTimestamp={worktree.lastActivityTimestamp}
                  className="w-1.5 h-1.5"
                />
                <LiveTimeAgo timestamp={worktree.lastActivityTimestamp} />
              </div>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
