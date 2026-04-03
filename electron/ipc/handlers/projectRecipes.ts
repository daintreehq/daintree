import { ipcMain, dialog } from "electron";
import { getWindowForWebContents } from "../../window/webContentsRegistry.js";
import fs from "fs/promises";
import { CHANNELS } from "../channels.js";
import { projectStore } from "../../services/ProjectStore.js";
import { safeRecipeFilename } from "../../utils/recipeFilename.js";
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

  const handleRecipeExportFile = async (
    event: Electron.IpcMainInvokeEvent,
    payload: { name: string; json: string }
  ): Promise<boolean> => {
    if (!payload || typeof payload.name !== "string" || typeof payload.json !== "string") {
      throw new Error("Invalid payload");
    }
    const win = getWindowForWebContents(event.sender) ?? undefined;
    const defaultFilename = safeRecipeFilename(payload.name);
    const dialogOptions: Electron.SaveDialogOptions = {
      title: "Export Recipe",
      defaultPath: defaultFilename,
      filters: [{ name: "Recipe Files", extensions: ["json"] }],
    };
    const { filePath, canceled } = win
      ? await dialog.showSaveDialog(win, dialogOptions)
      : await dialog.showSaveDialog(dialogOptions);
    if (canceled || !filePath) return false;
    await fs.writeFile(filePath, payload.json, "utf-8");
    return true;
  };
  ipcMain.handle(CHANNELS.RECIPE_EXPORT_FILE, handleRecipeExportFile);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.RECIPE_EXPORT_FILE));

  const handleRecipeImportFile = async (
    event: Electron.IpcMainInvokeEvent
  ): Promise<string | null> => {
    const win = getWindowForWebContents(event.sender) ?? undefined;
    const dialogOptions: Electron.OpenDialogOptions = {
      title: "Import Recipe",
      filters: [{ name: "Recipe Files", extensions: ["json"] }],
      properties: ["openFile"],
    };
    const { filePaths, canceled } = win
      ? await dialog.showOpenDialog(win, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (canceled || filePaths.length === 0) return null;
    return fs.readFile(filePaths[0]!, "utf-8");
  };
  ipcMain.handle(CHANNELS.RECIPE_IMPORT_FILE, handleRecipeImportFile);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.RECIPE_IMPORT_FILE));

  const handleProjectGetInRepoRecipes = async (
    _event: Electron.IpcMainInvokeEvent,
    projectId: string
  ): Promise<TerminalRecipe[]> => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    const project = projectStore.getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }
    return projectStore.readInRepoRecipes(project.path);
  };
  ipcMain.handle(CHANNELS.PROJECT_GET_INREPO_RECIPES, handleProjectGetInRepoRecipes);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_GET_INREPO_RECIPES));

  const handleProjectSyncInRepoRecipes = async (
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
    const project = projectStore.getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }
    for (const recipe of recipes) {
      await projectStore.writeInRepoRecipe(project.path, recipe);
    }
  };
  ipcMain.handle(CHANNELS.PROJECT_SYNC_INREPO_RECIPES, handleProjectSyncInRepoRecipes);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_SYNC_INREPO_RECIPES));

  const handleProjectWriteInRepoRecipe = async (
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
    if (!recipe || typeof recipe !== "object" || !recipe.name || !Array.isArray(recipe.terminals)) {
      throw new Error("Invalid recipe");
    }
    const project = projectStore.getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }
    await projectStore.writeInRepoRecipe(project.path, recipe);
  };
  ipcMain.handle(CHANNELS.PROJECT_WRITE_INREPO_RECIPE, handleProjectWriteInRepoRecipe);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_WRITE_INREPO_RECIPE));

  const handleProjectDeleteInRepoRecipe = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: { projectId: string; recipeName: string }
  ): Promise<void> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }
    const { projectId, recipeName } = payload;
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    if (typeof recipeName !== "string" || !recipeName) {
      throw new Error("Invalid recipe name");
    }
    const project = projectStore.getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }
    await projectStore.deleteInRepoRecipe(project.path, recipeName);
  };
  ipcMain.handle(CHANNELS.PROJECT_DELETE_INREPO_RECIPE, handleProjectDeleteInRepoRecipe);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PROJECT_DELETE_INREPO_RECIPE));

  return () => handlers.forEach((cleanup) => cleanup());
}
