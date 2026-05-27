import { projectStore } from "../../services/ProjectStore.js";
import type { TerminalRecipe } from "../../types/index.js";
import { defineIpcNamespace, op } from "../define.js";
import { GLOBAL_RECIPES_METHOD_CHANNELS } from "./globalRecipes.preload.js";
import { assertNoSecretEnvValues, assertRecipeUsageFields } from "./recipeValidation.js";

export const globalRecipesNamespace = defineIpcNamespace({
  name: "global-recipes",
  ops: {
    getRecipes: op(
      GLOBAL_RECIPES_METHOD_CHANNELS.getRecipes,
      async (): Promise<TerminalRecipe[]> => {
        return projectStore.getGlobalRecipes();
      }
    ),
    addRecipe: op(
      GLOBAL_RECIPES_METHOD_CHANNELS.addRecipe,
      async (payload: { recipe: TerminalRecipe }): Promise<void> => {
        if (!payload || typeof payload !== "object") {
          throw new Error("Invalid payload");
        }
        const { recipe } = payload;
        if (!recipe || typeof recipe !== "object") {
          throw new Error("Invalid recipe");
        }
        if (recipe.projectId !== undefined) {
          throw new Error("Global recipe must not have a projectId");
        }
        if (recipe.worktreeId !== undefined) {
          throw new Error("Global recipe must not have a worktreeId");
        }
        if (
          typeof recipe.id !== "string" ||
          !recipe.id.trim() ||
          typeof recipe.name !== "string" ||
          !recipe.name.trim() ||
          !Array.isArray(recipe.terminals)
        ) {
          throw new Error("Recipe missing required fields (id, name, terminals)");
        }
        if (!Number.isFinite(recipe.createdAt)) {
          throw new Error("Recipe createdAt must be a finite number");
        }
        assertRecipeUsageFields(recipe);
        assertNoSecretEnvValues(recipe.terminals);
        return projectStore.addGlobalRecipe(recipe);
      }
    ),
    updateRecipe: op(
      GLOBAL_RECIPES_METHOD_CHANNELS.updateRecipe,
      async (payload: {
        recipeId: string;
        updates: Partial<Omit<TerminalRecipe, "id" | "projectId" | "createdAt" | "worktreeId">>;
      }): Promise<void> => {
        if (!payload || typeof payload !== "object") {
          throw new Error("Invalid payload");
        }
        const { recipeId, updates } = payload;
        if (typeof recipeId !== "string" || !recipeId) {
          throw new Error("Invalid recipe ID");
        }
        if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
          throw new Error("Invalid updates");
        }
        const immutableKeys = ["id", "projectId", "createdAt", "worktreeId"] as const;
        for (const key of immutableKeys) {
          if (key in updates) {
            throw new Error(`Cannot update immutable field: ${key}`);
          }
        }
        const patch = updates as Record<string, unknown>;
        if ("terminals" in patch && !Array.isArray(patch.terminals)) {
          throw new Error("Invalid updates: terminals must be an array");
        }
        assertRecipeUsageFields(patch);
        if (Array.isArray(patch.terminals)) {
          assertNoSecretEnvValues(patch.terminals as TerminalRecipe["terminals"]);
        }
        return projectStore.updateGlobalRecipe(recipeId, updates);
      }
    ),
    deleteRecipe: op(
      GLOBAL_RECIPES_METHOD_CHANNELS.deleteRecipe,
      async (payload: { recipeId: string }): Promise<void> => {
        if (!payload || typeof payload !== "object") {
          throw new Error("Invalid payload");
        }
        const { recipeId } = payload;
        if (typeof recipeId !== "string" || !recipeId) {
          throw new Error("Invalid recipe ID");
        }
        return projectStore.deleteGlobalRecipe(recipeId);
      }
    ),
  },
});

export function registerGlobalRecipesHandlers(): () => void {
  return globalRecipesNamespace.register();
}
