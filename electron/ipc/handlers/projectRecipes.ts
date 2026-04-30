import { dialog } from "electron";
import fs from "fs/promises";
import { CHANNELS } from "../channels.js";
import { projectStore } from "../../services/ProjectStore.js";
import { safeRecipeFilename } from "../../utils/recipeFilename.js";
import { stableInRepoId } from "../../../shared/utils/recipeFilename.js";
import type { HandlerDependencies } from "../types.js";
import type { TerminalRecipe } from "../../types/index.js";
import { typedHandle, typedHandleWithContext } from "../utils.js";

export function registerProjectRecipesHandlers(_deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleProjectGetRecipes = async (projectId: string): Promise<TerminalRecipe[]> => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    const project = projectStore.getProjectById(projectId);
    if (project) {
      try {
        await projectStore.reconcileProjectRecipes(project.path, projectId);
      } catch (error) {
        console.error(`[projectRecipes] Reconciliation failed for ${projectId}:`, error);
      }
    }
    return projectStore.getRecipes(projectId);
  };
  handlers.push(typedHandle(CHANNELS.PROJECT_GET_RECIPES, handleProjectGetRecipes));

  const handleProjectSaveRecipes = async (payload: {
    projectId: string;
    recipes: TerminalRecipe[];
  }): Promise<void> => {
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
  handlers.push(typedHandle(CHANNELS.PROJECT_SAVE_RECIPES, handleProjectSaveRecipes));

  const handleProjectAddRecipe = async (payload: {
    projectId: string;
    recipe: TerminalRecipe;
  }): Promise<void> => {
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
  handlers.push(typedHandle(CHANNELS.PROJECT_ADD_RECIPE, handleProjectAddRecipe));

  const handleProjectUpdateRecipe = async (payload: {
    projectId: string;
    recipeId: string;
    updates: Partial<Omit<TerminalRecipe, "id" | "projectId" | "createdAt">>;
  }): Promise<void> => {
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
  handlers.push(typedHandle(CHANNELS.PROJECT_UPDATE_RECIPE, handleProjectUpdateRecipe));

  const handleProjectDeleteRecipe = async (payload: {
    projectId: string;
    recipeId: string;
  }): Promise<void> => {
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
    // If this recipe also exists in .daintree/ (e.g. a promoted legacy recipe
    // whose ID doesn't start with inrepo-), clean the canonical copy too.
    // Otherwise reconciliation on next load will resurrect it.
    const project = projectStore.getProjectById(projectId);
    if (project) {
      try {
        const inRepoRecipes = await projectStore.readInRepoRecipes(project.path);
        const match = inRepoRecipes.find((r) => r.id === recipeId);
        if (match) {
          await projectStore.deleteInRepoRecipe(project.path, match.name);
        }
      } catch (error) {
        console.error(`[projectRecipes] Failed to clean in-repo copy for ${recipeId}:`, error);
      }
    }
    return projectStore.deleteRecipe(projectId, recipeId);
  };
  handlers.push(typedHandle(CHANNELS.PROJECT_DELETE_RECIPE, handleProjectDeleteRecipe));

  handlers.push(
    typedHandleWithContext(
      CHANNELS.RECIPE_EXPORT_FILE,
      async (ctx, payload: { name: string; json: string }): Promise<boolean> => {
        if (!payload || typeof payload.name !== "string" || typeof payload.json !== "string") {
          throw new Error("Invalid payload");
        }
        const win = ctx.senderWindow ?? undefined;
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
      }
    )
  );

  handlers.push(
    typedHandleWithContext(CHANNELS.RECIPE_IMPORT_FILE, async (ctx): Promise<string | null> => {
      const win = ctx.senderWindow ?? undefined;
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
    })
  );

  const handleProjectGetInRepoRecipes = async (projectId: string): Promise<TerminalRecipe[]> => {
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Invalid project ID");
    }
    const project = projectStore.getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }
    return projectStore.readInRepoRecipes(project.path);
  };
  handlers.push(typedHandle(CHANNELS.PROJECT_GET_INREPO_RECIPES, handleProjectGetInRepoRecipes));

  const handleProjectSyncInRepoRecipes = async (payload: {
    projectId: string;
    recipes: TerminalRecipe[];
  }): Promise<void> => {
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
  handlers.push(typedHandle(CHANNELS.PROJECT_SYNC_INREPO_RECIPES, handleProjectSyncInRepoRecipes));

  const handleProjectUpdateInRepoRecipe = async (payload: {
    projectId: string;
    recipe: TerminalRecipe;
    previousName?: string;
  }): Promise<void> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }
    const { projectId, recipe, previousName } = payload;
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
    if (
      previousName &&
      typeof previousName === "string" &&
      safeRecipeFilename(previousName) !== safeRecipeFilename(recipe.name)
    ) {
      await projectStore.deleteInRepoRecipe(project.path, previousName);
    }
  };
  handlers.push(
    typedHandle(CHANNELS.PROJECT_UPDATE_INREPO_RECIPE, handleProjectUpdateInRepoRecipe)
  );

  const handleProjectDeleteInRepoRecipe = async (payload: {
    projectId: string;
    recipeName: string;
  }): Promise<void> => {
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
    let recipeId: string | null = null;
    try {
      const inRepoRecipes = await projectStore.readInRepoRecipes(project.path);
      const match = inRepoRecipes.find((r) => r.name === recipeName);
      if (match) recipeId = match.id;
    } catch {
      // If we can't read in-repo, fall back to the computed ID
    }
    await projectStore.deleteInRepoRecipe(project.path, recipeName);
    try {
      const targetId = recipeId ?? stableInRepoId(recipeName);
      await projectStore.deleteRecipe(projectId, targetId);
    } catch {
      // Best-effort: reconciliation on next load will catch any misses
    }
  };
  handlers.push(
    typedHandle(CHANNELS.PROJECT_DELETE_INREPO_RECIPE, handleProjectDeleteInRepoRecipe)
  );

  return () => handlers.forEach((cleanup) => cleanup());
}
