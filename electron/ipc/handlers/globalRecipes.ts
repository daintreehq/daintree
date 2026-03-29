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
    if (!recipe.id || !recipe.name || !Array.isArray(recipe.terminals)) {
      throw new Error("Recipe missing required fields (id, name, terminals)");
    }
    if (typeof recipe.createdAt !== "number") {
      throw new Error("Recipe createdAt must be a number");
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
    if (!updates || typeof updates !== "object") {
      throw new Error("Invalid updates");
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
