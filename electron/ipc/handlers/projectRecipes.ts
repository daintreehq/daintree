import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import { projectStore } from "../../services/ProjectStore.js";
import type { HandlerDependencies } from "../types.js";
import type { TerminalRecipe } from "../../types/index.js";

export function registerProjectRecipesHandlers(_deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleProjectGetRecipes = async (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string
  ): Promise<TerminalRecipe[]> => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    return projectStore.getRecipes(projectId);
  };
  ipcMain.handle(CHANNELS.PROJECT_GET_RECIPES, handleProjectGetRecipes);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_GET_RECIPES));

  const handleProjectSaveRecipes = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: { projectId: string; recipes: TerminalRecipe[] }
  ): Promise<void> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }
    const { projectId, recipes } = payload;
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    if (!Array.isArray(recipes)) {
      throw new Error("Invalid recipes array");
    }
    return projectStore.saveRecipes(projectId, recipes);
  };
  ipcMain.handle(CHANNELS.PROJECT_SAVE_RECIPES, handleProjectSaveRecipes);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_SAVE_RECIPES));

  const handleProjectAddRecipe = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: { projectId: string; recipe: TerminalRecipe }
  ): Promise<void> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }
    const { projectId, recipe } = payload;
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    if (!recipe || typeof recipe !== "object") {
      throw new Error("Invalid recipe");
    }
    if (recipe.projectId !== projectId) {
      throw new Error("Recipe projectId does not match target project");
    }
    if (!recipe.id || !recipe.name || !Array.isArray(recipe.terminals)) {
      throw new Error("Recipe missing required fields (id, name, terminals)");
    }
    if (typeof recipe.createdAt !== "number") {
      throw new Error("Recipe createdAt must be a number");
    }
    return projectStore.addRecipe(projectId, recipe);
  };
  ipcMain.handle(CHANNELS.PROJECT_ADD_RECIPE, handleProjectAddRecipe);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_ADD_RECIPE));

  const handleProjectUpdateRecipe = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: {
      projectId: string;
      recipeId: string;
      updates: Partial<Omit<TerminalRecipe, "id" | "projectId" | "createdAt">>;
    }
  ): Promise<void> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }
    const { projectId, recipeId, updates } = payload;
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    if (typeof recipeId !== "string" || !recipeId) {
      throw new Error("Invalid recipe ID");
    }
    if (!updates || typeof updates !== "object") {
      throw new Error("Invalid updates");
    }
    return projectStore.updateRecipe(projectId, recipeId, updates);
  };
  ipcMain.handle(CHANNELS.PROJECT_UPDATE_RECIPE, handleProjectUpdateRecipe);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_UPDATE_RECIPE));

  const handleProjectDeleteRecipe = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: { projectId: string; recipeId: string }
  ): Promise<void> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }
    const { projectId, recipeId } = payload;
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    if (typeof recipeId !== "string" || !recipeId) {
      throw new Error("Invalid recipe ID");
    }
    return projectStore.deleteRecipe(projectId, recipeId);
  };
  ipcMain.handle(CHANNELS.PROJECT_DELETE_RECIPE, handleProjectDeleteRecipe);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_DELETE_RECIPE));

  return () => handlers.forEach((cleanup) => cleanup());
}
