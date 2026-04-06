import type { ProjectSettings, TerminalRecipe } from "../types/index.js";
import type { RunCommand, CopyTreeSettings } from "../../shared/types/project.js";
import path from "path";
import fs from "fs/promises";
import { resilientAtomicWriteFile } from "../utils/fs.js";
import { UTF8_BOM } from "./projectStorePaths.js";
import { safeRecipeFilename } from "../utils/recipeFilename.js";

const MAX_PROJECT_NAME_LENGTH = 100;
const CANOPY_PROJECT_JSON = ".canopy/project.json";
const CANOPY_SETTINGS_JSON = ".canopy/settings.json";
const CANOPY_RECIPES_DIR = ".canopy/recipes";

export class ProjectIdentityFiles {
  async readInRepoProjectIdentity(
    projectPath: string
  ): Promise<{ name?: string; emoji?: string; color?: string; found: boolean }> {
    const filePath = path.join(projectPath, CANOPY_PROJECT_JSON);
    try {
      let content = await fs.readFile(filePath, "utf-8");
      if (content.startsWith(UTF8_BOM)) {
        content = content.slice(1);
      }
      const parsed = JSON.parse(content);

      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { found: false };
      }

      if (!Number.isFinite(parsed.version) || !Number.isInteger(parsed.version)) {
        return { found: false };
      }

      const result: { name?: string; emoji?: string; color?: string; found: boolean } = {
        found: true,
      };

      if (typeof parsed.name === "string" && parsed.name.trim().length > 0) {
        result.name = parsed.name.trim().slice(0, MAX_PROJECT_NAME_LENGTH);
      }

      if (typeof parsed.emoji === "string" && parsed.emoji.trim().length > 0) {
        result.emoji = parsed.emoji.trim();
      }

      if (typeof parsed.color === "string" && parsed.color.trim().length > 0) {
        result.color = parsed.color.trim();
      }

      return result;
    } catch {
      return { found: false };
    }
  }

  private async assertCanopyDirNotSymlink(projectPath: string): Promise<void> {
    const canopyDir = path.join(projectPath, ".canopy");
    try {
      const stat = await fs.lstat(canopyDir);
      if (stat.isSymbolicLink()) {
        throw new Error(
          `.canopy/ in ${projectPath} is a symbolic link — refusing to write to prevent path traversal`
        );
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  }

  async writeInRepoProjectIdentity(
    projectPath: string,
    data: { name?: string; emoji?: string; color?: string }
  ): Promise<void> {
    await this.assertCanopyDirNotSymlink(projectPath);
    const canopyDir = path.join(projectPath, ".canopy");
    const filePath = path.join(projectPath, CANOPY_PROJECT_JSON);

    const payload: { version: 1; name?: string; emoji?: string; color?: string } = { version: 1 };
    if (data.name !== undefined) payload.name = data.name;
    if (data.emoji !== undefined) payload.emoji = data.emoji;
    if (data.color !== undefined) payload.color = data.color;

    const attemptWrite = async (ensureDir: boolean): Promise<void> => {
      if (ensureDir) {
        await fs.mkdir(canopyDir, { recursive: true });
      }
      await resilientAtomicWriteFile(filePath, JSON.stringify(payload, null, 2), "utf-8");
    };

    try {
      await attemptWrite(false);
    } catch (error) {
      const isEnoent = error instanceof Error && "code" in error && error.code === "ENOENT";
      if (!isEnoent) {
        console.error(
          `[ProjectIdentityFiles] Failed to write .canopy/project.json for ${projectPath}:`,
          error
        );
        throw error;
      }
      try {
        await attemptWrite(true);
      } catch (retryError) {
        console.error(
          `[ProjectIdentityFiles] Failed to write .canopy/project.json for ${projectPath}:`,
          retryError
        );
        throw retryError;
      }
    }
  }

  async writeInRepoSettings(projectPath: string, settings: ProjectSettings): Promise<void> {
    await this.assertCanopyDirNotSymlink(projectPath);
    const canopyDir = path.join(projectPath, ".canopy");
    const filePath = path.join(projectPath, CANOPY_SETTINGS_JSON);

    const payload: {
      version: 1;
      runCommands?: RunCommand[];
      devServerCommand?: string;
      devServerLoadTimeout?: number;
      copyTreeSettings?: CopyTreeSettings;
      excludedPaths?: string[];

      worktreePathPattern?: string;
      terminalSettings?: {
        shellArgs?: string[];
        defaultWorkingDirectory?: string;
        scrollbackLines?: number;
      };
    } = { version: 1 };

    if (settings.runCommands?.length) payload.runCommands = settings.runCommands;
    if (settings.devServerCommand) payload.devServerCommand = settings.devServerCommand;
    if (settings.devServerLoadTimeout) payload.devServerLoadTimeout = settings.devServerLoadTimeout;
    if (settings.copyTreeSettings) payload.copyTreeSettings = settings.copyTreeSettings;
    if (settings.excludedPaths?.length) payload.excludedPaths = settings.excludedPaths;

    if (settings.worktreePathPattern) payload.worktreePathPattern = settings.worktreePathPattern;

    if (settings.terminalSettings) {
      const shareableTerminal: {
        shellArgs?: string[];
        defaultWorkingDirectory?: string;
        scrollbackLines?: number;
      } = {};
      if (settings.terminalSettings.shellArgs?.length)
        shareableTerminal.shellArgs = settings.terminalSettings.shellArgs;
      if (settings.terminalSettings.defaultWorkingDirectory)
        shareableTerminal.defaultWorkingDirectory =
          settings.terminalSettings.defaultWorkingDirectory;
      if (settings.terminalSettings.scrollbackLines !== undefined)
        shareableTerminal.scrollbackLines = settings.terminalSettings.scrollbackLines;
      if (Object.keys(shareableTerminal).length > 0) payload.terminalSettings = shareableTerminal;
    }

    const attemptWrite = async (ensureDir: boolean): Promise<void> => {
      if (ensureDir) {
        await fs.mkdir(canopyDir, { recursive: true });
      }
      await resilientAtomicWriteFile(filePath, JSON.stringify(payload, null, 2), "utf-8");
    };

    try {
      await attemptWrite(false);
    } catch (error) {
      const isEnoent = error instanceof Error && "code" in error && error.code === "ENOENT";
      if (!isEnoent) {
        console.error(
          `[ProjectIdentityFiles] Failed to write .canopy/settings.json for ${projectPath}:`,
          error
        );
        throw error;
      }
      try {
        await attemptWrite(true);
      } catch (retryError) {
        console.error(
          `[ProjectIdentityFiles] Failed to write .canopy/settings.json for ${projectPath}:`,
          retryError
        );
        throw retryError;
      }
    }
  }

  async writeInRepoRecipe(projectPath: string, recipe: TerminalRecipe): Promise<void> {
    await this.assertCanopyDirNotSymlink(projectPath);
    const recipesDir = path.join(projectPath, CANOPY_RECIPES_DIR);

    // Also guard the recipes subdirectory against symlink attacks
    try {
      const stat = await fs.lstat(recipesDir);
      if (stat.isSymbolicLink()) {
        throw new Error(
          `.canopy/recipes/ in ${projectPath} is a symbolic link — refusing to write`
        );
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }

    const filename = safeRecipeFilename(recipe.name);
    const filePath = path.join(recipesDir, filename);

    // Strip fields that shouldn't be shared: projectId, worktreeId, source, and env values
    const { projectId: _, worktreeId: _w, ...shareable } = recipe;
    const sanitizedTerminals = shareable.terminals.map((t) => {
      if (!t.env || Object.keys(t.env).length === 0) return t;
      const redactedEnv: Record<string, string> = {};
      for (const key of Object.keys(t.env)) {
        redactedEnv[key] = "";
      }
      return { ...t, env: redactedEnv };
    });
    const payload = { ...shareable, terminals: sanitizedTerminals };

    const attemptWrite = async (ensureDir: boolean): Promise<void> => {
      if (ensureDir) {
        await fs.mkdir(recipesDir, { recursive: true });
      }
      await resilientAtomicWriteFile(filePath, JSON.stringify(payload, null, 2), "utf-8");
    };

    try {
      await attemptWrite(false);
    } catch (error) {
      const isEnoent = error instanceof Error && "code" in error && error.code === "ENOENT";
      if (!isEnoent) throw error;
      await attemptWrite(true);
    }
  }

  async readInRepoRecipes(projectPath: string): Promise<TerminalRecipe[]> {
    const recipesDir = path.join(projectPath, CANOPY_RECIPES_DIR);
    let entries;
    try {
      entries = await fs.readdir(recipesDir, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }

    const recipes: TerminalRecipe[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const content = await fs.readFile(path.join(recipesDir, entry.name), "utf-8");
        const parsed = JSON.parse(content);
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          typeof parsed.name !== "string" ||
          !Array.isArray(parsed.terminals)
        ) {
          continue;
        }
        // Assign a stable ID based on filename so it's consistent across loads
        if (!parsed.id) {
          parsed.id = `inrepo-${entry.name.replace(/\.json$/, "")}`;
        }
        if (typeof parsed.createdAt !== "number") {
          parsed.createdAt = 0;
        }
        recipes.push(parsed as TerminalRecipe);
      } catch {
        console.warn(`[ProjectIdentityFiles] Skipping malformed recipe file: ${entry.name}`);
      }
    }
    return recipes;
  }

  async deleteInRepoRecipe(projectPath: string, recipeName: string): Promise<void> {
    await this.assertCanopyDirNotSymlink(projectPath);
    const recipesDir = path.join(projectPath, CANOPY_RECIPES_DIR);

    try {
      const stat = await fs.lstat(recipesDir);
      if (stat.isSymbolicLink()) {
        throw new Error(
          `.canopy/recipes/ in ${projectPath} is a symbolic link — refusing to delete`
        );
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }

    const filename = safeRecipeFilename(recipeName);
    const filePath = path.join(recipesDir, filename);
    try {
      await fs.unlink(filePath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  }
}
