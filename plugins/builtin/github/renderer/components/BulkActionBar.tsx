import { useCallback } from "react";
import { X } from "lucide-react";
import { FolderGit2 } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import type { Issue, PR } from "@shared/types/forge";

interface BulkActionBarProps {
  mode: "issue" | "pr";
  selectedIssues: Issue[];
  selectedPRs: PR[];
  selectedCount: number;
  /**
   * How many selected items the list is not currently showing. Selection
   * survives the search, the state tab, the sort order and pagination, so a
   * bar reading "5 selected" over a list showing two of them was quietly
   * lying about what the action would touch. "Not shown" rather than "hidden
   * by filters" because an unloaded page produces the same count.
   */
  hiddenCount?: number;
  onClear: () => void;
  onCloseDropdown?: () => void;
}

export function BulkActionBar({
  mode,
  selectedIssues,
  selectedPRs,
  selectedCount,
  hiddenCount = 0,
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

  const noun = mode === "pr" ? "pull request" : "issue";
  const hiddenNote = hiddenCount > 0 ? ` · ${hiddenCount} not shown` : "";

  return (
    /* This REPLACES the standard footer rather than stacking under it. The bar
       used to float below a footer that stayed put, so starting a selection
       gave the panel two bottom bands and stole a row's worth of list. Same
       band, same height, different contents. */
    <div
      /* `group`, not `toolbar`: a toolbar promises arrow-key navigation
         between its controls, and these are two ordinary tab stops. */
      role="group"
      aria-label="Bulk actions"
      className="px-2 py-1.5 border-t border-[var(--border-divider)] flex items-center gap-2 shrink-0"
    >
      <span className="ps-2 text-xs text-text-secondary tabular-nums truncate">
        {/* Neutral count. A `status-info` chip on a multi-select membership
            total was reading as an alert about nothing. */}
        <span className="font-medium text-daintree-text">{count}</span>{" "}
        {count === 1 ? noun : `${noun}s`} selected{hiddenNote}
      </span>
      <div className="flex-1" />
      <Button
        variant="ghost"
        size="sm"
        onClick={handleOpenDialog}
        className="gap-1.5"
        data-testid="bulk-action-create-worktrees-button"
      >
        <FolderGit2 className="w-3.5 h-3.5" />
        {count === 1 ? "Create worktree" : "Create worktrees"}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onClear}
        aria-label="Clear selection"
        className="text-text-secondary hover:text-daintree-text"
      >
        <X className="w-3.5 h-3.5" />
      </Button>
    </div>
  );
}
