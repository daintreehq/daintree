import type { TerminalRecipe } from "../types/index.js";
import fs from "fs/promises";
import { existsSync } from "fs";
import { resilientRename, resilientAtomicWriteFile } from "../utils/fs.js";
import { getProjectStateDir, recipesFilePath } from "./projectStorePaths.js";

export class ProjectFileStore {
  constructor(private projectsConfigDir: string) {}

  // --- Recipes ---

  async getRecipes(projectId: string): Promise<TerminalRecipe[]> {
    const filePath = recipesFilePath(this.projectsConfigDir, projectId);
    if (!filePath || !existsSync(filePath)) {
      return [];
    }

    try {
      const content = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(content);

      if (!Array.isArray(parsed)) {
        console.warn(`[ProjectFileStore] Invalid recipes format for ${projectId}, expected array`);
        return [];
      }

      return parsed.filter(
        (recipe: unknown): recipe is TerminalRecipe =>
          recipe !== null &&
          typeof recipe === "object" &&
          typeof (recipe as TerminalRecipe).id === "string" &&
          typeof (recipe as TerminalRecipe).name === "string" &&
          Array.isArray((recipe as TerminalRecipe).terminals)
      );
    } catch (error) {
      console.error(`[ProjectFileStore] Failed to load recipes for ${projectId}:`, error);
      try {
        const quarantinePath = `${filePath}.corrupted.${Date.now()}`;
        await resilientRename(filePath, quarantinePath);
        console.warn(`[ProjectFileStore] Corrupted recipes file moved to ${quarantinePath}`);
      } catch {
        // Ignore
      }
      return [];
    }
  }

  async saveRecipes(projectId: string, recipes: TerminalRecipe[]): Promise<void> {
    const stateDir = getProjectStateDir(this.projectsConfigDir, projectId);
    if (!stateDir) {
      throw new Error(`Invalid project ID: ${projectId}`);
    }

    const filePath = recipesFilePath(this.projectsConfigDir, projectId);
    if (!filePath) {
      throw new Error(`Invalid project ID: ${projectId}`);
    }

    const attemptSave = async (ensureDir: boolean): Promise<void> => {
      if (ensureDir) {
        await fs.mkdir(stateDir, { recursive: true });
      }
      await resilientAtomicWriteFile(filePath, JSON.stringify(recipes, null, 2), "utf-8");
    };

    try {
      await attemptSave(false);
    } catch (error) {
      const isEnoent = error instanceof Error && "code" in error && error.code === "ENOENT";
      if (!isEnoent) {
        console.error(`[ProjectFileStore] Failed to save recipes for ${projectId}:`, error);
        throw error;
      }

      try {
        await attemptSave(true);
      } catch (retryError) {
        console.error(`[ProjectFileStore] Failed to save recipes for ${projectId}:`, retryError);
        throw retryError;
      }
    }
  }

  async addRecipe(projectId: string, recipe: TerminalRecipe): Promise<void> {
    const recipes = await this.getRecipes(projectId);
    recipes.push(recipe);
    await this.saveRecipes(projectId, recipes);
  }

  async updateRecipe(
    projectId: string,
    recipeId: string,
    updates: Partial<Omit<TerminalRecipe, "id" | "projectId" | "createdAt">>
  ): Promise<void> {
    const recipes = await this.getRecipes(projectId);
    const index = recipes.findIndex((r) => r.id === recipeId);
    if (index === -1) {
      throw new Error(`Recipe ${recipeId} not found in project ${projectId}`);
    }
    // Defense-in-depth: strip immutable fields even if a caller bypasses
    // the compile-time Omit.
    const {
      id: _id,
      projectId: _pid,
      createdAt: _ca,
      ...safeUpdates
    } = updates as Record<string, unknown>;
    recipes[index] = { ...recipes[index], ...safeUpdates };
    await this.saveRecipes(projectId, recipes);
  }

  async deleteRecipe(projectId: string, recipeId: string): Promise<void> {
    const recipes = await this.getRecipes(projectId);
    const filtered = recipes.filter((r) => r.id !== recipeId);
    await this.saveRecipes(projectId, filtered);
  }
}
