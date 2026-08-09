// eager-import-allow: reads/writes the project file store via sync fs
import type { TerminalRecipe } from "../types/index.js";
import fs from "fs/promises";
import { existsSync } from "fs";
import { resilientRename, resilientAtomicWriteFile } from "../utils/fs.js";
import {
  getProjectStateDir,
  recipesFilePath,
  copyTreeHistoryFilePath,
} from "./projectStorePaths.js";
import { TerminalRecipeSchema, filterValidTerminalEntries } from "../schemas/ipc.js";
import { decodeCopyTreeHistoryFile, encodeCopyTreeHistoryFile } from "./copyTreeHistoryCodec.js";
import { applyCopyTreeRun } from "./copyTreeHistoryLog.js";
import { randomUUID } from "crypto";
import type {
  CopyTreeHistoryAppendInput,
  CopyTreeHistoryRecord,
} from "../../shared/types/ipc/copyTreeHistory.js";

export const RECIPES_SCHEMA_VERSION = 1;

export class ProjectFileStore {
  constructor(private projectsConfigDir: string) {}

  // Serialize read-modify-write cycles per project. ipcMain.handle runs
  // handlers concurrently, so two unqueued mutations for the same projectId
  // read the same on-disk snapshot and the last write silently clobbers the
  // other. Mirrors ProjectStateManager.enqueueProjectStateUpdate.
  private readonly recipesWriteQueues = new Map<string, Promise<void>>();

  // Same reasoning, separate chain: a copy-tree run must not wait behind a
  // recipe import, and the two files never appear in one another's updaters.
  private readonly copyTreeHistoryWriteQueues = new Map<string, Promise<void>>();

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

  /**
   * Serialize recipe read-modify-write updates per project. Each queued
   * updater runs after the previous one has committed, so its own reads see
   * the prior update's on-disk result rather than a stale pre-write snapshot.
   * The updater does its own reads (via {@link getRecipes}) and returns the
   * recipe list to persist, or `null` to skip the write (idempotent no-op).
   *
   * The three load-bearing details mirror
   * ProjectStateManager.enqueueProjectStateUpdate: `.catch(() => {})` keeps one
   * failed update from poisoning the chain (the failure still propagates to
   * that update's own caller); `.then(cleanup, cleanup)` instead of `.finally`
   * avoids leaving an unhandled rejected promise; and cleanup deletes the map
   * entry only when it still points at this tail, so a newer tail isn't
   * dropped.
   *
   * Updaters MUST NOT call another queued method for the same projectId
   * (saveRecipes / add / update / delete), or the inner call would chain behind
   * the outer turn that is awaiting it and self-deadlock. They may freely call
   * the unqueued {@link getRecipes} and any store other than this recipe queue.
   */
  enqueueRecipesUpdate(
    projectId: string,
    updater: () => TerminalRecipe[] | null | Promise<TerminalRecipe[] | null>
  ): Promise<void> {
    const current = this.recipesWriteQueues.get(projectId) ?? Promise.resolve();
    const next = current
      .catch(() => {})
      .then(async () => {
        const updated = await updater();
        if (updated !== null) {
          await this.saveRecipesInner(projectId, updated);
        }
      });
    this.recipesWriteQueues.set(projectId, next);
    const cleanup = () => {
      if (this.recipesWriteQueues.get(projectId) === next) {
        this.recipesWriteQueues.delete(projectId);
      }
    };
    next.then(cleanup, cleanup);
    return next;
  }

  async saveRecipes(projectId: string, recipes: TerminalRecipe[]): Promise<void> {
    // Blind full replacement (bulk save / import / reorder). Still takes a turn
    // in the queue so it can't land between a competing update's read and
    // write, but performs no read of its own — preserving the pre-queue
    // semantics of an unconditional overwrite.
    await this.enqueueRecipesUpdate(projectId, () => recipes);
  }

  private async saveRecipesInner(projectId: string, recipes: TerminalRecipe[]): Promise<void> {
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
    await this.enqueueRecipesUpdate(projectId, async () => {
      const recipes = await this.getRecipes(projectId);
      recipes.push(recipe);
      return recipes;
    });
  }

  async updateRecipe(
    projectId: string,
    recipeId: string,
    updates: Partial<Omit<TerminalRecipe, "id" | "projectId" | "createdAt">>
  ): Promise<void> {
    await this.enqueueRecipesUpdate(projectId, async () => {
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
      return recipes;
    });
  }

  async deleteRecipe(projectId: string, recipeId: string): Promise<void> {
    await this.enqueueRecipesUpdate(projectId, async () => {
      const recipes = await this.getRecipes(projectId);
      return recipes.filter((r) => r.id !== recipeId);
    });
  }

  // --- Copy-tree run history (#11732) ---

