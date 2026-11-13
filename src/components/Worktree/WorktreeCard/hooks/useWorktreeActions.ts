import { useCallback, useState, type ReactNode } from "react";
import type { WorktreeState } from "@/types";
import { logError } from "@/utils/logger";
import { actionService } from "@/services/ActionService";
import { useMenuActionSource } from "@/components/ui/menu-source";
import { useRecipeStore } from "@/store/recipeStore";
import { notifyRecipeSpawnFailures } from "@/utils/recipeNotify";
import { recipeIssueContext } from "@/utils/recipeVariables";
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
  handleResourceOpenOnHost: () => void;
  confirmAttachmentMove: (name: string, fromLabel: string, onConfirm: () => void) => void;
}

export function useWorktreeActions({
  worktree,
}: {
  worktree: WorktreeState;
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
        ...recipeIssueContext({
          issueNumber: worktree.issueNumber,
          issueTitle: worktree.issueTitle,
          issueProviderId: worktree.issueProviderId,
          issueKey: worktree.issueKey,
        }),
        prNumber: worktree.linked?.pr?.ref.number,
        worktreePath: worktree.path,
        branchName: worktree.branch,
      })
        .then((results) => {
          notifyRecipeSpawnFailures(results, {
            recipeName: recipeState.getRecipeById(recipeId)?.name,
            projectId: recipeState.currentProjectId ?? undefined,
            worktreeId: worktree.id,
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
      worktree.issueTitle,
      worktree.issueProviderId,
      worktree.issueKey,
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

  // The three session-wide destructive items dispatch unconfirmed on purpose.
  // Each action gates itself and stages the app-level confirm
  // (`TerminalDestructiveActionConfirmDialog`), which names the worktree,
  // previews the sessions it will touch and flags working agents — one dialog
  // for these actions whether they come from this menu, the palette or a
  // keybinding.
  const handleCloseAll = useCallback(() => {
    void actionService.dispatch(
      "worktree.sessions.trashAll",
      { worktreeId: worktree.id },
      { source: "user" }
    );
  }, [worktree.id]);

  const handleTerminateAll = useCallback(() => {
    void actionService.dispatch(
      "worktree.sessions.endAll",
      { worktreeId: worktree.id },
      { source: "user" }
    );
  }, [worktree.id]);

  const handleClearHistory = useCallback(() => {
    void actionService.dispatch(
      "worktree.sessions.clearHistory",
      { worktreeId: worktree.id },
      { source: "user" }
    );
  }, [worktree.id]);

  // Unconfirmed, like the session-wide items above: the action's own gate
  // shows the one teardown confirm every entry point shares.
  const handleResourceTeardown = useCallback(() => {
    void actionService.dispatch(
      "worktree.resource.teardown",
      { worktreeId: worktree.id },
      { source }
    );
  }, [worktree.id, source]);

  // Adding a host and, from there, installing and starting Daintree on the box
  // are bundled, so the one confirmation names each step (D2, bundled operations).
  const sshTarget = worktree.resourceStatus?.ssh;
  const handleResourceOpenOnHost = useCallback(() => {
    if (!sshTarget) return;
    const label = worktree.issueTitle ?? worktree.branch ?? worktree.name;
    setConfirmDialog({
      isOpen: true,
      title: `Open '${label}' on ${sshTarget}?`,
      description: `If ${sshTarget} isn't in your host list, it's added for this worktree and removed again when the worktree is deleted or its resource is torn down. If Daintree isn't running there, Host setup opens to install and start it; otherwise the host switch dialog places this branch there.`,
      confirmLabel: "Open on its machine",
      variant: "default",
      onConfirm: () => {
        setConfirmDialog({ isOpen: false });
        void actionService.dispatch(
          "worktree.resource.openOnHost",
          { worktreeId: worktree.id },
          { source }
        );
      },
    });
  }, [worktree.id, worktree.issueTitle, worktree.branch, worktree.name, sshTarget, source]);

  // A move is two commands on two worktrees, so the one confirmation names both
  // (D2, bundled operations) — and moving a test device can mean reinstalling a
  // build for minutes.
  const confirmAttachmentMove = useCallback(
    (name: string, fromLabel: string, onConfirm: () => void) => {
      setConfirmDialog({
        isOpen: true,
        title: `Move '${name}' here?`,
        description: `This runs ${name}'s detach command against '${fromLabel}', then its attach command against this worktree. If the detach fails, ${name} stays on '${fromLabel}'.`,
        confirmLabel: "Move attachment",
        variant: "default",
        onConfirm: () => {
          setConfirmDialog({ isOpen: false });
          onConfirm();
        },
      });
    },
    []
  );

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
    handleResourceOpenOnHost,
    confirmAttachmentMove,
    handleSelectAllAgents,
    handleSelectWaitingAgents,
    handleSelectWorkingAgents,
  };
}
