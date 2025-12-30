import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
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

  treeCopied: boolean;
  isCopyingTree: boolean;
  copyFeedback: string;

  confirmDialog: ConfirmDialogState;
  showDeleteDialog: boolean;

  setShowDeleteDialog: (open: boolean) => void;
  closeConfirmDialog: () => void;

  handlePathClick: () => void;
  handleCopyTree: () => Promise<void>;
  handleCopyTreeClick: (e: React.MouseEvent<HTMLButtonElement>) => Promise<void>;

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

  const [treeCopied, setTreeCopied] = useState(false);
  const [isCopyingTree, setIsCopyingTree] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<string>("");
  const treeCopyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTreeRequestIdRef = useRef(0);

  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>({
    isOpen: false,
    title: "",
    description: "",
    onConfirm: () => {},
  });

  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isRestartValidating, setIsRestartValidating] = useState(false);

  useEffect(() => {
    return () => {
      copyTreeRequestIdRef.current = -1;
      if (treeCopyTimeoutRef.current) {
        clearTimeout(treeCopyTimeoutRef.current);
        treeCopyTimeoutRef.current = null;
      }
    };
  }, []);

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
        await runRecipe(recipeId, worktree.path, worktree.id);
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
    if (isCopyingTree) return;

    const requestId = ++copyTreeRequestIdRef.current;
    setIsCopyingTree(true);

    try {
      const resultMessage = await onCopyTree();

      if (copyTreeRequestIdRef.current !== requestId) return;

      if (resultMessage) {
        setTreeCopied(true);
        setCopyFeedback(resultMessage);

        if (treeCopyTimeoutRef.current) {
          clearTimeout(treeCopyTimeoutRef.current);
        }

        treeCopyTimeoutRef.current = setTimeout(() => {
          if (copyTreeRequestIdRef.current !== requestId) return;
          setTreeCopied(false);
          setCopyFeedback("");
          treeCopyTimeoutRef.current = null;
        }, 2000);
      }
    } finally {
      if (copyTreeRequestIdRef.current === requestId) {
        setIsCopyingTree(false);
      }
    }
  }, [onCopyTree, isCopyingTree]);

  const handleCopyTreeClick = useCallback(
    async (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      e.currentTarget.blur();
      await handleCopyTree();
    },
    [handleCopyTree]
  );

  return {
    runningRecipeId,
    isRestartValidating,
    treeCopied,
    isCopyingTree,
    copyFeedback,
    confirmDialog,
    showDeleteDialog,
    setShowDeleteDialog,
    closeConfirmDialog,
    handlePathClick,
    handleCopyTree,
    handleCopyTreeClick,
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
