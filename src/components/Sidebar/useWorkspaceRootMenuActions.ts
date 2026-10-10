import { useRef, useState } from "react";
import type { WorkspaceRoot } from "@/hooks/useWorkspaceRoot";
import { useWorktreeActions } from "@/hooks/useWorktreeActions";
import { getAgentConfig, getAgentIds } from "@/config/agents";
import { isAssistantOnlyAgentId } from "@shared/config/agentIds";
import { getAgentSettingsEntry } from "@/types";
import { isAgentLaunchable } from "@shared/utils/agentAvailability";
import { isAgentPinned } from "@shared/utils/agentPinned";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { useRecipeStore } from "@/store/recipeStore";
import { actionService } from "@/services/ActionService";
import { copyWithToast } from "@/lib/copyWithToast";
import { notifyRecipeSpawnFailures } from "@/utils/recipeNotify";
import { logError } from "@/utils/logger";
import type { WorktreeMenuActions } from "@/components/Worktree/WorktreeMenuItems";

/**
 * The menu a worktree-less workspace offers — a scratch, or a folder opened
 * without git (#13225). Built once and handed to both the ⋯ dropdown and the
 * right-click menu, so the two can't drift.
 *
 * Only rows that act on the workspace root are wired, and every one of them
 * dispatches without a worktree id: the launch and copy paths fall back to the
 * root (`resolveWorkspaceCwd`, #13210), and stamping `workspace.id` or
 * `NO_WORKTREE` onto a dispatch would read as a worktree that doesn't exist.
 * Sessions, save-layout and the dev-server rows are left out because their
 * actions resolve a worktree id and silently no-op without one.
 */
export function useWorkspaceRootMenuActions(workspace: WorkspaceRoot): WorktreeMenuActions {
  const agentSettings = useAgentSettingsStore((state) => state.settings);
  const availability = useCliAvailabilityStore((state) => state.availability);
  const allRecipes = useRecipeStore((state) => state.recipes);
  const runRecipeWithResults = useRecipeStore((state) => state.runRecipeWithResults);
  const { handleCopyTree } = useWorktreeActions();

  const [runningRecipeId, setRunningRecipeId] = useState<string | null>(null);
  // State alone can't stop a double press: both clicks land before the first
  // `setRunningRecipeId` commits.
  const recipeInFlight = useRef(false);

  // Same roster rules as the worktree card's Launch submenu.
  const baseIds = getAgentIds();
  const settingsIds = agentSettings?.agents ? Object.keys(agentSettings.agents) : [];
  const launchAgents = [...baseIds, ...settingsIds.filter((id) => !baseIds.includes(id)).sort()]
    .filter((id) => !isAssistantOnlyAgentId(id))
    .filter((id) => isAgentPinned(getAgentSettingsEntry(agentSettings, id)))
    .map((id) => {
      const config = getAgentConfig(id);
      return {
        id,
        name: config?.name ?? id,
        icon: config?.icon,
        isEnabled: isAgentLaunchable(availability?.[id]),
      };
    });

  // Project-wide recipes only: one scoped to a worktree id can never match a
  // workspace that has none.
  const recipes = allRecipes
    .filter((recipe) => recipe.worktreeId === undefined)
    .map((recipe) => ({ id: recipe.id, name: recipe.name }));

  const handleRunRecipe = (recipeId: string) => {
    if (recipeInFlight.current) return;
    recipeInFlight.current = true;
    setRunningRecipeId(recipeId);
    const recipeState = useRecipeStore.getState();
    void runRecipeWithResults(recipeId, workspace.path, undefined, {
      worktreePath: workspace.path,
    })
      .then((results) => {
        notifyRecipeSpawnFailures(results, {
          recipeName: recipeState.getRecipeById(recipeId)?.name,
          projectId: recipeState.currentProjectId ?? undefined,
        });
      })
      .catch((error: unknown) => {
        logError("Failed to run recipe", error);
      })
      .finally(() => {
        recipeInFlight.current = false;
        setRunningRecipeId(null);
      });
  };

  return {
    launchAgents,
    recipes,
    runningRecipeId,
    onLaunchAgent: (agentId) => {
      void actionService.dispatch(
        "agent.launch",
        { agentId, location: "grid" },
        { source: "user" }
      );
    },
    // Unlike the card, nothing to select first: the workspace is the only place
    // a panel can land.
    onOpenPanelPalette: (source) => {
      void actionService.dispatch("panel.palette", undefined, { source });
    },
    onOpenFileBrowser: () => {
      void actionService.dispatch("worktree.openFileBrowserPanel", undefined, { source: "user" });
    },
    // `file.openInEditor`, not `worktree.openEditor`: the latter resolves a
    // worktree id and returns without one.
    onOpenEditor: () => {
      void actionService.dispatch(
        "file.openInEditor",
        { path: workspace.path },
        { source: "user" }
      );
    },
    onRevealInFinder: () => {
      void actionService.dispatch("system.openPath", { path: workspace.path }, { source: "user" });
    },
    onCopyContextFull: () => {
      void handleCopyTree(null);
    },
    onCopyPath: () => {
      copyWithToast("Path", workspace.path);
    },
    onRunRecipe: handleRunRecipe,
  };
}
