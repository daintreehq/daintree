import type { TerminalRecipe } from "../types/index.js";
import fs from "fs/promises";
import path from "path";
import { resilientRename, resilientAtomicWriteFile } from "../utils/fs.js";
import { TerminalRecipeSchema, filterValidTerminalEntries } from "../schemas/ipc.js";

const RECIPES_FILENAME = "recipes.json";

export class GlobalFileStore {
  private recipesPath: string;

  // Serialize read-modify-write cycles for the single global recipes file.
  // ipcMain.handle runs handlers concurrently, so two unqueued mutations read
  // the same snapshot and the last write clobbers the other. One file, so a
  // single scalar tail (no per-key map) suffices.
  private recipesWriteTail: Promise<void> = Promise.resolve();

  constructor(private globalConfigDir: string) {
    this.recipesPath = path.join(globalConfigDir, RECIPES_FILENAME);
  }

  /**
   * Serialize recipe read-modify-write updates. Each queued updater runs after
   * the previous has committed, so its reads see the prior write's result. The
   * updater does its own reads (via {@link getRecipes}) and returns the list to
   * persist, or `null` to skip the write. Updaters must not call another queued
   * method (they would chain behind the awaiting outer turn and self-deadlock);
   * the unqueued {@link getRecipes} is safe. `.catch(() => {})` keeps one failed
   * update from poisoning the chain — the failure still reaches its own caller.
   */
  private enqueueRecipesUpdate(
    updater: () => TerminalRecipe[] | null | Promise<TerminalRecipe[] | null>
  ): Promise<void> {
    const next = this.recipesWriteTail
      .catch(() => {})
      .then(async () => {
        const updated = await updater();
        if (updated !== null) {
          await this.saveRecipesInner(updated);
        }
      });
    this.recipesWriteTail = next;
    return next;
  }

  async getRecipes(): Promise<TerminalRecipe[]> {
    let content: string;
    try {
      content = await fs.readFile(this.recipesPath, "utf-8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      // A transient read failure (EACCES/EIO/EBUSY) is NOT corruption. Returning
      // [] here would let a queued mutator (add/update/delete) overwrite the
      // whole store from an empty base — silent data loss. Rethrow so the
      // mutator aborts and the on-disk recipes survive (mirrors
      // ProjectFileStore.getRecipes).
      console.error("[GlobalFileStore] Failed to read recipes:", error);
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
      if (!Array.isArray(parsed)) {
        throw new Error("recipes is not an array");
      }
    } catch (error) {
      // Only genuinely malformed content reaches here — quarantine and reset to
      // empty so the app recovers instead of failing every read.
      console.error("[GlobalFileStore] Failed to parse recipes:", error);
      try {
        const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const quarantinePath = `${this.recipesPath}.corrupted.${suffix}`;
        await resilientRename(this.recipesPath, quarantinePath);
        console.warn(`[GlobalFileStore] Corrupted recipes file moved to ${quarantinePath}`);
      } catch {
        // Ignore
      }
      return [];
    }

    return filterValidTerminalEntries(parsed, TerminalRecipeSchema, "GlobalFileStore");
  }

  async saveRecipes(recipes: TerminalRecipe[]): Promise<void> {
    // Blind full replacement. Takes a queue turn so it can't land between a
    // competing update's read and write, but reads nothing itself.
    await this.enqueueRecipesUpdate(() => recipes);
  }

  private async saveRecipesInner(recipes: TerminalRecipe[]): Promise<void> {
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
    await this.enqueueRecipesUpdate(async () => {
      const recipes = await this.getRecipes();
      recipes.push(recipe);
      return recipes;
    });
  }

  async updateRecipe(
    recipeId: string,
    updates: Partial<Omit<TerminalRecipe, "id" | "projectId" | "createdAt">>
  ): Promise<void> {
    await this.enqueueRecipesUpdate(async () => {
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
        worktreeId: _wid,
        ...safeUpdates
      } = updates as Record<string, unknown>;
      recipes[index] = { ...recipes[index], ...safeUpdates };
      return recipes;
    });
  }

  async deleteRecipe(recipeId: string): Promise<void> {
    await this.enqueueRecipesUpdate(async () => {
      const recipes = await this.getRecipes();
      return recipes.filter((r) => r.id !== recipeId);
    });
  }
}
