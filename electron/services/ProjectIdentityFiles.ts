import type { ProjectSettings, TerminalRecipe } from "../types/index.js";
import {
  PROJECT_SETTINGS_SHAREABILITY,
  PROJECT_TERMINAL_SETTINGS_SHAREABILITY,
  type ProjectTerminalSettings,
} from "../../shared/types/project.js";
import type { AgentPreset } from "../../shared/config/agentRegistry.js";
import path from "path";
import fs from "fs/promises";
import { createHash } from "crypto";
import { z } from "zod";
import { resilientAtomicWriteFile } from "../utils/fs.js";
import { UTF8_BOM, isValidProjectId } from "./projectStorePaths.js";
import { safeRecipeFilename } from "../utils/recipeFilename.js";
import { TerminalRecipeSchema } from "../schemas/ipc.js";
import {
  sanitizeRecipeTerminals,
  MAX_TERMINALS_PER_RECIPE,
} from "../../shared/utils/recipeSanitizer.js";

/**
 * Builds the exact UTF-8 byte string that `writeInRepoRecipe` lands on disk
 * for `recipe`. Used both at read time (to hash file bytes) and at write time
 * (to hash the candidate payload), so the staleness comparison in
 * {@link ProjectStore.writeInRepoRecipeChecked} is comparing like to like:
 * the sanitized, env-redacted, BOM-free JSON-with-trailing-newline that
 * actually persists. Hashing the raw in-memory recipe would produce
 * spurious conflicts on every write because `projectId`/`worktreeId`/env
 * values would never match the redacted on-disk bytes.
 */
export function buildInRepoRecipePayloadString(recipe: TerminalRecipe): string {
  const { projectId: _p, worktreeId: _w, ...shareable } = recipe;
  const sanitizedTerminals = shareable.terminals.map((t) => {
    if (!t.env || Object.keys(t.env).length === 0) return t;
    const redactedEnv: Record<string, string> = {};
    for (const key of Object.keys(t.env)) {
      redactedEnv[key] = "";
    }
    return { ...t, env: redactedEnv };
  });
  const payload = { ...shareable, terminals: sanitizedTerminals };
  return JSON.stringify(payload, null, 2) + "\n";
}

