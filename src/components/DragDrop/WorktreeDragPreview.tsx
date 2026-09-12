import { CircleDot } from "lucide-react";
import { FolderGit2 } from "@/components/icons";
import type { WorktreeSnapshot } from "@shared/types";

interface WorktreeDragPreviewProps {
  worktree: WorktreeSnapshot;
}

export function WorktreeDragPreview({ worktree }: WorktreeDragPreviewProps) {
  const branchLabel = worktree.isMainWorktree ? worktree.name : (worktree.branch ?? worktree.name);
  const displayTitle = worktree.issueTitle ?? worktree.branchDerivedTitle;
  const hasDisplayTitle = !!(worktree.issueNumber && displayTitle);

  return (
    <div className="flex w-55 flex-col gap-1 overflow-hidden rounded-lg border border-border-default bg-surface-panel px-3 py-2.5 shadow-[var(--theme-shadow-floating)]">
      {hasDisplayTitle ? (
        <>
          <div className="flex items-center gap-1.5">
            <CircleDot
              className="h-3 w-3 shrink-0 text-[var(--color-pr-open)]"
              aria-hidden="true"
            />
            <span className="truncate text-xs font-medium text-text-primary">{displayTitle}</span>
          </div>
          <span className="truncate font-mono text-3xs text-text-secondary">{branchLabel}</span>
        </>
      ) : (
        <div className="flex items-center gap-1.5">
          <FolderGit2 className="h-3 w-3 shrink-0 text-text-secondary" aria-hidden="true" />
          <span className="truncate font-mono text-2xs font-medium text-text-primary">
            {branchLabel}
          </span>
        </div>
      )}
    </div>
  );
}
