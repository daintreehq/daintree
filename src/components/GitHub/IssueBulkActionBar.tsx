import { useCallback } from "react";
import { X, GitBranch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import type { GitHubIssue } from "@shared/types/github";

interface IssueBulkActionBarProps {
  selectedIssues: GitHubIssue[];
  onClear: () => void;
  onCloseDropdown?: () => void;
}

export function IssueBulkActionBar({
  selectedIssues,
  onClear,
  onCloseDropdown,
}: IssueBulkActionBarProps) {
  const openBulkCreateDialog = useWorktreeSelectionStore((s) => s.openBulkCreateDialog);

  const handleOpenDialog = useCallback(() => {
    openBulkCreateDialog(selectedIssues);
    onCloseDropdown?.();
  }, [selectedIssues, openBulkCreateDialog, onCloseDropdown]);

  if (selectedIssues.length === 0) return null;

  return (
    <div
      role="toolbar"
      aria-label="Bulk actions"
      className="border-t border-[var(--border-divider)] px-3 py-2 flex items-center gap-2 shrink-0"
    >
      <span className="inline-flex items-center gap-1.5 text-xs text-canopy-text/70">
        <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded bg-canopy-accent/15 text-canopy-accent text-[10px] font-semibold tabular-nums">
          {selectedIssues.length}
        </span>
        selected
      </span>
      <Button variant="default" size="xs" onClick={handleOpenDialog}>
        <GitBranch className="w-3 h-3" />
        Create Worktrees
      </Button>
      <div className="flex-1" />
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onClear}
        aria-label="Clear selection"
        className="text-canopy-text/40 hover:text-canopy-text"
      >
        <X className="w-3 h-3" />
      </Button>
    </div>
  );
}