export function hashRecipePayload(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

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

/**
 * Returns true if the value is "present enough" to write to disk. Mirrors the
 * legacy hand-coded checks: skip `undefined`, `null`, empty strings, and empty
 * arrays; keep `0`, `false`, and non-empty objects. Renderer callers
 * occasionally send `null` for "clear this field", which must not survive into
 * the committed `.daintree/settings.json` (the reader drops it, but a `null`
 * entry produces spurious git diffs).
 */
function shouldWriteValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Builds the shareable subset of `ProjectTerminalSettings`, filtered by
 * `PROJECT_TERMINAL_SETTINGS_SHAREABILITY`. Returns `undefined` if no
 * shareable sub-fields are present.
 */
function buildShareableTerminalSettings(
  terminalSettings: ProjectTerminalSettings | undefined
): ProjectTerminalSettings | undefined {
  if (!terminalSettings) return undefined;
  const result: ProjectTerminalSettings = {};
  for (const key of Object.keys(PROJECT_TERMINAL_SETTINGS_SHAREABILITY) as Array<
    keyof ProjectTerminalSettings
  >) {
    if (PROJECT_TERMINAL_SETTINGS_SHAREABILITY[key] !== "shareable") continue;
    const value = terminalSettings[key];
    if (!shouldWriteValue(value)) continue;
    (result as Record<keyof ProjectTerminalSettings, unknown>)[key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export class ProjectIdentityFiles {
  async readInRepoProjectIdentity(
    projectPath: string
  ): Promise<{ id?: string; name?: string; emoji?: string; color?: string; found: boolean }> {
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

      const result: { id?: string; name?: string; emoji?: string; color?: string; found: boolean } =
        {
          found: true,
        };

      // The move anchor (#11282). A malformed id is dropped without discarding
      // the rest of the identity — a hand-edited or truncated value must not
      // cost the user their project name/emoji/color.
      if (typeof parsed.id === "string" && isValidProjectId(parsed.id)) {
        result.id = parsed.id;
      }

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
    data: { id?: string; name?: string; emoji?: string; color?: string }
  ): Promise<void> {
    await this.assertDaintreeDirNotSymlink(projectPath);
    const daintreeDir = path.join(projectPath, DAINTREE_DIR);
    const filePath = path.join(projectPath, DAINTREE_PROJECT_JSON);

    // This function rebuilds the envelope from scratch, so an `id` the caller
    // does not supply would be *erased* by any ordinary name/emoji/color edit —
    // silently disarming move detection (#11282). Carry the on-disk value
    // forward whenever the caller doesn't name one.
    let id = data.id !== undefined && isValidProjectId(data.id) ? data.id : undefined;
    if (id === undefined) {
      const existing = await this.readInRepoProjectIdentity(projectPath);
      id = existing.id;
    }

    const payload: { version: 1; id?: string; name?: string; emoji?: string; color?: string } = {
      version: 1,
    };
    if (id !== undefined) payload.id = id;
    if (data.name !== undefined) payload.name = data.name;
    if (data.emoji !== undefined) payload.emoji = data.emoji;
    if (data.color !== undefined) payload.color = data.color;

    const attemptWrite = async (ensureDir: boolean): Promise<void> => {
      if (ensureDir) {
        await fs.mkdir(daintreeDir, { recursive: true });
      }
      await resilientAtomicWriteFile(filePath, JSON.stringify(payload, null, 2) + "\n", "utf-8");
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

    const payload: { version: 1 } & Partial<ProjectSettings> = { version: 1 };

    for (const key of Object.keys(PROJECT_SETTINGS_SHAREABILITY) as Array<keyof ProjectSettings>) {
      if (PROJECT_SETTINGS_SHAREABILITY[key] !== "shareable") continue;
      if (key === "terminalSettings") {
        const shareableTerminal = buildShareableTerminalSettings(settings.terminalSettings);
        if (shareableTerminal !== undefined) payload.terminalSettings = shareableTerminal;
        continue;
      }
      const value = settings[key];
      if (!shouldWriteValue(value)) continue;
      // Assigning a wider union into the specific key type — safe because we
      // pulled `value` straight from `settings[key]`. The cast is a writer-side
      // concession to keep the loop generic.
      (payload as Record<keyof ProjectSettings, unknown>)[key] = value;
    }

    const attemptWrite = async (ensureDir: boolean): Promise<void> => {
      if (ensureDir) {
        await fs.mkdir(daintreeDir, { recursive: true });
      }
      await resilientAtomicWriteFile(filePath, JSON.stringify(payload, null, 2) + "\n", "utf-8");
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

  /**
   * Writes `recipe` to disk and returns the SHA-256 of the bytes that landed
   * on disk. Callers cache the returned hash so a subsequent
   * {@link ProjectStore.writeInRepoRecipeChecked} can detect external edits
   * (git pull, branch switch, stash pop) that changed the file out from under
   * them.
   */
  async writeInRepoRecipe(projectPath: string, recipe: TerminalRecipe): Promise<string> {
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
    const payloadString = buildInRepoRecipePayloadString(recipe);

    const attemptWrite = async (ensureDir: boolean): Promise<void> => {
      if (ensureDir) {
        await fs.mkdir(recipesDir, { recursive: true });
      }
      await resilientAtomicWriteFile(filePath, payloadString, "utf-8");
    };

    try {
      await attemptWrite(false);
    } catch (error) {
      const isEnoent = error instanceof Error && "code" in error && error.code === "ENOENT";
      if (!isEnoent) throw error;
      await attemptWrite(true);
    }
    return hashRecipePayload(payloadString);
  }

  /**
   * Reads the raw on-disk bytes for `recipe`'s filename and returns the
   * SHA-256 hash, or `null` if the file does not exist. The hash compares
   * directly against the value returned by {@link writeInRepoRecipe} and the
   * `hashes` map populated by {@link readInRepoRecipes}.
   */
  async getInRepoRecipeFileHash(projectPath: string, recipeName: string): Promise<string | null> {
    const filePath = path.join(projectPath, DAINTREE_RECIPES_DIR, safeRecipeFilename(recipeName));
    try {
      const content = await fs.readFile(filePath, "utf-8");
      return hashRecipePayload(content);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async readInRepoRecipes(projectPath: string): Promise<TerminalRecipe[]> {
    const { recipes } = await this.readInRepoRecipesWithHashes(projectPath);
    return recipes;
  }

  /**
   * Same as {@link readInRepoRecipes} but also returns a `Map<recipeId, hash>`
   * of the raw on-disk bytes that were read. The hash is computed against the
   * exact bytes (`fs.readFile` UTF-8 result), so it matches what
   * {@link writeInRepoRecipe} and {@link getInRepoRecipeFileHash} produce when
   * the file is untouched.
   *
   * `dirExists` reports whether the `.daintree/recipes/` directory was present.
   * An absent directory (e.g. a checked-out branch/commit that predates recipes)
   * yields the same empty `recipes`/`hashes` as an authoritatively empty one, so
   * callers that make destructive decisions must consult `dirExists` to avoid
   * treating "not on this checkout" as "deleted" (#11347). `scanComplete` is
   * `false` when the directory existed but at least one entry could not be read
   * (a partial, non-authoritative snapshot) — destructive callers must treat
   * that the same as an absent directory.
   */
  async readInRepoRecipesWithHashes(projectPath: string): Promise<{
    recipes: TerminalRecipe[];
    hashes: Map<string, string>;
    dirExists: boolean;
    scanComplete: boolean;
  }> {
    const recipesDir = path.join(projectPath, DAINTREE_RECIPES_DIR);
    let entries;
    try {
      entries = await fs.readdir(recipesDir, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { recipes: [], hashes: new Map(), dirExists: false, scanComplete: true };
      throw error;
    }

    const recipes: TerminalRecipe[] = [];
    const hashes = new Map<string, string>();
    const seenIds = new Set<string>();
    // Whether every listed entry was actually read. A per-file *read* failure
    // (e.g. a concurrent branch checkout unlinking a recipe after `readdir` but
    // before we open it) means this snapshot is not an authoritative view of the
    // directory, so destructive reconciliation must not prune from it (#11347).
    // A readable-but-malformed file (JSON/schema failure below) is different: it
    // is genuinely skipped and does NOT taint the scan, otherwise one committed
    // bad file would wedge pruning forever.
    let scanComplete = true;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const content = await fs.readFile(path.join(recipesDir, entry.name), "utf-8");
        const parsed = JSON.parse(content);
        if (typeof parsed !== "object" || parsed === null) {
          continue;
        }
        if (typeof parsed.id !== "string" || !parsed.id) {
          // Legacy files that predate opaque ids carry no `id`. Derive one
          // deterministically from the filename so the same file resolves to
          // the same id on every read (a random UUID here would churn the id
          // across the concurrent reconcile + getInRepoRecipes reads). The id
          // is treated as opaque from here on and is persisted on next write.
          parsed.id = `inrepo-${entry.name.replace(/\.json$/, "")}`;
        }
        // Tag scope explicitly so callers discriminate in-repo recipes by the
        // `scope` field rather than the id prefix — opaque-UUID in-repo recipes
        // have no `inrepo-` prefix. Persisted on next write, making files
        // self-describing.
        parsed.scope = "inrepo";
        if (typeof parsed.createdAt !== "number") {
          const ts = typeof parsed.createdAt === "string" ? Date.parse(parsed.createdAt) : NaN;
          parsed.createdAt = Number.isFinite(ts) ? ts : 0;
        }
        const result = TerminalRecipeSchema.safeParse(parsed);
        if (!result.success) {
          console.warn(
            `[ProjectIdentityFiles] Skipping invalid recipe: ${entry.name}`,
            z.prettifyError(result.error)
          );
          continue;
        }
        if (seenIds.has(result.data.id)) {
          // Two files now resolve to the same opaque id (e.g. a copied recipe
          // file whose id wasn't changed, or a rename whose old-file delete
          // failed). readdir order is non-deterministic across machines, so
          // keep the first occurrence and warn loudly rather than letting the
          // hash map and reconciliation silently collapse them.
          console.warn(
            `[ProjectIdentityFiles] Duplicate recipe id "${result.data.id}" in ${entry.name} — keeping first occurrence, change this file's id`
          );
          continue;
        }
        seenIds.add(result.data.id);
        // The schema only validates shape (and passes unknown fields through).
        // Content-validate every terminal at this trust boundary — dropping any
        // with a bad type or control-char-laden command/args/env — so an
        // in-repo recipe can't smuggle injected fields into the spawn path.
        let sanitizedTerminals = sanitizeRecipeTerminals(result.data.terminals);
        if (sanitizedTerminals.length === 0) {
          console.warn(
            `[ProjectIdentityFiles] Skipping recipe with no valid terminals: ${entry.name}`
          );
          continue;
        }
        if (sanitizedTerminals.length > MAX_TERMINALS_PER_RECIPE) {
          console.warn(
            `[ProjectIdentityFiles] Capping recipe ${entry.name} at ${MAX_TERMINALS_PER_RECIPE} terminals (had ${sanitizedTerminals.length})`
          );
          sanitizedTerminals = sanitizedTerminals.slice(0, MAX_TERMINALS_PER_RECIPE);
        }
        // Build the recipe with explicit known fields only — never spread the
        // schema's passthrough output, or unknown top-level keys from a crafted
        // recipe would round-trip into the store and back to disk.
        const data = result.data;
        const recipe: TerminalRecipe = {
          id: data.id,
          name: data.name,
          projectId: data.projectId,
          worktreeId: data.worktreeId,
          terminals: sanitizedTerminals,
          createdAt: data.createdAt,
          showInEmptyState: data.showInEmptyState,
          lastUsedAt: data.lastUsedAt,
          usageHistory: data.usageHistory,
          autoAssign: data.autoAssign,
          scope: data.scope,
        };
        recipes.push(recipe);
        hashes.set(recipe.id, hashRecipePayload(content));
      } catch (error) {
        // A filesystem error (has a `code`) means the entry could not be read —
        // an incomplete, non-authoritative scan. A SyntaxError from JSON.parse
        // (no `code`) is a genuinely malformed file: skip it, but leave the scan
        // authoritative so a permanently-bad file never blocks pruning.
        if (error instanceof Error && "code" in error) {
          scanComplete = false;
          console.warn(`[ProjectIdentityFiles] Could not read recipe file: ${entry.name}`, error);
        } else {
          console.warn(
            `[ProjectIdentityFiles] Skipping malformed recipe file: ${entry.name}`,
            error
          );
        }
      }
    }
    return { recipes, hashes, dirExists: true, scanComplete };
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
            // Don't log `parsed` directly: presets can carry an `env` map
            // with secret values. Summarize structurally so contributors
            // can diagnose without leaking secrets to logs.
            const summary =
              parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
                ? { id: parsed.id, name: parsed.name, keys: Object.keys(parsed) }
                : {
                    type:
                      parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed,
                  };
            console.warn(
              `[ProjectIdentityFiles] Skipping invalid preset: ${agentId}/${entry.name}`,
              summary
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
        } catch (error) {
          console.warn(
            `[ProjectIdentityFiles] Skipping malformed preset file: ${agentId}/${entry.name}`,
            error
          );
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
