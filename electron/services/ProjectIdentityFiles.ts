import type { ProjectSettings, TerminalRecipe } from "../types/index.js";
import type { RunCommand, CopyTreeSettings } from "../../shared/types/project.js";
import type { AgentPreset } from "../../shared/config/agentRegistry.js";
import path from "path";
import fs from "fs/promises";
import { resilientAtomicWriteFile } from "../utils/fs.js";
import { UTF8_BOM } from "./projectStorePaths.js";
import { safeRecipeFilename } from "../utils/recipeFilename.js";
import { TerminalRecipeSchema } from "../schemas/ipc.js";

const MAX_PROJECT_NAME_LENGTH = 100;
const DAINTREE_DIR = ".daintree";
const DAINTREE_PROJECT_JSON = `${DAINTREE_DIR}/project.json`;
const DAINTREE_SETTINGS_JSON = `${DAINTREE_DIR}/settings.json`;
const DAINTREE_RECIPES_DIR = `${DAINTREE_DIR}/recipes`;
const DAINTREE_PRESETS_DIR = `${DAINTREE_DIR}/presets`;

// Only accept safe agent subdirectory names: letters, numbers, dot, dash,
// underscore. Prevents path traversal via a crafted `.daintree/presets/../x`
// subdirectory entry.
const SAFE_AGENT_ID = /^[a-zA-Z0-9_.-]+$/;

