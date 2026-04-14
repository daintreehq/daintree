import type { TerminalRecipe } from "../types/index.js";
import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { resilientRename, resilientAtomicWriteFile } from "../utils/fs.js";

const RECIPES_FILENAME = "recipes.json";

export class GlobalFileStore {
  private recipesPath: string;

  constructor(private globalConfigDir: string) {
    this.recipesPath = path.join(globalConfigDir, RECIPES_FILENAME);
  }

  async getRecipes(): Promise<TerminalRecipe[]> {
    if (!existsSync(this.recipesPath)) {
      return [];
    }

    try {
      const content = await fs.readFile(this.recipesPath, "utf-8");
      const parsed = JSON.parse(content);

      if (!Array.isArray(parsed)) {
        console.warn("[GlobalFileStore] Invalid recipes format, expected array");
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
      console.error("[GlobalFileStore] Failed to load recipes:", error);
      try {
        const quarantinePath = `${this.recipesPath}.corrupted`;
        await resilientRename(this.recipesPath, quarantinePath);
        console.warn(`[GlobalFileStore] Corrupted recipes file moved to ${quarantinePath}`);
      } catch {
        // Ignore
      }
      return [];
    }
  }

  async saveRecipes(recipes: TerminalRecipe[]): Promise<void> {
    const attemptSave = async (ensureDir: boolean): Promise<void> => {
      if (ensureDir) {
        await fs.mkdir(this.globalConfigDir, { recursive: true });
      }
      await resilientAtomicWriteFile(this.recipesPath, JSON.stringify(recipes, null, 2), "utf-8");
    };

    try {
      await attemptSave(false);
    } catch (error) {
      const isEnoent = error instanceof Error && "code" in error && error.code === "ENOENT";
      if (!isEnoent) {
        console.error("[GlobalFileStore] Failed to save recipes:", error);
        throw error;
      }

      try {
        await attemptSave(true);
      } catch (retryError) {
        console.error("[GlobalFileStore] Failed to save recipes:", retryError);
        throw retryError;
      }
    }
  }

  async addRecipe(recipe: TerminalRecipe): Promise<void> {
    const recipes = await this.getRecipes();
    recipes.push(recipe);
    await this.saveRecipes(recipes);
  }

  async updateRecipe(
    recipeId: string,
    updates: Partial<Omit<TerminalRecipe, "id" | "projectId" | "createdAt">>
  ): Promise<void> {
    const recipes = await this.getRecipes();
    const index = recipes.findIndex((r) => r.id === recipeId);
    if (index === -1) {
      throw new Error(`Global recipe ${recipeId} not found`);
    }
    // Defense-in-depth: strip immutable fields even if a caller bypasses
    // the compile-time Omit (e.g., via untyped bridge or JSON payload).
    const {
      id: _id,
      projectId: _pid,
      createdAt: _ca,
      ...safeUpdates
    } = updates as Record<string, unknown>;
    recipes[index] = { ...recipes[index], ...safeUpdates };
    await this.saveRecipes(recipes);
  }

  async deleteRecipe(recipeId: string): Promise<void> {
    const recipes = await this.getRecipes();
    const filtered = recipes.filter((r) => r.id !== recipeId);
    await this.saveRecipes(filtered);
  }
}
