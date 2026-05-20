import type { IpcInvokeMap } from "../../types/index.js";
import type { TerminalRecipe } from "../../types/index.js";

// Opt out of `scripts/codegen/ipc-renderer.mjs` — `global:add-recipe`,
// `global:update-recipe`, and `global:delete-recipe` carry payload objects on
// the IPC channel while the renderer API keeps positional arguments
// (`addRecipe(recipe)`, `updateRecipe(recipeId, updates)`, `deleteRecipe(recipeId)`).
// The translation lives in the invoke wrappers below, so the generator must
// skip this namespace.
export const RENDERER_API_SKIP = true as const;

export const GLOBAL_RECIPES_METHOD_CHANNELS = {
  getRecipes: "global:get-recipes",
  addRecipe: "global:add-recipe",
  updateRecipe: "global:update-recipe",
  deleteRecipe: "global:delete-recipe",
} as const satisfies Record<string, keyof IpcInvokeMap>;

export interface GlobalRecipesPreloadBindings {
  getRecipes(): Promise<TerminalRecipe[]>;
  addRecipe(recipe: TerminalRecipe): Promise<void>;
  updateRecipe(
    recipeId: string,
    updates: Partial<Omit<TerminalRecipe, "id" | "projectId" | "createdAt" | "worktreeId">>
  ): Promise<void>;
  deleteRecipe(recipeId: string): Promise<void>;
}

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildGlobalRecipesPreloadBindings(invoke: Invoker): GlobalRecipesPreloadBindings {
  return {
    getRecipes: () =>
      invoke(GLOBAL_RECIPES_METHOD_CHANNELS.getRecipes) as Promise<TerminalRecipe[]>,
    addRecipe: (recipe) =>
      invoke(GLOBAL_RECIPES_METHOD_CHANNELS.addRecipe, { recipe }) as Promise<void>,
    updateRecipe: (recipeId, updates) =>
      invoke(GLOBAL_RECIPES_METHOD_CHANNELS.updateRecipe, {
        recipeId,
        updates,
      }) as Promise<void>,
    deleteRecipe: (recipeId) =>
      invoke(GLOBAL_RECIPES_METHOD_CHANNELS.deleteRecipe, { recipeId }) as Promise<void>,
  };
}
