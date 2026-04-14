import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import { projectStore } from "../../services/ProjectStore.js";
import type { HandlerDependencies } from "../types.js";
import type { TerminalRecipe } from "../../types/index.js";

export function registerGlobalRecipesHandlers(_deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleGetRecipes = async (): Promise<TerminalRecipe[]> => {
    return projectStore.getGlobalRecipes();
  };
  ipcMain.handle(CHANNELS.GLOBAL_GET_RECIPES, handleGetRecipes);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.GLOBAL_GET_RECIPES));

  const handleAddRecipe = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: { recipe: TerminalRecipe }
  ): Promise<void> => {
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
    return projectStore.addGlobalRecipe(recipe);
  };
  ipcMain.handle(CHANNELS.GLOBAL_ADD_RECIPE, handleAddRecipe);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.GLOBAL_ADD_RECIPE));

  const handleUpdateRecipe = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: {
      recipeId: string;
      updates: Partial<Omit<TerminalRecipe, "id" | "projectId" | "createdAt">>;
    }
  ): Promise<void> => {
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
    const immutableKeys = ["id", "projectId", "createdAt"] as const;
    for (const key of immutableKeys) {
      if (key in updates) {
        throw new Error(`Cannot update immutable field: ${key}`);
      }
    }
    const patch = updates as Record<string, unknown>;
    if ("terminals" in patch && !Array.isArray(patch.terminals)) {
      throw new Error("Invalid updates: terminals must be an array");
    }
    return projectStore.updateGlobalRecipe(recipeId, updates);
  };
  ipcMain.handle(CHANNELS.GLOBAL_UPDATE_RECIPE, handleUpdateRecipe);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.GLOBAL_UPDATE_RECIPE));

  const handleDeleteRecipe = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: { recipeId: string }
  ): Promise<void> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }
    const { recipeId } = payload;
    if (typeof recipeId !== "string" || !recipeId) {
      throw new Error("Invalid recipe ID");
    }
    return projectStore.deleteGlobalRecipe(recipeId);
  };
  ipcMain.handle(CHANNELS.GLOBAL_DELETE_RECIPE, handleDeleteRecipe);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.GLOBAL_DELETE_RECIPE));

  return () => handlers.forEach((cleanup) => cleanup());
}
