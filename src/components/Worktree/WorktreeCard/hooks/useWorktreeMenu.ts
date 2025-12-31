import { useCallback, useMemo } from "react";
import type React from "react";
import { actionService } from "@/services/ActionService";
import { useNativeContextMenu } from "@/hooks";
import { useTerminalStore } from "@/store/terminalStore";
import type { MenuItemOption, TerminalRecipe, WorktreeState } from "@/types";

export function useWorktreeMenu({
  worktree,
  recipes,
  runningRecipeId,
  isRestartValidating,
  counts,
  launchAgents,
  onLaunchAgent,
  onOpenIssue,
  onOpenPR,
  onSaveLayout,
  onRestartAll,
  onCloseAll,
  onEndAll,
  onShowDeleteDialog,
}: {
  worktree: WorktreeState;
  recipes: TerminalRecipe[];
  runningRecipeId: string | null;
  isRestartValidating: boolean;
  counts: {
    grid: number;
    dock: number;
    active: number;
    completed: number;
    failed: number;
    all: number;
  };
  launchAgents: Array<{ id: string; label: string; isEnabled: boolean }>;
  onLaunchAgent?: (agentId: string) => void;
  onOpenIssue?: () => void;
  onOpenPR?: () => void;
  onSaveLayout?: () => void;
  onRestartAll: () => void;
  onCloseAll: () => void;
  onEndAll: () => void;
  onShowDeleteDialog: () => void;
}): {
  contextMenuTemplate: MenuItemOption[];
  handleContextMenu: (event: React.MouseEvent) => Promise<void>;
} {
  const { showMenu } = useNativeContextMenu();
  const isMainWorktree = worktree.isMainWorktree;
  const focusedTerminalId = useTerminalStore((state) => state.focusedId);

  const contextMenuTemplate = useMemo((): MenuItemOption[] => {
    const template: MenuItemOption[] = [
      { id: "label:launch", label: "Launch", enabled: false },
      ...launchAgents.map((agent) => ({
        id: `launch:${agent.id}`,
        label: agent.label,
        enabled: Boolean(onLaunchAgent && agent.isEnabled),
      })),
      { id: "launch:terminal", label: "Open Terminal", enabled: Boolean(onLaunchAgent) },
      { id: "launch:browser", label: "Open Browser", enabled: Boolean(onLaunchAgent) },
      { type: "separator" },

      { id: "label:sessions", label: "Sessions", enabled: false },
      {
        id: "sessions:minimize-all",
        label: `Minimize All (${counts.grid})`,
        enabled: counts.grid > 0,
      },
      {
        id: "sessions:maximize-all",
        label: `Maximize All (${counts.dock})`,
        enabled: counts.dock > 0,
      },
      {
        id: "sessions:restart-all",
        label: `${isRestartValidating ? "Checking..." : "Restart All"} (${counts.active})`,
        enabled: counts.active > 0 && !isRestartValidating,
      },
      {
        id: "sessions:reset-renderers",
        label: `Reset All Renderers (${counts.active})`,
        enabled: counts.active > 0,
      },
      { type: "separator" },

      {
        id: "sessions:close-completed",
        label: `Close Completed (${counts.completed})`,
        enabled: counts.completed > 0,
      },
      {
        id: "sessions:close-failed",
        label: `Close Failed (${counts.failed})`,
        enabled: counts.failed > 0,
      },
      { type: "separator" },

      {
        id: "sessions:close-all",
        label: `Close All (Trash) (${counts.active})`,
        enabled: counts.active > 0,
      },
      {
        id: "sessions:end-all",
        label: `End All (Kill) (${counts.all})`,
        enabled: counts.all > 0,
      },
      { type: "separator" },

      { id: "label:worktree", label: "Worktree", enabled: false },
      {
        id: "worktree:copy-context",
        label: "Copy Context",
        submenu: [
          { id: "worktree:copy-context:full", label: "Full Context" },
          { id: "worktree:copy-context:modified", label: "Modified Files Only" },
        ],
      },
      {
        id: "worktree:inject-context",
        label: "Inject Context into Focused Terminal",
        enabled: focusedTerminalId !== null,
      },
      { id: "worktree:open-editor", label: "Open in Editor" },
      { id: "worktree:reveal", label: "Reveal in Finder" },
    ];

    const hasIssueItem = Boolean(worktree.issueNumber && onOpenIssue);
    const hasPrItem = Boolean(worktree.issueNumber && worktree.prNumber && onOpenPR);
    if (hasIssueItem || hasPrItem) {
      template.push({ type: "separator" });
      if (hasIssueItem) {
        template.push({
          id: "worktree:open-issue",
          label: `Open Issue #${worktree.issueNumber}`,
        });
      }
      if (hasPrItem) {
        template.push({
          id: "worktree:open-pr",
          label: `Open PR #${worktree.prNumber}`,
        });
      }
    }

    const hasRecipeSection = recipes.length > 0 || (onSaveLayout && counts.active > 0);
    if (hasRecipeSection) {
      template.push({ type: "separator" });
      template.push({ id: "label:recipes", label: "Recipes", enabled: false });

      if (recipes.length > 0) {
        template.push({
          id: "recipes:run",
          label: "Run Recipe",
          submenu: recipes.map((recipe) => ({
            id: `recipes:run:${recipe.id}`,
            label: recipe.name,
            enabled: runningRecipeId === null,
          })),
        });
      }

      if (onSaveLayout && counts.active > 0) {
        template.push({ id: "recipes:save-layout", label: "Save Layout as Recipe" });
      }
    }

    if (!isMainWorktree) {
      template.push({ type: "separator" });
      template.push({
        id: "worktree:delete",
        label: "Delete Worktree...",
      });
    }

    return template;
  }, [
    counts.active,
    counts.all,
    counts.completed,
    counts.dock,
    counts.failed,
    counts.grid,
    focusedTerminalId,
    isMainWorktree,
    isRestartValidating,
    launchAgents,
    onLaunchAgent,
    onOpenIssue,
    onOpenPR,
    onSaveLayout,
    recipes,
    runningRecipeId,
    worktree.issueNumber,
    worktree.prNumber,
  ]);

  const handleContextMenu = useCallback(
    async (event: React.MouseEvent) => {
      const actionId = await showMenu(event, contextMenuTemplate);
      if (!actionId) return;

      if (actionId.startsWith("launch:")) {
        const agentId = actionId.slice("launch:".length);
        void actionService.dispatch(
          "agent.launch",
          { agentId, worktreeId: worktree.id, location: "grid" },
          { source: "context-menu" }
        );
        return;
      }

      if (actionId.startsWith("recipes:run:")) {
        const recipeId = actionId.slice("recipes:run:".length);
        void actionService.dispatch(
          "recipe.run",
          { recipeId, worktreeId: worktree.id },
          { source: "context-menu" }
        );
        return;
      }

      switch (actionId) {
        case "sessions:minimize-all":
          void actionService.dispatch(
            "worktree.sessions.minimizeAll",
            { worktreeId: worktree.id },
            { source: "context-menu" }
          );
          break;
        case "sessions:maximize-all":
          void actionService.dispatch(
            "worktree.sessions.maximizeAll",
            { worktreeId: worktree.id },
            { source: "context-menu" }
          );
          break;
        case "sessions:restart-all":
          onRestartAll();
          break;
        case "sessions:reset-renderers":
          void actionService.dispatch(
            "worktree.sessions.resetRenderers",
            { worktreeId: worktree.id },
            { source: "context-menu" }
          );
          break;
        case "sessions:close-completed":
          void actionService.dispatch(
            "worktree.sessions.closeCompleted",
            { worktreeId: worktree.id },
            { source: "context-menu" }
          );
          break;
        case "sessions:close-failed":
          void actionService.dispatch(
            "worktree.sessions.closeFailed",
            { worktreeId: worktree.id },
            { source: "context-menu" }
          );
          break;
        case "sessions:close-all":
          onCloseAll();
          break;
        case "sessions:end-all":
          onEndAll();
          break;
        case "worktree:copy-context:full":
          void actionService.dispatch(
            "worktree.copyTree",
            { worktreeId: worktree.id },
            { source: "context-menu" }
          );
          break;
        case "worktree:copy-context:modified":
          void actionService.dispatch(
            "worktree.copyTree",
            { worktreeId: worktree.id, modified: true },
            { source: "context-menu" }
          );
          break;
        case "worktree:inject-context":
          void actionService.dispatch(
            "worktree.inject",
            { worktreeId: worktree.id },
            { source: "context-menu" }
          );
          break;
        case "worktree:open-editor":
          void actionService.dispatch(
            "worktree.openEditor",
            { worktreeId: worktree.id },
            { source: "context-menu" }
          );
          break;
        case "worktree:reveal":
          void actionService.dispatch(
            "worktree.reveal",
            { worktreeId: worktree.id },
            { source: "context-menu" }
          );
          break;
        case "worktree:open-issue":
          void actionService.dispatch(
            "worktree.openIssue",
            { worktreeId: worktree.id },
            { source: "context-menu" }
          );
          break;
        case "worktree:open-pr":
          void actionService.dispatch(
            "worktree.openPR",
            { worktreeId: worktree.id },
            { source: "context-menu" }
          );
          break;
        case "recipes:save-layout":
          void actionService.dispatch(
            "recipe.editor.openFromLayout",
            { worktreeId: worktree.id },
            { source: "context-menu" }
          );
          break;
        case "worktree:delete":
          onShowDeleteDialog();
          break;
      }
    },
    [
      contextMenuTemplate,
      onCloseAll,
      onEndAll,
      onRestartAll,
      onShowDeleteDialog,
      showMenu,
      worktree.id,
    ]
  );

  return { contextMenuTemplate, handleContextMenu };
}