  /**
   * Read the project's copy-tree history, newest-first.
   *
   * Takes a turn in the write queue even though it mutates nothing itself:
   * {@link readCopyTreeHistory} quarantines an unreadable file, so two
   * unserialized readers — or a reader racing the append's own read — can both
   * decide to rename it, and whichever loses gets `ENOENT` and fails. Queuing
   * makes the quarantine happen exactly once, and also means a caller reads
   * committed state rather than a snapshot a pending append is about to replace.
   */
  async getCopyTreeHistory(projectId: string): Promise<CopyTreeHistoryRecord[]> {
    let records: CopyTreeHistoryRecord[] = [];
    await this.enqueueCopyTreeHistoryUpdate(projectId, async () => {
      records = await this.readCopyTreeHistory(projectId);
      return null;
    });
    return records;
  }

  /**
   * Fold a completed run into the project's history and return the committed
   * snapshot.
   *
   * Lives here rather than in ProjectStore so the read, the dedupe fold and the
   * write all happen inside one queued turn using the unqueued read — a caller
   * composing this from the outside would have to reach for
   * {@link getCopyTreeHistory}, which takes its own turn and would deadlock
   * behind the turn awaiting it.
   */
  async appendCopyTreeRun(
    projectId: string,
    input: CopyTreeHistoryAppendInput
  ): Promise<CopyTreeHistoryRecord[]> {
    let snapshot: CopyTreeHistoryRecord[] = [];
    await this.enqueueCopyTreeHistoryUpdate(projectId, async () => {
      const current = await this.readCopyTreeHistory(projectId);
      snapshot = applyCopyTreeRun(current, input, { id: randomUUID(), now: Date.now() });
      return snapshot;
    });
    return snapshot;
  }

  /**
   * Unqueued read. A missing file is an empty history. A damaged or
   * newer-than-us file is quarantined by rename and reported empty — but if the
   * rename itself fails this **throws** rather than returning `[]`. Returning
   * empty there would let the next append write a fresh file straight over data
   * we failed to preserve, which is the one outcome quarantining exists to
   * prevent.
   *
   * Private because calling it outside the queue reintroduces the double-
   * quarantine race described on {@link getCopyTreeHistory}.
   */
  private async readCopyTreeHistory(projectId: string): Promise<CopyTreeHistoryRecord[]> {
    const filePath = copyTreeHistoryFilePath(this.projectsConfigDir, projectId);
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
      throw error;
    }

    const decoded = decodeCopyTreeHistoryFile(content);
    if (decoded.ok) {
      return decoded.records;
    }

    const quarantinePath =
      decoded.reason === "future-version"
        ? `${filePath}.future-v${decoded.onDiskVersion}`
        : `${filePath}.corrupted.${Date.now()}`;
    const target = existsSync(quarantinePath) ? `${quarantinePath}.${Date.now()}` : quarantinePath;

    await resilientRename(filePath, target);
    console.warn(
      `[ProjectFileStore] copy-tree history for ${projectId} was unreadable (${decoded.reason}); quarantined to ${target}`
    );
    return [];
  }

  /**
   * Serialize copy-tree history read-modify-write cycles per project, so two
   * runs completing in the same tick cannot both read the pre-write snapshot and
   * have the later write silently drop the earlier one's dedupe bump.
   *
   * Same three load-bearing details as {@link enqueueRecipesUpdate}, and the
   * same rule for updaters: read through the unqueued {@link getCopyTreeHistory}
   * and never re-enter this queue for the same project.
   */
  enqueueCopyTreeHistoryUpdate(
    projectId: string,
    updater: () => CopyTreeHistoryRecord[] | null | Promise<CopyTreeHistoryRecord[] | null>
  ): Promise<void> {
    const current = this.copyTreeHistoryWriteQueues.get(projectId) ?? Promise.resolve();
    const next = current
      .catch(() => {})
      .then(async () => {
        const updated = await updater();
        if (updated !== null) {
          await this.saveCopyTreeHistoryInner(projectId, updated);
        }
      });
    this.copyTreeHistoryWriteQueues.set(projectId, next);
    const cleanup = () => {
      if (this.copyTreeHistoryWriteQueues.get(projectId) === next) {
        this.copyTreeHistoryWriteQueues.delete(projectId);
      }
    };
    next.then(cleanup, cleanup);
    return next;
  }

  private async saveCopyTreeHistoryInner(
    projectId: string,
    records: CopyTreeHistoryRecord[]
  ): Promise<void> {
    const stateDir = getProjectStateDir(this.projectsConfigDir, projectId);
    const filePath = copyTreeHistoryFilePath(this.projectsConfigDir, projectId);
    if (!stateDir || !filePath) {
      throw new Error(`Invalid project ID: ${projectId}`);
    }

    const jsonString = encodeCopyTreeHistoryFile(records);

    try {
      await resilientAtomicWriteFile(filePath, jsonString, "utf-8");
    } catch (error) {
      const isEnoent = error instanceof Error && "code" in error && error.code === "ENOENT";
      if (!isEnoent) {
        throw error;
      }
      await fs.mkdir(stateDir, { recursive: true });
      await resilientAtomicWriteFile(filePath, jsonString, "utf-8");
    }
  }
}
