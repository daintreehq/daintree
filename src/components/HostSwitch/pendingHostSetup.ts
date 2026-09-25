import type { PendingHostSetup } from "@shared/types/ipc/projectMatch";
import { actionService } from "@/services/ActionService";
import { useRecipeStore } from "@/store/recipeStore";
import { logWarn } from "@/utils/logger";

const RECIPES_READY_TIMEOUT_MS = 15_000;

function recipesReadyFor(projectId: string): Promise<boolean> {
  const ready = () => {
    const state = useRecipeStore.getState();
    return state.currentProjectId === projectId && !state.isLoading;
  };
  if (ready()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(false);
    }, RECIPES_READY_TIMEOUT_MS);
    const unsubscribe = useRecipeStore.subscribe(() => {
      if (!ready()) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(true);
    });
  });
}

/**
 * The setup recipe chosen when this project was cloned onto its host runs
 * once, in the first view that opens it, the way a new worktree's recipe
 * does. Views of projects that never came through a switch find nothing.
 */
export async function runPendingHostSetup(projectId: string): Promise<void> {
  const projectMatch = window.electron?.projectMatch;
  if (typeof projectMatch?.takePendingSetup !== "function") return;
  let setup: PendingHostSetup | null;
  try {
    setup = await projectMatch.takePendingSetup({ projectId });
  } catch {
    return;
  }
  if (!setup) return;
  if (!(await recipesReadyFor(projectId))) {
    logWarn("[HostSwitch] Recipes didn't load; skipped the setup recipe", { projectId });
    return;
  }
  const result = await actionService.dispatch(
    "recipe.run",
    { recipeId: setup.recipeId, ...(setup.worktreePath ? { worktreeId: setup.worktreePath } : {}) },
    { source: "user" }
  );
  if (!result.ok) logWarn("[HostSwitch] The setup recipe didn't run", { error: result.error });
}
