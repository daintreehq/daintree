import { createElement, useCallback, useEffect, useState, type ReactNode } from "react";
import type { WorktreeState } from "@/types";
import { logError } from "@/utils/logger";
import { actionService } from "@/services/ActionService";
import { useMenuActionSource } from "@/components/ui/menu-source";
import { useRecipeStore } from "@/store/recipeStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";

export type ConfirmDialogState =
  | { isOpen: false }
  | {
      isOpen: true;
      title: string;
      description: string;
      confirmLabel: string;
      variant: "default" | "destructive" | "info";
      onConfirm: () => void;
      children?: ReactNode;
    };

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
  handleSelectAllAgents: () => void;
  handleSelectWaitingAgents: () => void;
  handleSelectWorkingAgents: () => void;
  handleCloseAll: () => void;
  handleTerminateAll: () => void;
  handleResourceTeardown: () => void;

  hasSnapshot: boolean;
  handleRevertAgentChanges: () => void;
  handleDeleteSnapshot: () => void;
}

export function useWorktreeActions({
  worktree,
  onCopyTree,
  teardownCommands,
}: {
  worktree: WorktreeState;
  onCopyTree: () => Promise<string | undefined> | void;
  teardownCommands: string[];
}): UseWorktreeActionsResult {
  const runRecipe = useRecipeStore((state) => state.runRecipe);

  const [runningRecipeId, setRunningRecipeId] = useState<string | null>(null);

  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>({
    isOpen: false,
  });

  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const source = useMenuActionSource();

  const closeConfirmDialog = useCallback(() => {
    setConfirmDialog({ isOpen: false });
  }, []);

  const [hasSnapshot, setHasSnapshot] = useState(false);
  const [snapshotCreatedAt, setSnapshotCreatedAt] = useState<number | null>(null);

  // Check for snapshot availability — re-runs when agent activity changes.
  useEffect(() => {
    let cancelled = false;
    window.electron.git
      .snapshotGet(worktree.id)
      .then((info) => {
        if (cancelled) return;
        const available = info !== null && info.hasChanges;
        setHasSnapshot(available);
        setSnapshotCreatedAt(available ? info.createdAt : null);
      })
      .catch(() => {
        // Snapshot check is best-effort, but a failure after a prior success
        // (host restart, snapshot deleted externally) must not leave the
        // Revert button live against a snapshot that may no longer exist.
        if (cancelled) return;
        setHasSnapshot(false);
        setSnapshotCreatedAt(null);
      });
    return () => {
      cancelled = true;
    };
  }, [worktree.id, worktree.lastActivityTimestamp]);

  const handleRevertAgentChanges = useCallback(() => {
    const label = worktree.issueTitle ?? worktree.branch ?? worktree.name;
    const preview =
      snapshotCreatedAt != null
        ? createElement(
            "p",
            { className: "text-xs text-daintree-text/60" },
            `Snapshot captured ${new Date(snapshotCreatedAt).toLocaleString()}.`
          )
        : undefined;
    setConfirmDialog({
      isOpen: true,
      title: `Revert agent changes for '${label}'?`,
      description:
        "Reverting to the pre-agent snapshot permanently discards every working tree change made since the snapshot in this worktree. This cannot be undone.",
      confirmLabel: "Revert agent changes",
      variant: "destructive",
      children: preview,
      onConfirm: () => {
        setConfirmDialog({ isOpen: false });
        window.electron.git
          .snapshotRevert(worktree.id)
          .then((result) => {
            setHasSnapshot(false);
            setSnapshotCreatedAt(null);
            if (result.hasConflicts) {
              void actionService.dispatch(
                "app.showNotification",
                { type: "warning", message: result.message },
                { source: "user" }
              );
            }
          })
          .catch((error) => {
            logError("Failed to revert agent changes", error);
          });
      },
    });
  }, [worktree.id, worktree.issueTitle, worktree.branch, worktree.name, snapshotCreatedAt]);

  const handleDeleteSnapshot = useCallback(() => {
    const label = worktree.issueTitle ?? worktree.branch ?? worktree.name;
    const preview =
      snapshotCreatedAt != null
        ? createElement(
            "p",
            { className: "text-xs text-daintree-text/60" },
            `Snapshot captured ${new Date(snapshotCreatedAt).toLocaleString()}.`
          )
        : undefined;
    setConfirmDialog({
      isOpen: true,
      title: `Delete snapshot for '${label}'?`,
      description:
        "Deleting the pre-agent snapshot permanently removes the saved restore point. Your working tree is left unchanged, but you'll no longer be able to revert agent changes. This cannot be undone.",
      confirmLabel: "Delete snapshot",
      variant: "destructive",
      children: preview,
      onConfirm: () => {
        setConfirmDialog({ isOpen: false });
        window.electron.git
          .snapshotDelete(worktree.id)
          .then(() => {
            setHasSnapshot(false);
            setSnapshotCreatedAt(null);
          })
          .catch((error) => {
            logError("Failed to delete snapshot", error);
          });
      },
    });
  }, [worktree.id, worktree.issueTitle, worktree.branch, worktree.name, snapshotCreatedAt]);

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
          prNumber: worktree.linked?.pr?.ref.number,
          worktreePath: worktree.path,
          branchName: worktree.branch,
        });
      } catch (error) {
        logError("Failed to run recipe", error);
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

  const handleSelectAllAgents = useCallback(() => {
    useWorktreeSelectionStore.getState().setActiveWorktree(worktree.id);
    useFleetArmingStore.getState().armAll("current");
  }, [worktree.id]);

  const handleSelectWaitingAgents = useCallback(() => {
    useWorktreeSelectionStore.getState().setActiveWorktree(worktree.id);
    useFleetArmingStore.getState().armByState("waiting", "current", false);
  }, [worktree.id]);

  const handleSelectWorkingAgents = useCallback(() => {
    useWorktreeSelectionStore.getState().setActiveWorktree(worktree.id);
    useFleetArmingStore.getState().armByState("working", "current", false);
  }, [worktree.id]);

  const handleCloseAll = useCallback(() => {
    const label = worktree.issueTitle ?? worktree.branch;
    setConfirmDialog({
      isOpen: true,
      title: `Trash all sessions for '${label}'?`,
      description:
        "Every session in this worktree moves to trash. Active agents, running processes, and unsaved scrollback will be lost. Sessions can be restored from trash before garbage collection.",
      confirmLabel: "Trash all sessions",
      variant: "destructive",
      onConfirm: () => {
        void actionService.dispatch(
          "worktree.sessions.trashAll",
          { worktreeId: worktree.id, confirmed: true },
          { source: "user" }
        );
        setConfirmDialog({ isOpen: false });
      },
    });
  }, [worktree.id, worktree.issueTitle, worktree.branch]);

  const handleTerminateAll = useCallback(() => {
    const label = worktree.issueTitle ?? worktree.branch;
    setConfirmDialog({
      isOpen: true,
      title: `Terminate all sessions for '${label}'?`,
      description:
        "This permanently closes every session in this worktree. Active agents, running processes, and unsaved output will be lost.",
      confirmLabel: "Terminate all",
      variant: "destructive",
      onConfirm: () => {
        void actionService.dispatch(
          "worktree.sessions.endAll",
          { worktreeId: worktree.id },
          { source: "user" }
        );
        setConfirmDialog({ isOpen: false });
      },
    });
  }, [worktree.id, worktree.issueTitle, worktree.branch]);

  const handleResourceTeardown = useCallback(() => {
    const label = worktree.issueTitle ?? worktree.branch ?? worktree.name;
    const hasCommands = teardownCommands.length > 0;
    const preview = createElement(
      "div",
      { className: "space-y-1.5" },
      createElement(
        "span",
        {
          className: "text-[11px] font-semibold uppercase tracking-wider text-daintree-text/60",
        },
        hasCommands ? "Commands that will run" : "Teardown commands"
      ),
      createElement(
        "pre",
        {
          className:
            "text-xs text-daintree-text/80 bg-daintree-bg/50 p-3 rounded border border-daintree-border font-mono whitespace-pre-wrap break-all",
        },
        hasCommands ? teardownCommands.join("\n") : "No teardown commands found."
      )
    );
    setConfirmDialog({
      isOpen: true,
      title: `Teardown resource for '${label}'?`,
      description:
        "This runs the project's resource-teardown commands for this worktree. Tearing down a remote or shared environment may require manual steps to recreate.",
      confirmLabel: "Teardown resource",
      variant: "destructive",
      children: preview,
      onConfirm: () => {
        void actionService.dispatch(
          "worktree.resource.teardown",
          { worktreeId: worktree.id },
          { source }
        );
        setConfirmDialog({ isOpen: false });
      },
    });
  }, [worktree.id, worktree.issueTitle, worktree.branch, worktree.name, teardownCommands]);

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
    handleCloseAll,
    handleTerminateAll,
    handleResourceTeardown,
    handleSelectAllAgents,
    handleSelectWaitingAgents,
    handleSelectWorkingAgents,
    hasSnapshot,
    handleRevertAgentChanges,
    handleDeleteSnapshot,
  };
}
