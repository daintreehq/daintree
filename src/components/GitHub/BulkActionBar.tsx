import { useCallback } from "react";
import { X } from "lucide-react";
import { FolderGit2 } from "@/components/icons";
import { AnimatePresence, m } from "framer-motion";
import { Button } from "@/components/ui/button";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import type { GitHubIssue, GitHubPR } from "@shared/types/github";

interface BulkActionBarProps {
  mode: "issue" | "pr";
  selectedIssues: GitHubIssue[];
  selectedPRs: GitHubPR[];
  onClear: () => void;
  onCloseDropdown?: () => void;
}

export function BulkActionBar({
  mode,
  selectedIssues,
  selectedPRs,
  onClear,
  onCloseDropdown,
}: BulkActionBarProps) {
  const openBulkCreateDialog = useWorktreeSelectionStore((s) => s.openBulkCreateDialog);
  const openBulkCreateDialogForPRs = useWorktreeSelectionStore((s) => s.openBulkCreateDialogForPRs);

  const count = mode === "pr" ? selectedPRs.length : selectedIssues.length;

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

  return (
    <AnimatePresence>
      {count > 0 && (
        <m.div
          key="bulk-bar"
          role="toolbar"
          aria-label="Bulk actions"
          initial={{ y: "100%", opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: "100%", opacity: 0 }}
          transition={{ type: "spring", damping: 25, stiffness: 200 }}
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
        </m.div>
      )}
    </AnimatePresence>
  );
}