export class ProjectIdentityFiles {
  async readInRepoProjectIdentity(
    projectPath: string
  ): Promise<{ name?: string; emoji?: string; color?: string; found: boolean }> {
    const filePath = path.join(projectPath, DAINTREE_PROJECT_JSON);
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

  private async assertDaintreeDirNotSymlink(projectPath: string): Promise<void> {
    const daintreeDir = path.join(projectPath, DAINTREE_DIR);
    try {
      const stat = await fs.lstat(daintreeDir);
      if (stat.isSymbolicLink()) {
        throw new Error(
          `${DAINTREE_DIR}/ in ${projectPath} is a symbolic link — refusing to write to prevent path traversal`
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
    await this.assertDaintreeDirNotSymlink(projectPath);
    const daintreeDir = path.join(projectPath, DAINTREE_DIR);
    const filePath = path.join(projectPath, DAINTREE_PROJECT_JSON);

    const payload: { version: 1; name?: string; emoji?: string; color?: string } = { version: 1 };
    if (data.name !== undefined) payload.name = data.name;
    if (data.emoji !== undefined) payload.emoji = data.emoji;
    if (data.color !== undefined) payload.color = data.color;

    const attemptWrite = async (ensureDir: boolean): Promise<void> => {
      if (ensureDir) {
        await fs.mkdir(daintreeDir, { recursive: true });
      }
      await resilientAtomicWriteFile(filePath, JSON.stringify(payload, null, 2), "utf-8");
    };

    try {
      await attemptWrite(false);
    } catch (error) {
      const isEnoent = error instanceof Error && "code" in error && error.code === "ENOENT";
      if (!isEnoent) {
        console.error(
          `[ProjectIdentityFiles] Failed to write ${DAINTREE_PROJECT_JSON} for ${projectPath}:`,
          error
        );
        throw error;
      }
      try {
        await attemptWrite(true);
      } catch (retryError) {
        console.error(
          `[ProjectIdentityFiles] Failed to write ${DAINTREE_PROJECT_JSON} for ${projectPath}:`,
          retryError
        );
        throw retryError;
      }
    }
  }

  async writeInRepoSettings(projectPath: string, settings: ProjectSettings): Promise<void> {
    await this.assertDaintreeDirNotSymlink(projectPath);
    const daintreeDir = path.join(projectPath, DAINTREE_DIR);
    const filePath = path.join(projectPath, DAINTREE_SETTINGS_JSON);

    const payload: {
      version: 1;
      runCommands?: RunCommand[];
      devServerCommand?: string;
      devServerLoadTimeout?: number;
      turbopackEnabled?: boolean;
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
    if (typeof settings.turbopackEnabled === "boolean")
      payload.turbopackEnabled = settings.turbopackEnabled;
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
        await fs.mkdir(daintreeDir, { recursive: true });
      }
      await resilientAtomicWriteFile(filePath, JSON.stringify(payload, null, 2), "utf-8");
    };

    try {
      await attemptWrite(false);
    } catch (error) {
      const isEnoent = error instanceof Error && "code" in error && error.code === "ENOENT";
      if (!isEnoent) {
        console.error(
          `[ProjectIdentityFiles] Failed to write ${DAINTREE_SETTINGS_JSON} for ${projectPath}:`,
          error
        );
        throw error;
      }
      try {
        await attemptWrite(true);
      } catch (retryError) {
        console.error(
          `[ProjectIdentityFiles] Failed to write ${DAINTREE_SETTINGS_JSON} for ${projectPath}:`,
          retryError
        );
        throw retryError;
      }
    }
  }

  async writeInRepoRecipe(projectPath: string, recipe: TerminalRecipe): Promise<void> {
    await this.assertDaintreeDirNotSymlink(projectPath);
    const recipesDir = path.join(projectPath, DAINTREE_RECIPES_DIR);

    try {
      const stat = await fs.lstat(recipesDir);
      if (stat.isSymbolicLink()) {
        throw new Error(
          `${DAINTREE_RECIPES_DIR}/ in ${projectPath} is a symbolic link — refusing to write`
        );
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }

    const filename = safeRecipeFilename(recipe.name);
    const filePath = path.join(recipesDir, filename);

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
    const recipesDir = path.join(projectPath, DAINTREE_RECIPES_DIR);
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
        if (typeof parsed !== "object" || parsed === null) {
          continue;
        }
        if (!parsed.id) {
          parsed.id = `inrepo-${entry.name.replace(/\.json$/, "")}`;
        }
        if (typeof parsed.createdAt !== "number") {
          parsed.createdAt = 0;
        }
        const result = TerminalRecipeSchema.safeParse(parsed);
        if (!result.success) {
          console.warn(
            `[ProjectIdentityFiles] Skipping invalid recipe: ${entry.name}`,
            result.error.flatten()
          );
          continue;
        }
        recipes.push(result.data);
      } catch {
        console.warn(`[ProjectIdentityFiles] Skipping malformed recipe file: ${entry.name}`);
      }
    }
    return recipes;
  }

  /**
   * Reads per-team shared agent presets committed to `.daintree/presets/{agentId}/*.json`.
   * Returns a map keyed by agent id; malformed or unrecognized files are skipped with a warn.
   */
  async readInRepoPresets(projectPath: string): Promise<Record<string, AgentPreset[]>> {
    const presetsDir = path.join(projectPath, DAINTREE_PRESETS_DIR);
    let agentDirs;
    try {
      agentDirs = await fs.readdir(presetsDir, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
      throw error;
    }

    const result: Record<string, AgentPreset[]> = {};

    for (const agentEntry of agentDirs) {
      if (!agentEntry.isDirectory()) continue;
      const agentId = agentEntry.name;
      if (!SAFE_AGENT_ID.test(agentId)) {
        console.warn(`[ProjectIdentityFiles] Skipping unsafe preset subdir: ${agentId}`);
        continue;
      }

      const agentDir = path.join(presetsDir, agentId);
      let fileEntries;
      try {
        fileEntries = await fs.readdir(agentDir, { withFileTypes: true });
      } catch {
        continue;
      }

      const presets: AgentPreset[] = [];
      const seenIds = new Set<string>();
      for (const entry of fileEntries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        try {
          const content = await fs.readFile(path.join(agentDir, entry.name), "utf-8");
          const parsed = JSON.parse(content);
          if (
            typeof parsed !== "object" ||
            parsed === null ||
            Array.isArray(parsed) ||
            typeof parsed.id !== "string" ||
            typeof parsed.name !== "string" ||
            !parsed.id ||
            !parsed.name
          ) {
            console.warn(
              `[ProjectIdentityFiles] Skipping invalid preset: ${agentId}/${entry.name}`
            );
            continue;
          }
          if (seenIds.has(parsed.id)) {
            // Filesystem readdir order is non-deterministic across machines,
            // so a duplicate id would resolve differently on different dev
            // machines. Keep the first occurrence and warn loudly so the
            // contributor renames one.
            console.warn(
              `[ProjectIdentityFiles] Duplicate preset id "${parsed.id}" in ${agentId}/${entry.name} — keeping first occurrence, rename this file`
            );
            continue;
          }
          seenIds.add(parsed.id);
          presets.push(parsed as AgentPreset);
        } catch {
          console.warn(`[ProjectIdentityFiles] Skipping malformed preset file: ${entry.name}`);
        }
      }

      if (presets.length > 0) result[agentId] = presets;
    }

    return result;
  }

  async deleteInRepoRecipe(projectPath: string, recipeName: string): Promise<void> {
    await this.assertDaintreeDirNotSymlink(projectPath);
    const recipesDir = path.join(projectPath, DAINTREE_RECIPES_DIR);

    try {
      const stat = await fs.lstat(recipesDir);
      if (stat.isSymbolicLink()) {
        throw new Error(
          `${DAINTREE_RECIPES_DIR}/ in ${projectPath} is a symbolic link — refusing to delete`
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
