import { useCallback } from "react";
import { X, GitBranch } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
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

  return (
    <AnimatePresence>
      {selectedIssues.length > 0 && (
        <motion.div
          key="bulk-bar"
          role="toolbar"
          aria-label="Bulk actions"
          initial={{ y: "100%", opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: "100%", opacity: 0 }}
          transition={{ type: "spring", damping: 25, stiffness: 200 }}
          className="mx-2 mb-2 rounded-xl shadow-xl bg-surface-panel ring-1 ring-border-default shadow-black/20 inset-shadow-[0_1px_0_var(--color-overlay-soft)] flex items-center gap-3 px-4 py-3"
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
        </motion.div>
      )}
    </AnimatePresence>
  );
}
