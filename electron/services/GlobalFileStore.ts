import type { TerminalRecipe } from "../types/index.js";
import fs from "fs/promises";
import path from "path";
import { resilientRename, resilientAtomicWriteFile } from "../utils/fs.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
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
   * updater does its own reads (via {@link readRecipes}) and returns the list to
   * persist, or `null` to skip the write. Updaters must not call another queued
   * method, including the queued {@link getRecipes} (they would chain behind the
   * awaiting outer turn and self-deadlock); the unqueued {@link readRecipes} is
   * safe. `.catch(() => {})` keeps one failed
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

  /**
   * Takes a queue turn because {@link readRecipes} may quarantine the file: a
   * reader holding bytes from before a queued save would otherwise rename the
   * newly committed file aside, and concurrent readers could both try to.
   */
  async getRecipes(): Promise<TerminalRecipe[]> {
    let recipes: TerminalRecipe[] = [];
    await this.enqueueRecipesUpdate(async () => {
      recipes = await this.readRecipes();
      return null;
    });
    return recipes;
  }

  private async readRecipes(): Promise<TerminalRecipe[]> {
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
      // empty so the app recovers instead of failing every read. If the file
      // can't be moved aside, throw: an empty snapshot would let the next
      // mutator write straight over bytes we failed to preserve.
      console.error("[GlobalFileStore] Failed to parse recipes:", error);
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const quarantinePath = `${this.recipesPath}.corrupted.${suffix}`;
      try {
        await resilientRename(this.recipesPath, quarantinePath);
      } catch (renameError) {
        console.error("[GlobalFileStore] Failed to quarantine recipes:", renameError);
        const reason = formatErrorMessage(renameError, "rename failed");
        throw new Error(
          `Global recipes file is unreadable and could not be moved aside (${reason}); leaving it untouched`,
          { cause: renameError }
        );
      }
      console.warn(`[GlobalFileStore] Corrupted recipes file moved to ${quarantinePath}`);
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
      const recipes = await this.readRecipes();
      recipes.push(recipe);
      return recipes;
    });
  }

  async updateRecipe(
    recipeId: string,
    updates: Partial<Omit<TerminalRecipe, "id" | "projectId" | "createdAt">>
  ): Promise<void> {
    await this.enqueueRecipesUpdate(async () => {
      const recipes = await this.readRecipes();
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

  /**
   * Rewrite the list in one queue turn: `transform` sees the latest recipes and
   * returns the list to save, or null to leave the file alone. For a change
   * that must compare and write with nothing landing in between.
   */
  async transformRecipes(
    transform: (recipes: TerminalRecipe[]) => TerminalRecipe[] | null
  ): Promise<void> {
    await this.enqueueRecipesUpdate(async () => transform(await this.readRecipes()));
  }

  async deleteRecipe(recipeId: string): Promise<void> {
    await this.enqueueRecipesUpdate(async () => {
      const recipes = await this.readRecipes();
      return recipes.filter((r) => r.id !== recipeId);
    });
  }
}
