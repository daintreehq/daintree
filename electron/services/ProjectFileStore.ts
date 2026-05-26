// eager-import-allow: reads/writes the project file store via sync fs
import type { TerminalRecipe } from "../types/index.js";
import fs from "fs/promises";
import { existsSync } from "fs";
import { resilientRename, resilientAtomicWriteFile } from "../utils/fs.js";
import { getProjectStateDir, recipesFilePath } from "./projectStorePaths.js";
import { TerminalRecipeSchema, filterValidTerminalEntries } from "../schemas/ipc.js";

export const RECIPES_SCHEMA_VERSION = 1;

export class ProjectFileStore {
  constructor(private projectsConfigDir: string) {}

  // --- Recipes ---

  async getRecipes(projectId: string): Promise<TerminalRecipe[]> {
    const filePath = recipesFilePath(this.projectsConfigDir, projectId);
    if (!filePath) {
      return [];
    }

    let content: string;
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      console.error(`[ProjectFileStore] Failed to read recipes for ${projectId}:`, error);
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      console.error(`[ProjectFileStore] Failed to parse recipes JSON for project ${projectId}`);
      try {
        const quarantinePath = `${filePath}.corrupted.${Date.now()}`;
        await resilientRename(filePath, quarantinePath);
        console.warn(`[ProjectFileStore] Corrupted recipes file moved to ${quarantinePath}`);
      } catch {
        // Ignore
      }
      return [];
    }

    // Envelope: {"_schemaVersion": N, "recipes": [...]}
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      "_schemaVersion" in parsed
    ) {
      const record = parsed as Record<string, unknown>;
      const rawVersion = record._schemaVersion;
      const onDiskVersion =
        typeof rawVersion === "number" && Number.isInteger(rawVersion) && rawVersion >= 0
          ? rawVersion
          : 0;

      if (onDiskVersion > RECIPES_SCHEMA_VERSION) {
        let quarantinePath = `${filePath}.future-v${onDiskVersion}`;
        if (existsSync(quarantinePath)) {
          quarantinePath = `${quarantinePath}.${Date.now()}`;
        }
        try {
          await resilientRename(filePath, quarantinePath);
          console.warn(
            `[ProjectFileStore] recipes.json for ${projectId} was written by a newer app (v${onDiskVersion} > v${RECIPES_SCHEMA_VERSION}); quarantined to ${quarantinePath}`
          );
        } catch (renameError) {
          console.error(
            `[ProjectFileStore] Failed to quarantine future-version recipes for ${projectId}:`,
            renameError
          );
        }
        return [];
      }

      const recipesArray = record.recipes;
      if (!Array.isArray(recipesArray)) {
        console.warn(
          `[ProjectFileStore] Invalid recipes envelope for ${projectId}, expected recipes array`
        );
        try {
          const quarantinePath = `${filePath}.corrupted.${Date.now()}`;
          await resilientRename(filePath, quarantinePath);
          console.warn(`[ProjectFileStore] Corrupted recipes file moved to ${quarantinePath}`);
        } catch {
          // Ignore
        }
        return [];
      }

      return filterValidTerminalEntries(
        recipesArray,
        TerminalRecipeSchema,
        `ProjectFileStore(${projectId})`
      );
    }

    // Legacy bare-array format
    if (Array.isArray(parsed)) {
      return filterValidTerminalEntries(
        parsed,
        TerminalRecipeSchema,
        `ProjectFileStore(${projectId})`
      );
    }

    // Root-shape failure — non-array, non-envelope
    console.warn(
      `[ProjectFileStore] Invalid recipes format for ${projectId}, expected array or envelope`
    );
    try {
      const quarantinePath = `${filePath}.corrupted.${Date.now()}`;
      await resilientRename(filePath, quarantinePath);
      console.warn(`[ProjectFileStore] Corrupted recipes file moved to ${quarantinePath}`);
    } catch {
      // Ignore
    }
    return [];
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

    const jsonString = JSON.stringify({ _schemaVersion: RECIPES_SCHEMA_VERSION, recipes }, null, 2);

    const attemptSave = async (ensureDir: boolean): Promise<void> => {
      if (ensureDir) {
        await fs.mkdir(stateDir, { recursive: true });
      }
      await resilientAtomicWriteFile(filePath, jsonString, "utf-8");
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
