import { useCallback, useState } from "react";
import type { WorktreeState } from "@/types";
import { actionService } from "@/services/ActionService";
import { useRecipeStore } from "@/store/recipeStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";

export interface ConfirmDialogState {
  isOpen: boolean;
  title: string;
  description: string;
  onConfirm: () => void;
}

export interface UseWorktreeActionsResult {
  runningRecipeId: string | null;

  confirmDialog: ConfirmDialogState;
  showDeleteDialog: boolean;

  setShowDeleteDialog: (open: boolean) => void;
  closeConfirmDialog: () => void;

  handlePathClick: () => void;
  handleCopyTree: () => Promise<void>;

  handleRunRecipe: (recipeId: string) => Promise<void>;

  handleDockAll: () => void;
  handleMaximizeAll: () => void;
  handleBroadcastToAgents: () => void;
}

export function useWorktreeActions({
  worktree,
  onCopyTree,
}: {
  worktree: WorktreeState;
  onCopyTree: () => Promise<string | undefined> | void;
}): UseWorktreeActionsResult {
  const runRecipe = useRecipeStore((state) => state.runRecipe);

  const [runningRecipeId, setRunningRecipeId] = useState<string | null>(null);

  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>({
    isOpen: false,
    title: "",
    description: "",
    onConfirm: () => {},
  });

  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

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

  const handleDockAll = useCallback(() => {
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

  const handleBroadcastToAgents = useCallback(() => {
    useWorktreeSelectionStore.getState().setActiveWorktree(worktree.id);
    useFleetArmingStore.getState().armAll("current");
    // Avoid a stuck-scope state: if the worktree has no eligible agents, the
    // ribbon and composer both stay hidden, and the user has no visible exit
    // from an active but empty fleet scope.
    if (useFleetArmingStore.getState().armedIds.size === 0) return;
    void actionService.dispatch("fleet.scope.enter", undefined, { source: "user" });
  }, [worktree.id]);

  const handleCopyTree = useCallback(async () => {
    await onCopyTree();
  }, [onCopyTree]);

  return {
    runningRecipeId,
    confirmDialog,
    showDeleteDialog,
    setShowDeleteDialog,
    closeConfirmDialog,
    handlePathClick,
    handleCopyTree,
    handleRunRecipe,
    handleDockAll,
    handleMaximizeAll,
    handleBroadcastToAgents,
  };
}
