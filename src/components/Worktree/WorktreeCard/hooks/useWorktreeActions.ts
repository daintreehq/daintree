import { useCallback, useState } from "react";
import type { WorktreeState } from "@/types";
import { actionService } from "@/services/ActionService";
import { useRecipeStore } from "@/store/recipeStore";
import { useTerminalStore } from "@/store/terminalStore";

export interface ConfirmDialogState {
  isOpen: boolean;
  title: string;
  description: string;
  onConfirm: () => void;
}

export interface UseWorktreeActionsResult {
  runningRecipeId: string | null;
  isRestartValidating: boolean;

  confirmDialog: ConfirmDialogState;
  showDeleteDialog: boolean;

  setShowDeleteDialog: (open: boolean) => void;
  closeConfirmDialog: () => void;

  handlePathClick: () => void;
  handleCopyTree: () => Promise<void>;

  handleRunRecipe: (recipeId: string) => Promise<void>;

  handleCloseCompleted: () => void;
  handleCloseFailed: () => void;
  handleMinimizeAll: () => void;
  handleMaximizeAll: () => void;
  handleCloseAll: () => void;
  handleEndAll: () => void;
  handleRestartAll: () => Promise<void>;
}

export function useWorktreeActions({
  worktree,
  onCopyTree,
  totalTerminalCount,
  allTerminalCount,
}: {
  worktree: WorktreeState;
  onCopyTree: () => Promise<string | undefined> | void;
  totalTerminalCount: number;
  allTerminalCount: number;
}): UseWorktreeActionsResult {
  const runRecipe = useRecipeStore((state) => state.runRecipe);
  const bulkRestartPreflightCheckByWorktree = useTerminalStore(
    (state) => state.bulkRestartPreflightCheckByWorktree
  );

  const [runningRecipeId, setRunningRecipeId] = useState<string | null>(null);

  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>({
    isOpen: false,
    title: "",
    description: "",
    onConfirm: () => {},
  });

  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isRestartValidating, setIsRestartValidating] = useState(false);

  const closeConfirmDialog = useCallback(() => {
    setConfirmDialog((prev) => ({ ...prev, isOpen: false }));
  }, []);

  const handlePathClick = useCallback(() => {
    void actionService.dispatch("system.openPath", { path: worktree.path }, { source: "user" });
  }, [worktree.path]);

  const handleRunRecipe = useCallback(
    async (recipeId: string) => {
      if (runningRecipeId !== null) {
        return;
      }

      setRunningRecipeId(recipeId);
      try {
        await runRecipe(recipeId, worktree.path, worktree.id, {
          issueNumber: worktree.issueNumber,
          prNumber: worktree.prNumber,
          worktreePath: worktree.path,
          branchName: worktree.branch,
        });
      } catch (error) {
        console.error("Failed to run recipe:", error);
      } finally {
        setRunningRecipeId(null);
      }
    },
    [runRecipe, worktree.path, worktree.id, runningRecipeId]
  );

  const handleCloseCompleted = useCallback(() => {
    void actionService.dispatch(
      "worktree.sessions.closeCompleted",
      { worktreeId: worktree.id },
      { source: "user" }
    );
  }, [worktree.id]);

  const handleCloseFailed = useCallback(() => {
    void actionService.dispatch(
      "worktree.sessions.closeFailed",
      { worktreeId: worktree.id },
      { source: "user" }
    );
  }, [worktree.id]);

  const handleMinimizeAll = useCallback(() => {
    void actionService.dispatch(
      "worktree.sessions.minimizeAll",
      { worktreeId: worktree.id },
      { source: "user" }
    );
  }, [worktree.id]);

  const handleMaximizeAll = useCallback(() => {
    void actionService.dispatch(
      "worktree.sessions.maximizeAll",
      { worktreeId: worktree.id },
      { source: "user" }
    );
  }, [worktree.id]);

  const handleCloseAll = useCallback(() => {
    setConfirmDialog({
      isOpen: true,
      title: "Close All Sessions",
      description: `This will move ${totalTerminalCount} session${totalTerminalCount !== 1 ? "s" : ""} to trash for this worktree. They can be restored from the trash.`,
      onConfirm: () => {
        void actionService.dispatch(
          "worktree.sessions.trashAll",
          { worktreeId: worktree.id },
          { source: "user", confirmed: true }
        );
        closeConfirmDialog();
      },
    });
  }, [totalTerminalCount, worktree.id, closeConfirmDialog]);

  const handleEndAll = useCallback(() => {
    setConfirmDialog({
      isOpen: true,
      title: "End All Sessions",
      description: `This will permanently end ${allTerminalCount} session${allTerminalCount !== 1 ? "s" : ""} and their processes for this worktree. This action cannot be undone.`,
      onConfirm: () => {
        void actionService.dispatch(
          "worktree.sessions.endAll",
          { worktreeId: worktree.id },
          { source: "user", confirmed: true }
        );
        closeConfirmDialog();
      },
    });
  }, [allTerminalCount, worktree.id, closeConfirmDialog]);

  const handleRestartAll = useCallback(async () => {
    if (isRestartValidating) return;
    setIsRestartValidating(true);
    try {
      const result = await bulkRestartPreflightCheckByWorktree(worktree.id);
      const hasIssues = result.invalid.length > 0;
      const validCount = result.valid.length;
      const invalidCount = result.invalid.length;

      let description = `This will restart ${validCount} session${validCount !== 1 ? "s" : ""} for this worktree.`;
      if (hasIssues) {
        description += `\n\n${invalidCount} session${invalidCount !== 1 ? "s" : ""} cannot be restarted due to invalid configuration (e.g., missing working directory).`;
      }

      setConfirmDialog({
        isOpen: true,
        title: hasIssues ? "Restart Sessions (Some Issues Found)" : "Restart All Sessions",
        description,
        onConfirm: () => {
          void actionService.dispatch(
            "worktree.sessions.restartAll",
            { worktreeId: worktree.id },
            { source: "user", confirmed: true }
          );
          closeConfirmDialog();
        },
      });
    } finally {
      setIsRestartValidating(false);
    }
  }, [isRestartValidating, bulkRestartPreflightCheckByWorktree, worktree.id, closeConfirmDialog]);

  const handleCopyTree = useCallback(async () => {
    await onCopyTree();
  }, [onCopyTree]);

  return {
    runningRecipeId,
    isRestartValidating,
    confirmDialog,
    showDeleteDialog,
    setShowDeleteDialog,
    closeConfirmDialog,
    handlePathClick,
    handleCopyTree,
    handleRunRecipe,
    handleCloseCompleted,
    handleCloseFailed,
    handleMinimizeAll,
    handleMaximizeAll,
    handleCloseAll,
    handleEndAll,
    handleRestartAll,
  };
}
