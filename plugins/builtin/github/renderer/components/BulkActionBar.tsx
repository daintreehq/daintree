import { useCallback } from "react";
import { X } from "lucide-react";
import { FolderGit2 } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import type { GitHubIssue, GitHubPR } from "@shared/types/github";

interface BulkActionBarProps {
  mode: "issue" | "pr";
  selectedIssues: GitHubIssue[];
  selectedPRs: GitHubPR[];
  selectedCount: number;
  onClear: () => void;
  onCloseDropdown?: () => void;
}

export function BulkActionBar({
  mode,
  selectedIssues,
  selectedPRs,
  selectedCount,
  onClear,
  onCloseDropdown,
}: BulkActionBarProps) {
  const openBulkCreateDialog = useWorktreeSelectionStore((s) => s.openBulkCreateDialog);
  const openBulkCreateDialogForPRs = useWorktreeSelectionStore((s) => s.openBulkCreateDialogForPRs);

  const count = selectedCount;

  const handleOpenDialog = useCallback(() => {
    if (mode === "pr") {
      openBulkCreateDialogForPRs(selectedPRs, onClear);
    } else {
      openBulkCreateDialog(selectedIssues, onClear);
    }
    onCloseDropdown?.();
  }, [
    mode,
    selectedIssues,
    selectedPRs,
    openBulkCreateDialog,
    openBulkCreateDialogForPRs,
    onCloseDropdown,
    onClear,
  ]);

  // Plain conditional render — avoids AnimatePresence + Activity-hidden
  // interaction where exit lifecycle gets stuck and the bar remains in the
  // DOM with stale closures even after count flips to 0.
  if (count <= 0) return null;

  return (
    <div
      role="toolbar"
      aria-label="Bulk actions"
      className="mx-2 mb-2 rounded-xl shadow-[var(--theme-shadow-floating)] bg-surface-panel ring-1 ring-border-default inset-shadow-[0_1px_0_var(--color-overlay-soft)] flex items-center gap-3 px-4 py-3"
    >
      <span className="inline-flex items-center gap-1.5 text-xs text-daintree-text/70">
        <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded bg-status-info/15 text-status-info text-[10px] font-semibold tabular-nums">
          {count}
        </span>
        selected
      </span>
      <Button variant="default" size="xs" onClick={handleOpenDialog}>
        <FolderGit2 className="w-3 h-3" />
        Create Worktrees
      </Button>
      <div className="flex-1" />
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onClear}
        aria-label="Clear selection"
        className="text-daintree-text/40 hover:text-daintree-text"
      >
        <X className="w-3 h-3" />
      </Button>
    </div>
  );
}
