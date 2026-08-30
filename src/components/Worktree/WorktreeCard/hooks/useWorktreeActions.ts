import { createElement, useCallback, useState, type ReactNode } from "react";
import type { WorktreeState } from "@/types";
import { logError } from "@/utils/logger";
import { actionService } from "@/services/ActionService";
import { useMenuActionSource } from "@/components/ui/menu-source";
import { useRecipeStore } from "@/store/recipeStore";
import { notifyRecipeSpawnFailures } from "@/utils/recipeNotify";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { closeAndAnnounce } from "@/lib/accessibility";
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

  handleRunRecipe: (recipeId: string) => Promise<void>;

  handleDockAll: () => void;
  handleMaximizeAll: () => void;
  handleSelectAllAgents: () => void;
  handleSelectWaitingAgents: () => void;
  handleSelectWorkingAgents: () => void;
  handleCloseAll: () => void;
  handleTerminateAll: () => void;
  handleClearHistory: () => void;
  handleResourceTeardown: () => void;
}

export function useWorktreeActions({
  worktree,
  teardownCommands,
}: {
  worktree: WorktreeState;
  teardownCommands: string[];
}): UseWorktreeActionsResult {
  const runRecipeWithResults = useRecipeStore((state) => state.runRecipeWithResults);

  const [runningRecipeId, setRunningRecipeId] = useState<string | null>(null);

  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>({
    isOpen: false,
  });

  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const source = useMenuActionSource();

  const closeConfirmDialog = useCallback(() => {
    setConfirmDialog({ isOpen: false });
  }, []);

  const handlePathClick = useCallback(() => {
    void actionService.dispatch("system.openPath", { path: worktree.path }, { source: "user" });
  }, [worktree.path]);

  // Promise-method cleanup instead of try/finally: a statement-level finally
  // clause bails React Compiler memoization for the whole per-card hook.
  const handleRunRecipe = useCallback(
    (recipeId: string) => {
      if (runningRecipeId !== null) {
        return Promise.resolve();
      }

      setRunningRecipeId(recipeId);
      const recipeState = useRecipeStore.getState();
      return runRecipeWithResults(recipeId, worktree.path, worktree.id, {
        issueNumber: worktree.issueNumber,
        prNumber: worktree.linked?.pr?.ref.number,
        worktreePath: worktree.path,
        branchName: worktree.branch,
      })
        .then((results) => {
          notifyRecipeSpawnFailures(results, {
            recipeName: recipeState.getRecipeById(recipeId)?.name,
            projectId: recipeState.currentProjectId ?? undefined,
          });
        })
        .catch((error) => {
          logError("Failed to run recipe", error);
        })
        .finally(() => {
          setRunningRecipeId(null);
        });
    },
    [
      runRecipeWithResults,
      worktree.path,
      worktree.id,
      worktree.issueNumber,
      worktree.linked?.pr?.ref.number,
      worktree.branch,
      runningRecipeId,
    ]
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
        closeAndAnnounce(() => setConfirmDialog({ isOpen: false }), "Trashed all sessions");
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
        // `confirmed: true` clears the action's own D1 gate (added in #11345) so
        // this already-confirmed call site runs immediately instead of routing
        // through the app-level pending-store dialog a second time.
        void actionService.dispatch(
          "worktree.sessions.endAll",
          { worktreeId: worktree.id, confirmed: true },
          { source: "user" }
        );
        closeAndAnnounce(() => setConfirmDialog({ isOpen: false }), "Terminated all sessions");
      },
    });
  }, [worktree.id, worktree.issueTitle, worktree.branch]);

  const handleClearHistory = useCallback(() => {
    const label = worktree.issueTitle ?? worktree.branch;
    setConfirmDialog({
      isOpen: true,
      title: `Clear session history for '${label}'?`,
      description:
        "This permanently deletes this worktree's recorded resumable-session history, and those records can't be recovered. Open sessions aren't affected, and bookmarked sessions are kept — deleting a bookmark is the only way to remove one.",
      confirmLabel: "Clear history",
      variant: "destructive",
      onConfirm: () => {
        // See handleTerminateAll: `confirmed: true` clears the clearHistory D1
        // gate added in #11345 so this confirmed call site doesn't re-prompt.
        void actionService.dispatch(
          "worktree.sessions.clearHistory",
          { worktreeId: worktree.id, confirmed: true },
          { source: "user" }
        );
        closeAndAnnounce(() => setConfirmDialog({ isOpen: false }), "Cleared session history");
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
          className: "text-2xs font-semibold uppercase tracking-wider text-text-secondary",
        },
        hasCommands ? "Commands that will run" : "Teardown commands"
      ),
      createElement(
        "pre",
        {
          className:
            "text-xs text-text-primary bg-daintree-bg/50 p-3 rounded border border-border-default font-mono whitespace-pre-wrap break-all",
        },
        hasCommands ? teardownCommands.join("\n") : "No teardown commands found."
      )
    );
    setConfirmDialog({
      isOpen: true,
      title: `Tear down resource for '${label}'?`,
      description:
        "This runs the project's resource-teardown commands for this worktree. Tearing down a remote or shared environment may require manual steps to recreate.",
      confirmLabel: "Tear down resource",
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
  }, [worktree.id, worktree.issueTitle, worktree.branch, worktree.name, teardownCommands, source]);

  return {
    runningRecipeId,
    confirmDialog,
    showDeleteDialog,
    setShowDeleteDialog,
    closeConfirmDialog,
    handlePathClick,
    handleRunRecipe,
    handleDockAll,
    handleMaximizeAll,
    handleCloseAll,
    handleTerminateAll,
    handleClearHistory,
    handleResourceTeardown,
    handleSelectAllAgents,
    handleSelectWaitingAgents,
    handleSelectWorkingAgents,
  };
}
