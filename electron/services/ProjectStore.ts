// eager-import-allow: reads/writes the project list via sync fs during startup
import type {
  Project,
  ProjectRepoStats,
  ProjectState,
  ProjectSettings,
  ProjectStatus,
  TerminalRecipe,
  RecipeNameCollision,
} from "../types/index.js";
import type { NotificationSettings } from "../../shared/types/ipc/api.js";
import type { AgentPreset } from "../../shared/config/agentRegistry.js";
import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";
import { app } from "electron";
import { GitService } from "./GitService.js";
import { AppError, isDaintreeError } from "../utils/errorTypes.js";
import { logError } from "../utils/logger.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { store } from "../store.js";
import { getSharedDb } from "./persistence/db.js";
import {
  projects as projectsTable,
  appState as appStateTable,
  type ProjectRow,
} from "./persistence/schema.js";
import { eq, desc } from "drizzle-orm";
import { generateProjectId, getProjectStateDir } from "./projectStorePaths.js";
import { ProjectSettingsManager } from "./ProjectSettingsManager.js";
import { ProjectStateManager, type ProjectStateReadResult } from "./ProjectStateManager.js";
import { invalidatePrefetchCache } from "./prefetchHydrateCache.js";
import { ProjectFileStore } from "./ProjectFileStore.js";
import { GlobalFileStore } from "./GlobalFileStore.js";
import { ProjectIdentityFiles } from "./ProjectIdentityFiles.js";
import {
  cleanupQuarantinedProjectFiles,
  cleanupGlobalQuarantineFiles,
  cleanupUserDataRootQuarantineFiles,
} from "./projectQuarantineCleanup.js";
import { safeRecipeFilename } from "../utils/recipeFilename.js";
import { isInRepoRecipeId } from "../../shared/utils/recipeFilename.js";

import { computeFrecencyScore, FRECENCY_COLD_START } from "./frecency.js";
import { getWritesSuppressed } from "./diskPressureState.js";

export const DEFAULT_PROJECT_EMOJI = "🌲";

/**
 * Read a persisted count back, rejecting anything a corrupt row could hold.
 * `Number.isFinite` alone lets `1.5` and `-1` through; a count is a
 * non-negative integer or it is unknown.
 */
function readPersistedCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Project the persisted stats columns onto {@link ProjectRepoStats} (issue
 * #11078). The commit count anchors the snapshot: without it there is nothing
 * to seed the toolbar with, so the whole field stays absent. Forge counts are
 * independently optional — a project with no provider persists commits alone.
 */
function rowToRepoStats(row: ProjectRow): ProjectRepoStats | null {
  const commitCount = readPersistedCount(row.statsCommitCount);
  if (commitCount === null) return null;
  return {
    commitCount,
    issueCount: readPersistedCount(row.statsIssueCount),
    prCount: readPersistedCount(row.statsPrCount),
    providerId: typeof row.statsProviderId === "string" ? row.statsProviderId : null,
    lastUpdated: readPersistedCount(row.statsLastUpdated),
  };
}

/**
 * Inverse of {@link rowToRepoStats}, for the insert paths that rebuild a row
 * from a `Project` (relocation). Without this the last-known counts would be
 * dropped on the floor and the toolbar would shift once after every relocate.
 */
function repoStatsToColumns(stats: ProjectRepoStats | undefined): {
  statsCommitCount: number | null;
  statsIssueCount: number | null;
  statsPrCount: number | null;
  statsProviderId: string | null;
  statsLastUpdated: number | null;
} {
  return {
    statsCommitCount: stats ? readPersistedCount(stats.commitCount) : null,
    statsIssueCount: stats ? readPersistedCount(stats.issueCount) : null,
    statsPrCount: stats ? readPersistedCount(stats.prCount) : null,
    statsProviderId: stats?.providerId ?? null,
    statsLastUpdated: stats ? readPersistedCount(stats.lastUpdated) : null,
  };
}

function rowToProject(row: ProjectRow): Project {
  const project: Project = {
    id: row.id,
    path: row.path,
    name: row.name,
    emoji: row.emoji,
    lastOpened: row.lastOpened,
  };
  if (row.color !== null && row.color !== undefined) project.color = row.color;
  if (row.status !== null && row.status !== undefined) project.status = row.status as ProjectStatus;
  if (row.daintreeConfigPresent !== null && row.daintreeConfigPresent !== undefined)
    project.daintreeConfigPresent = row.daintreeConfigPresent;
  if (row.inRepoSettings !== null && row.inRepoSettings !== undefined)
    project.inRepoSettings = row.inRepoSettings;
  if (row.pinned) project.pinned = true;
  project.frecencyScore =
    typeof row.frecencyScore === "number" ? row.frecencyScore : FRECENCY_COLD_START;
  project.lastAccessedAt = typeof row.lastAccessedAt === "number" ? row.lastAccessedAt : 0;
  if (typeof row.autoParkedAt === "number") project.autoParkedAt = row.autoParkedAt;
  const lastKnownStats = rowToRepoStats(row);
  if (lastKnownStats) project.lastKnownStats = lastKnownStats;
  return project;
}

export class ProjectStore {
  /**
   * Newest forge observation seen per project id this session (issue #11078).
   * Ordering guard for `saveRepoStats` — see the comment there for why the
   * persisted timestamp cannot serve as the high-water mark by itself.
   * Process-local: a restart leaves no in-flight requests to order against.
   */
  private readonly repoStatsHighWater = new Map<string, number>();

  private projectsConfigDir: string;
  private globalConfigDir: string;
  private userDataDir: string;
  private settingsManager: ProjectSettingsManager;
  private stateManager: ProjectStateManager;
  private fileStore: ProjectFileStore;
  private globalFileStore: GlobalFileStore;
  private identityFiles: ProjectIdentityFiles;

  // SHA-256 of the raw on-disk bytes for each in-repo recipe, captured on
  // every successful read/write. Used by `writeInRepoRecipeChecked` to refuse
  // a write when an external tool (git pull, branch switch, stash pop) changed
  // the file since the renderer loaded it. Keyed by `${projectPath}|${recipeId}`
  // so the same recipe id in two different project clones stays separate.
  private inRepoRecipeHashes = new Map<string, string>();

  constructor() {
    this.userDataDir = app.getPath("userData");
    this.projectsConfigDir = path.join(this.userDataDir, "projects");
    this.globalConfigDir = path.join(this.userDataDir, "global");
    this.settingsManager = new ProjectSettingsManager(this.projectsConfigDir, store);
    this.stateManager = new ProjectStateManager(this.projectsConfigDir);
    this.fileStore = new ProjectFileStore(this.projectsConfigDir);
    this.globalFileStore = new GlobalFileStore(this.globalConfigDir);
    this.identityFiles = new ProjectIdentityFiles();
  }

  async initialize(): Promise<void> {
    if (!existsSync(this.projectsConfigDir)) {
      await fs.mkdir(this.projectsConfigDir, { recursive: true });
    }
    void cleanupQuarantinedProjectFiles(this.projectsConfigDir).catch((err) =>
      logError("[ProjectStore] Quarantine cleanup failed", err)
    );
    void cleanupGlobalQuarantineFiles(this.globalConfigDir).catch((err) =>
      logError("[GlobalFileStore] Quarantine cleanup failed", err)
    );
    void cleanupUserDataRootQuarantineFiles(this.userDataDir).catch((err) =>
      logError("[Store] Quarantine cleanup failed", err)
    );
  }

  // --- In-Repo Identity ---

  async readInRepoProjectIdentity(
    projectPath: string
  ): Promise<{ name?: string; emoji?: string; color?: string; found: boolean }> {
    return this.identityFiles.readInRepoProjectIdentity(projectPath);
  }

  async writeInRepoProjectIdentity(
    projectPath: string,
    data: { name?: string; emoji?: string; color?: string }
  ): Promise<void> {
    return this.identityFiles.writeInRepoProjectIdentity(projectPath, data);
  }

  async writeInRepoSettings(projectPath: string, settings: ProjectSettings): Promise<void> {
    return this.identityFiles.writeInRepoSettings(projectPath, settings);
  }

  private hashKey(projectPath: string, recipeId: string): string {
    return `${projectPath}|${recipeId}`;
  }

  // Drop every cached recipe hash for a project path. Called on remove/relocate
  // so stale `${projectPath}|...` entries don't accumulate after the path is
  // gone. Mirrors the prefix-scan in readInRepoRecipes.
  private pruneInRepoRecipeHashes(projectPath: string): void {
    const prefix = `${projectPath}|`;
    for (const key of this.inRepoRecipeHashes.keys()) {
      if (key.startsWith(prefix)) this.inRepoRecipeHashes.delete(key);
    }
  }

  /**
   * Unchecked write. Reserved for reconciliation paths that are authoritative
   * by design (recipe promotion from ProjectFileStore, write-through on sync)
   * and call sites that have already resolved any staleness conflict.
   * Renderer-driven edits must go through {@link writeInRepoRecipeChecked}.
   */
  async writeInRepoRecipe(projectPath: string, recipe: TerminalRecipe): Promise<void> {
    const hash = await this.identityFiles.writeInRepoRecipe(projectPath, recipe);
    this.inRepoRecipeHashes.set(this.hashKey(projectPath, recipe.id), hash);
  }

  /**
   * Writes `recipe` to `.daintree/recipes/`, but first verifies the on-disk
   * file hasn't drifted from the hash captured at load time. If it has, the
   * write is refused with an `AppError({ code: "RECIPE_STALE_CONFLICT" })` so
   * the renderer can surface a conflict dialog instead of silently clobbering
   * newer disk content (#9186).
   *
   * On a rename, the `previousName` file is also checked — without that, a
   * `Foo` → `Bar` rename would write `bar.json` (passes because the new file
   * doesn't exist yet) and then delete an externally-modified `foo.json`,
   * silently dropping the disk edits.
   *
   * `options.force === true` skips both comparisons and updates the cached
   * hash after the write — the renderer uses this for the explicit
   * "Overwrite" path.
   *
   * Brand-new recipes (file does not exist) are allowed unconditionally so
   * `createRecipe` / `importRecipe` paths work without a special-case flag.
   * If the file exists on disk but no cached hash exists, the file was added
   * externally between load and write — treat that as a stale conflict so the
   * user reconciles explicitly.
   */
  async writeInRepoRecipeChecked(
    projectPath: string,
    recipe: TerminalRecipe,
    options: { force?: boolean; previousName?: string } = {}
  ): Promise<void> {
    if (!options.force) {
      await this.assertRecipeFileNotStale(projectPath, recipe.id, recipe.name);
      if (
        options.previousName &&
        safeRecipeFilename(options.previousName) !== safeRecipeFilename(recipe.name)
      ) {
        // The rename will delete the old-name file; the user's load-time hash
        // is what we cached under this recipe's id. Since ids are now stable
        // across renames, `recipe.id` is the same id the old-name file was
        // cached under at load time — compare it against the current on-disk
        // bytes of the old-name file before letting the rename proceed.
        await this.assertRecipeFileNotStale(projectPath, recipe.id, options.previousName);
      }
    }
    const hash = await this.identityFiles.writeInRepoRecipe(projectPath, recipe);
    this.inRepoRecipeHashes.set(this.hashKey(projectPath, recipe.id), hash);
  }

  private async assertRecipeFileNotStale(
    projectPath: string,
    recipeId: string,
    recipeName: string
  ): Promise<void> {
    const onDiskHash = await this.identityFiles.getInRepoRecipeFileHash(projectPath, recipeName);
    if (onDiskHash === null) return;
    const cached = this.inRepoRecipeHashes.get(this.hashKey(projectPath, recipeId));
    if (cached === undefined || cached !== onDiskHash) {
      throw new AppError({
        code: "RECIPE_STALE_CONFLICT",
        message: `Recipe '${recipeName}' changed on disk since it was loaded`,
        userMessage: recipeName,
        context: { recipeId, name: recipeName },
      });
    }
  }

  async readInRepoRecipes(projectPath: string): Promise<TerminalRecipe[]> {
    const { recipes, hashes } = await this.identityFiles.readInRepoRecipesWithHashes(projectPath);
    // Replace this project's cached hashes with the freshly observed set so an
    // externally deleted recipe doesn't leave a stale entry pointing at a hash
    // for a file that no longer exists.
    const prefix = `${projectPath}|`;
    for (const key of this.inRepoRecipeHashes.keys()) {
      if (key.startsWith(prefix)) this.inRepoRecipeHashes.delete(key);
    }
    for (const [recipeId, hash] of hashes) {
      this.inRepoRecipeHashes.set(this.hashKey(projectPath, recipeId), hash);
    }
    return recipes;
  }

  async deleteInRepoRecipe(projectPath: string, recipeName: string): Promise<void> {
    await this.identityFiles.deleteInRepoRecipe(projectPath, recipeName);
    // Stale hash entries for the deleted file are harmless: a future write
    // through `writeInRepoRecipeChecked` will see the file is missing and
    // allow the write unconditionally, then refresh the cache. The cache is
    // also fully repopulated on the next readInRepoRecipes call.
  }

  async readInRepoPresets(projectPath: string): Promise<Record<string, AgentPreset[]>> {
    return this.identityFiles.readInRepoPresets(projectPath);
  }

  // --- DB CRUD ---

  private async getGitRoot(projectPath: string): Promise<string> {
    const gitService = new GitService(projectPath);
    const root = await gitService.getRepositoryRoot(projectPath);
    const canonical = await fs.realpath(root);
    return canonical;
  }

  async addProject(projectPath: string): Promise<Project> {
    let gitRoot: string;
    try {
      gitRoot = await this.getGitRoot(projectPath);
    } catch (error) {
      const message = formatErrorMessage(error, "Failed to add project");

      const causeMessage =
        isDaintreeError(error) && error.cause instanceof Error ? error.cause.message : undefined;
      const combined = [message, causeMessage].filter(Boolean).join("\n");
      const lower = combined.toLowerCase();

      if (lower.includes("spawn git enoent") || lower.includes("git: not found")) {
        throw new Error(
          "Git executable not found. Install Git and ensure it is available on your PATH."
        );
      }

      if (lower.includes("dubious ownership") || lower.includes("safe.directory")) {
        throw new Error(
          "Git refused to open this repository due to 'dubious ownership'. Mark it as safe.directory and try again."
        );
      }

      if (lower.includes("not a git repository")) {
        throw new AppError({
          code: "NOT_A_GIT_REPO",
          message: `Not a git repository: ${projectPath}`,
        });
      }

      throw new Error(combined || "Failed to open project");
    }

    // NFC-normalize for dedup so a Finder-dragged NFD path and a typed NFC
    // path map to the same project row on macOS. `path.normalize` only
    // handles separator/segment normalization; Unicode normalization is
    // independent.
    const normalizedPath = path.normalize(gitRoot).normalize("NFC");

    const existing = await this.getProjectByPath(normalizedPath);
    if (existing) {
      const now = Date.now();
      // Skip frecency churn under disk pressure — these are non-critical
      // ranking-signal writes. `lastOpened` is also non-critical here (the
      // existing project row is unchanged for the user's purposes).
      if (getWritesSuppressed()) {
        return existing;
      }
      const newScore = computeFrecencyScore(
        existing.frecencyScore ?? FRECENCY_COLD_START,
        existing.lastAccessedAt ?? 0,
        now
      );
      return this.updateProject(existing.id, {
        lastOpened: now,
        frecencyScore: newScore,
        lastAccessedAt: now,
      });
    }

    const inRepo = await this.readInRepoProjectIdentity(normalizedPath);

    const now = Date.now();
    const project: Project = {
      id: generateProjectId(normalizedPath),
      path: normalizedPath,
      name: inRepo.name ?? path.basename(normalizedPath),
      emoji: inRepo.emoji ?? DEFAULT_PROJECT_EMOJI,
      lastOpened: now,
      status: "closed",
      frecencyScore: FRECENCY_COLD_START,
      lastAccessedAt: now,
      ...(inRepo.color ? { color: inRepo.color } : {}),
      ...(inRepo.found ? { daintreeConfigPresent: true } : {}),
    };

    const db = getSharedDb();
    db.insert(projectsTable)
      .values({
        id: project.id,
        path: project.path,
        name: project.name,
        emoji: project.emoji,
        lastOpened: project.lastOpened,
        color: project.color ?? null,
        status: project.status ?? null,
        daintreeConfigPresent: project.daintreeConfigPresent ?? null,
        inRepoSettings: project.inRepoSettings ?? null,
        frecencyScore: FRECENCY_COLD_START,
        lastAccessedAt: now,
      })
      .run();

    return project;
  }

  async removeProject(projectId: string): Promise<void> {
    const stateDir = getProjectStateDir(this.projectsConfigDir, projectId);
    if (!stateDir) {
      throw new Error(`Invalid project ID: ${projectId}`);
    }

    // Capture the path before the DB delete so the recipe-hash cache can be
    // pruned by `${path}|` prefix afterward.
    const project = this.getProjectById(projectId);

    const db = getSharedDb();
    db.delete(projectsTable).where(eq(projectsTable.id, projectId)).run();

    if (project) {
      this.pruneInRepoRecipeHashes(project.path);
    }

    try {
      this.settingsManager.deleteAllEnvForProject(projectId);
    } catch (error) {
      logError(`Failed to remove secure env vars for ${projectId}`, error);
    }

    if (existsSync(stateDir)) {
      try {
        await fs.rm(stateDir, { recursive: true, force: true });
      } catch (error) {
        logError(`Failed to remove state directory for ${projectId}`, error);
      }
    }
    this.stateManager.invalidateProjectStateCache(projectId);

    if (this.getCurrentProjectId() === projectId) {
      this.clearCurrentProject();
    }
  }

  updateProject(
    projectId: string,
    // `autoParkedAt` widened to allow an explicit `null` so callers can CLEAR the
    // marker (the DB column is nullable). Passing `null` writes NULL; passing a
    // number sets it; omitting the key leaves it untouched. Don't route the clear
    // through `undefined` — a callee that strips undefined keys would silently
    // drop the clear (review #4).
    updates: Partial<Omit<Project, "autoParkedAt">> & { autoParkedAt?: number | null }
  ): Project {
    const db = getSharedDb();

    const set: Partial<{
      name: string;
      path: string;
      emoji: string;
      color: string | null;
      lastOpened: number;
      status: string | null;
      daintreeConfigPresent: boolean | null;
      inRepoSettings: boolean | null;
      pinned: number;
      frecencyScore: number;
      lastAccessedAt: number;
      autoParkedAt: number | null;
    }> = {};
    if (updates.name !== undefined) set.name = updates.name;
    if (updates.path !== undefined) set.path = updates.path;
    if (updates.emoji !== undefined) set.emoji = updates.emoji;
    if ("color" in updates) set.color = updates.color ?? null;
    if (updates.lastOpened !== undefined) set.lastOpened = updates.lastOpened;
    if (updates.status !== undefined) set.status = updates.status ?? null;
    if (updates.daintreeConfigPresent !== undefined)
      set.daintreeConfigPresent = updates.daintreeConfigPresent ?? null;
    if (updates.inRepoSettings !== undefined) set.inRepoSettings = updates.inRepoSettings ?? null;
    if (updates.pinned !== undefined) set.pinned = updates.pinned ? 1 : 0;
    if (updates.frecencyScore !== undefined) set.frecencyScore = updates.frecencyScore;
    if (updates.lastAccessedAt !== undefined) set.lastAccessedAt = updates.lastAccessedAt;
    if ("autoParkedAt" in updates) set.autoParkedAt = updates.autoParkedAt ?? null;

    if (Object.keys(set).length > 0) {
      db.update(projectsTable).set(set).where(eq(projectsTable.id, projectId)).run();
    }

    const row = db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).get();
    if (!row) throw new Error(`Project not found: ${projectId}`);
    return rowToProject(row);
  }

  /**
   * Persist the last-known repository counts for a project (issue #11078), so a
   * switch-back or a cold start can seed the toolbar from real numbers instead
   * of em-dashes that resize once a poll lands.
   *
   * The two count families have different owners and are updated independently:
   *
   * - `commitCount` is a local-git fact. Pass it whenever git actually answered.
   *   Omit it when the lookup failed — persisting a fallback zero over a good
   *   count is exactly the corruption this signature exists to prevent.
   * - `forge` carries the provider-reported counts. Pass it ONLY for a clean
   *   provider result. Omitting it preserves whatever is already stored; the
   *   commit-only path fires during transient provider resolution failures
   *   (plugin activating, temporarily disabled), and nulling the forge columns
   *   there would throw away good counts over a blip.
   *
   * A no-op when nothing material changed — the caller polls every ~30s, and a
   * provider that re-stamps `lastUpdated` on an unchanged probe must not turn
   * that into a write per poll.
   */
  saveRepoStats(
    projectPath: string,
    update: {
      commitCount?: number;
      forge?: { issueCount: number | null; prCount: number | null; providerId: string | null };
      lastUpdated?: number;
    }
  ): void {
    // Honour the same disk-pressure backpressure as every other cache write —
    // last-known counts are a nicety, never worth a write under pressure.
    if (getWritesSuppressed()) return;

    const db = getSharedDb();
    const normalizedPath = path.normalize(projectPath).normalize("NFC");
    const row = db.select().from(projectsTable).where(eq(projectsTable.path, normalizedPath)).get();
    // Stats are keyed to a registered project. A worktree path, or a directory
    // the user never added, has no row to hold them.
    if (!row) return;

    const set: Partial<{
      statsCommitCount: number;
      statsIssueCount: number | null;
      statsPrCount: number | null;
      statsProviderId: string | null;
      statsLastUpdated: number | null;
    }> = {};

    const nextCommitCount = readPersistedCount(update.commitCount);
    if (nextCommitCount !== null && nextCommitCount !== row.statsCommitCount) {
      set.statsCommitCount = nextCommitCount;
    }

    if (update.forge) {
      const { issueCount, prCount, providerId } = update.forge;
      const incomingAt = readPersistedCount(update.lastUpdated);

      // Forge counts come from plugin code. A provider returning `-1`, `1.5` or
      // `NaN` on an otherwise clean result would be written straight through and
      // then read back as `null`, silently destroying the good counts already
      // stored. Reject the whole forge snapshot rather than persist part of it.
      const forgeIsValid =
        (issueCount === null || readPersistedCount(issueCount) !== null) &&
        (prCount === null || readPersistedCount(prCount) !== null);

      // Discard a result that resolved out of order behind a newer one. The
      // stored timestamp can't serve as the high-water mark on its own: the
      // no-restamp policy below means a poll that merely *confirms* the current
      // counts leaves it untouched, so a delayed older observation could still
      // sail past it. Track the newest observation seen this session separately.
      // Process-local by design — a restart leaves no in-flight requests to
      // order against. Compared across providers too: a genuine provider change
      // always arrives on a fresh fetch, so it is never the older one.
      const highWater = Math.max(
        this.repoStatsHighWater.get(row.id) ?? 0,
        readPersistedCount(row.statsLastUpdated) ?? 0
      );
      const outOfOrder = incomingAt !== null && incomingAt < highWater;

      if (forgeIsValid && !outOfOrder) {
        if (incomingAt !== null) this.repoStatsHighWater.set(row.id, incomingAt);
        const changed =
          issueCount !== row.statsIssueCount ||
          prCount !== row.statsPrCount ||
          providerId !== row.statsProviderId;
        // Only a genuine count change advances the stored timestamp. Writing on
        // a re-stamp alone would mean a SQLite UPDATE on every poll of every
        // open project, forever, for a value nothing reads as fresh — the seed
        // is always applied as stale and revalidated behind.
        if (changed) {
          set.statsIssueCount = issueCount;
          set.statsPrCount = prCount;
          set.statsProviderId = providerId;
          set.statsLastUpdated = incomingAt;
        }
      }
    }

    if (Object.keys(set).length === 0) return;
    db.update(projectsTable).set(set).where(eq(projectsTable.id, row.id)).run();
  }

  updateProjectStatus(
    projectId: string,
    status: ProjectStatus,
    options?: { autoParkedAt?: number | null }
  ): Project {
    const updates: Partial<Omit<Project, "autoParkedAt">> & { autoParkedAt?: number | null } = {
      status,
    };
    if (options && "autoParkedAt" in options) {
      // Pass null straight through to clear; updateProject writes NULL for it.
      updates.autoParkedAt = options.autoParkedAt;
    }
    return this.updateProject(projectId, updates);
  }

  getAllProjects(): Project[] {
    const db = getSharedDb();
    const rows = db
      .select()
      .from(projectsTable)
      .orderBy(desc(projectsTable.frecencyScore), desc(projectsTable.lastOpened))
      .all();

    const validStatuses: ProjectStatus[] = ["active", "background", "closed", "missing"];
    const currentProjectId = this.getCurrentProjectId();

    // Compute the status repairs first without touching the DB, mutating each
    // row's in-memory status so the returned projects are always reconciled.
    // Only open a write-locking IMMEDIATE transaction when at least one row
    // actually needs repair — the common case (statuses already correct on a
    // repeat read) skips the transaction entirely, which is the hot-path win as
    // the projects list grows.
    const statusUpdates: Array<{ id: string; status: ProjectStatus }> = [];
    for (const row of rows) {
      if (row.id === currentProjectId) {
        if (row.status !== "active") {
          statusUpdates.push({ id: row.id, status: "active" });
          row.status = "active";
        }
      } else {
        if (row.status === "active") {
          if (process.env.DAINTREE_VERBOSE) {
            console.warn(
              `[ProjectStore] Demoting incorrectly active project ${row.id} to background`
            );
          }
          statusUpdates.push({ id: row.id, status: "background" });
          row.status = "background";
        } else if (row.status !== null && !validStatuses.includes(row.status as ProjectStatus)) {
          statusUpdates.push({ id: row.id, status: "closed" });
          row.status = "closed";
        }
      }
    }

    if (statusUpdates.length > 0) {
      db.transaction(
        (tx) => {
          for (const update of statusUpdates) {
            tx.update(projectsTable)
              .set({ status: update.status })
              .where(eq(projectsTable.id, update.id))
              .run();
          }
        },
        { behavior: "immediate" }
      );
    }

    if (process.env.DAINTREE_VERBOSE) {
      console.log(
        "[ProjectStore] getAllProjects statuses:",
        rows.map((r) => ({ name: r.name, status: r.status }))
      );
    }

    return rows.map(rowToProject);
  }

  async getProjectByPath(projectPath: string): Promise<Project | null> {
    const normalizedPath = path.normalize(projectPath).normalize("NFC");
    const db = getSharedDb();
    const row = db.select().from(projectsTable).where(eq(projectsTable.path, normalizedPath)).get();
    return row ? rowToProject(row) : null;
  }

  getProjectById(projectId: string): Project | null {
    const db = getSharedDb();
    const row = db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).get();
    return row ? rowToProject(row) : null;
  }

  async checkMissingProjects(): Promise<string[]> {
    const projects = this.getAllProjects();
    const currentProjectId = this.getCurrentProjectId();
    const missingIds: string[] = [];

    await Promise.allSettled(
      projects.map(async (project) => {
        if (project.id === currentProjectId) return;

        let exists = false;
        try {
          await fs.access(project.path);
          exists = true;
        } catch {
          exists = false;
        }

        if (!exists && project.status !== "missing") {
          this.updateProjectStatus(project.id, "missing");
          missingIds.push(project.id);
        } else if (exists && project.status === "missing") {
          // Clear any stale auto-parked marker — a project that went missing and
          // came back wasn't suspended by the idle sweep, so the switcher must
          // not label it "Suspended to free memory".
          this.updateProjectStatus(project.id, "closed", { autoParkedAt: null });
        }
      })
    );

    return missingIds;
  }

  async relocateProject(projectId: string, newPath: string): Promise<Project> {
    const project = this.getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    if (projectId === this.getCurrentProjectId()) {
      throw new Error("Cannot relocate the currently active project");
    }

    const canonicalNewPath = await this.getGitRoot(newPath);
    const newProjectId = generateProjectId(canonicalNewPath);

    if (newProjectId === projectId) {
      return this.updateProject(projectId, { path: canonicalNewPath, status: "closed" });
    }

    const existingAtNewPath = this.getProjectById(newProjectId);
    if (existingAtNewPath) {
      throw new Error(`A project already exists at that location: ${existingAtNewPath.name}`);
    }

    const oldStateDir = getProjectStateDir(this.projectsConfigDir, projectId);
    const newStateDir = getProjectStateDir(this.projectsConfigDir, newProjectId);

    if (oldStateDir && newStateDir && existsSync(oldStateDir)) {
      await fs.cp(oldStateDir, newStateDir, { recursive: true });
    }

    const projects = this.getAllProjects();
    const index = projects.findIndex((p) => p.id === projectId);
    if (index === -1) {
      if (newStateDir && existsSync(newStateDir)) {
        await fs.rm(newStateDir, { recursive: true, force: true }).catch(() => {});
      }
      throw new Error(`Project not found: ${projectId}`);
    }

    const oldProject = projects[index];
    const updatedProject: Project = {
      ...oldProject,
      id: newProjectId,
      path: canonicalNewPath,
      status: "closed",
    };

    const db = getSharedDb();
    try {
      db.delete(projectsTable).where(eq(projectsTable.id, projectId)).run();
      db.insert(projectsTable)
        .values({
          id: updatedProject.id,
          path: updatedProject.path,
          name: updatedProject.name,
          emoji: updatedProject.emoji,
          lastOpened: updatedProject.lastOpened,
          color: updatedProject.color ?? null,
          status: updatedProject.status ?? null,
          daintreeConfigPresent: updatedProject.daintreeConfigPresent ?? null,
          inRepoSettings: updatedProject.inRepoSettings ?? null,
          pinned: updatedProject.pinned ? 1 : 0,
          frecencyScore: updatedProject.frecencyScore ?? FRECENCY_COLD_START,
          lastAccessedAt: updatedProject.lastAccessedAt ?? 0,
          ...repoStatsToColumns(updatedProject.lastKnownStats),
        })
        .run();
      this.settingsManager.migrateEnvForProject(projectId, newProjectId);
      this.stateManager.invalidateProjectStateCache(projectId);
      this.stateManager.invalidateProjectStateCache(newProjectId);
    } catch (error) {
      db.delete(projectsTable).where(eq(projectsTable.id, newProjectId)).run();
      db.insert(projectsTable)
        .values({
          id: oldProject.id,
          path: oldProject.path,
          name: oldProject.name,
          emoji: oldProject.emoji,
          lastOpened: oldProject.lastOpened,
          color: oldProject.color ?? null,
          status: oldProject.status ?? null,
          daintreeConfigPresent: oldProject.daintreeConfigPresent ?? null,
          inRepoSettings: oldProject.inRepoSettings ?? null,
          pinned: oldProject.pinned ? 1 : 0,
          frecencyScore: oldProject.frecencyScore ?? FRECENCY_COLD_START,
          lastAccessedAt: oldProject.lastAccessedAt ?? 0,
          ...repoStatsToColumns(oldProject.lastKnownStats),
        })
        .run();
      if (newStateDir && existsSync(newStateDir)) {
        await fs.rm(newStateDir, { recursive: true, force: true }).catch(() => {});
      }
      throw error;
    }

    // The old path is gone — drop its cached recipe hashes so they don't linger.
    this.pruneInRepoRecipeHashes(oldProject.path);

    if (oldStateDir && existsSync(oldStateDir)) {
      await fs.rm(oldStateDir, { recursive: true, force: true }).catch((err) => {
        logError(`Failed to clean up old state dir for project ${projectId}`, err);
      });
    }

    return updatedProject;
  }

  // --- Current Project ---

  getCurrentProjectId(): string | null {
    const db = getSharedDb();
    const row = db
      .select()
      .from(appStateTable)
      .where(eq(appStateTable.key, "currentProjectId"))
      .get();
    return row?.value ?? null;
  }

  getCurrentProject(): Project | null {
    const currentId = this.getCurrentProjectId();
    if (!currentId) return null;
    return this.getProjectById(currentId);
  }

  /**
   * `outgoingProjectId` names the project the switching window was actually
   * displaying — the one to background and MRU-bump. Three distinct meanings:
   *   - omitted/`undefined`: infer from the global pointer (single-window and
   *     legacy callers, where the two always agree).
   *   - a string: background exactly that project. Multi-window callers pass
   *     their own view's project; the global pointer names whichever window
   *     switched most recently, which is a different question (#11101).
   *   - `null`: the window had no project displayed (welcome view), so no row
   *     is backgrounded — only the pointer moves and the incoming row activates.
   * `?? this.getCurrentProjectId()` would collapse that `null` back into an
   * unrelated window's project, which is the bug this parameter exists to fix.
   */
  async setCurrentProject(projectId: string, outgoingProjectId?: string | null): Promise<void> {
    const project = this.getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const previousProjectId =
      outgoingProjectId === undefined ? this.getCurrentProjectId() : outgoingProjectId;
    const db = getSharedDb();

    const now = Date.now();
    // Suppress frecency-signal columns under disk pressure but keep the
    // critical state updates (currentProjectId pointer + active/background
    // status) unconditional — those are session state the user depends on.
    const writesSuppressed = getWritesSuppressed();
    const newScore = writesSuppressed
      ? null
      : computeFrecencyScore(
          project.frecencyScore ?? FRECENCY_COLD_START,
          project.lastAccessedAt ?? 0,
          now
        );

    db.transaction(
      (tx) => {
        if (previousProjectId && previousProjectId !== projectId) {
          console.log(`[ProjectStore] Marking previous project ${previousProjectId} as background`);
          // Bump the departing project's lastOpened to just before `now` so it
          // becomes the top MRU candidate on the next switch — gives the
          // Cmd+Alt+= shortcut Alt+Tab-style toggle behavior.
          const previousUpdate: { status: "background"; lastOpened?: number } = {
            status: "background",
          };
          if (!writesSuppressed) {
            previousUpdate.lastOpened = now - 1;
          }
          tx.update(projectsTable)
            .set(previousUpdate)
            .where(eq(projectsTable.id, previousProjectId))
            .run();
        }
        tx.insert(appStateTable)
          .values({ key: "currentProjectId", value: projectId })
          .onConflictDoUpdate({ target: appStateTable.key, set: { value: projectId } })
          .run();
        const activeUpdate: {
          status: "active";
          lastOpened?: number;
          frecencyScore?: number;
          lastAccessedAt?: number;
          autoParkedAt: number | null;
          // Reopening a project clears any background-idle "parked" marker so the
          // switcher stops showing "Suspended to free memory" once it's live again.
        } = { status: "active", autoParkedAt: null };
        if (!writesSuppressed && newScore !== null) {
          activeUpdate.lastOpened = now;
          activeUpdate.frecencyScore = newScore;
          activeUpdate.lastAccessedAt = now;
        }
        tx.update(projectsTable).set(activeUpdate).where(eq(projectsTable.id, projectId)).run();
      },
      { behavior: "immediate" }
    );

    if (process.env.DAINTREE_VERBOSE) {
      const updatedPrevious = previousProjectId ? this.getProjectById(previousProjectId) : null;
      console.log(`[ProjectStore] setCurrentProject complete:`, {
        newCurrentId: projectId,
        previousId: previousProjectId,
        previousStatus: updatedPrevious?.status,
        allStatuses: this.getAllProjects().map((p) => ({ name: p.name, status: p.status })),
      });
    }
  }

  clearCurrentProject(): void {
    const db = getSharedDb();
    db.delete(appStateTable).where(eq(appStateTable.key, "currentProjectId")).run();
  }

  // --- State ---

  async saveProjectState(projectId: string, state: ProjectState): Promise<void> {
    // Invalidate before the write so any in-flight prefetch sees a version bump
    // and discards its result — otherwise a prefetch resolving after the write
    // could clobber the cache with pre-mutation state.
    invalidatePrefetchCache(projectId);
    return this.stateManager.saveProjectState(projectId, state);
  }

  async enqueueProjectStateUpdate(
    projectId: string,
    updater: (existing: ProjectState | null) => ProjectState | null | Promise<ProjectState | null>
  ): Promise<void> {
    return this.stateManager.enqueueProjectStateUpdate(projectId, async (existing) => {
      const updated = await updater(existing);
      if (updated !== null) {
        // Same contract as saveProjectState: invalidate before the write so an
        // in-flight prefetch can't clobber the cache with pre-mutation state.
        invalidatePrefetchCache(projectId);
      }
      return updated;
    });
  }

  async getProjectState(projectId: string): Promise<ProjectState | null> {
    return this.stateManager.getProjectState(projectId);
  }

  async getProjectStateWithRecovery(projectId: string): Promise<ProjectStateReadResult> {
    return this.stateManager.getProjectStateWithRecovery(projectId);
  }

  async clearProjectState(projectId: string): Promise<void> {
    return this.stateManager.clearProjectState(projectId);
  }

  // --- Settings ---

  async getProjectSettings(projectId: string): Promise<ProjectSettings> {
    return this.settingsManager.getProjectSettings(projectId);
  }

  async getProjectNotificationOverrides(
    projectIds: string[]
  ): Promise<Record<string, Partial<NotificationSettings>>> {
    return this.settingsManager.getProjectNotificationOverrides(projectIds);
  }

  async saveProjectSettings(projectId: string, settings: ProjectSettings): Promise<void> {
    return this.settingsManager.saveProjectSettings(projectId, settings);
  }

  getEffectiveNotificationSettings(): NotificationSettings {
    return this.settingsManager.getEffectiveNotificationSettings(this.getCurrentProjectId());
  }

  // --- Recipes ---

  async getRecipes(projectId: string): Promise<TerminalRecipe[]> {
    return this.fileStore.getRecipes(projectId);
  }

  /**
   * Reconcile the two recipe stores so ProjectFileStore matches the canonical
   * .daintree/recipes/ files. Handles four cases:
   *
   * 1. Recipe in both stores → in-repo wins (canonical), overrides ProjectFileStore
   * 2. Recipe only in .daintree/ → backfill to ProjectFileStore
   * 3. Recipe only in ProjectFileStore, not in-repo → promote to .daintree/
   *    (legacy from migration 003), then backfill
   * 4. Recipe only in ProjectFileStore, in-repo scope → remove stale copy
   *    (was deleted from .daintree/ but lingered in ProjectFileStore)
   *
   * When backfilling to ProjectFileStore, runtime-only fields (env values,
   * projectId, worktreeId, lastUsedAt, usageHistory) are preserved from the
   * existing fileStore copy so that secrets and usage metadata survive.
   *
   * Returns any filename collisions encountered while promoting (case 3): two
   * recipes whose names slugify to the same `.daintree/recipes/` filename. The
   * un-promotable recipe is kept as a project-local recipe (never silently
   * dropped — that was the #9195 bug) and the collision is returned so the
   * renderer can surface it instead of logging to the console only.
   *
   * Idempotent: running twice produces no additional writes (aside from the
   * rare persistent-collision case, where the un-promotable recipe is re-kept).
   */
  async reconcileProjectRecipes(
    projectPath: string,
    projectId: string
  ): Promise<RecipeNameCollision[]> {
    // Go through the cache-aware wrapper so the hash map is populated as a
    // side effect — otherwise the first renderer-driven edit after a project
    // load races the unrelated `getInRepoRecipes` call to populate the cache
    // and may see a phantom RECIPE_STALE_CONFLICT.
    const inRepoRecipes = await this.readInRepoRecipes(projectPath);
    const fileStoreRecipes = await this.fileStore.getRecipes(projectId);

    const inRepoById = new Map(inRepoRecipes.map((r) => [r.id, r]));
    const fileStoreById = new Map(fileStoreRecipes.map((r) => [r.id, r]));

    let promoted = false;
    const collisions: RecipeNameCollision[] = [];
    // Project-local recipes that couldn't be promoted (filename collision) but
    // must survive in ProjectFileStore rather than being dropped.
    const keptLocal: TerminalRecipe[] = [];
    const seenFilenames = new Map<string, string>();
    for (const recipe of inRepoById.values()) {
      seenFilenames.set(safeRecipeFilename(recipe.name), recipe.id);
    }

    for (const recipe of fileStoreRecipes) {
      if (inRepoById.has(recipe.id)) continue;
      if (isInRepoRecipeId(recipe)) continue; // stale, removed below

      const filename = safeRecipeFilename(recipe.name);
      const ownerId = seenFilenames.get(filename);
      if (ownerId !== undefined && ownerId !== recipe.id) {
        // Can't promote: a different recipe already owns this filename. Keep
        // it as a project-local recipe and report the collision upward.
        collisions.push({
          filename,
          keptId: ownerId,
          droppedId: recipe.id,
          droppedName: recipe.name,
        });
        keptLocal.push(recipe);
        continue;
      }

      await this.writeInRepoRecipe(projectPath, recipe);
      inRepoById.set(recipe.id, recipe);
      seenFilenames.set(filename, recipe.id);
      promoted = true;
    }

    const hasStale = fileStoreRecipes.some((r) => isInRepoRecipeId(r) && !inRepoById.has(r.id));

    const reconciledIds = new Set(inRepoById.keys());
    const sizeChanged = reconciledIds.size !== fileStoreById.size;
    const idsChanged = ![...reconciledIds].every((id) => fileStoreById.has(id));

    if (!promoted && !hasStale && !sizeChanged && !idsChanged && collisions.length === 0) {
      // IDs match perfectly — check content before skipping
      let contentDiffers = false;
      for (const recipe of inRepoById.values()) {
        const existing = fileStoreById.get(recipe.id);
        if (!existing) continue;
        const {
          projectId: _p1,
          worktreeId: _w1,
          ...inRepoNorm
        } = recipe as unknown as Record<string, unknown>;
        const {
          projectId: _p2,
          worktreeId: _w2,
          ...fsNorm
        } = existing as unknown as Record<string, unknown>;
        if (JSON.stringify(inRepoNorm) !== JSON.stringify(fsNorm)) {
          contentDiffers = true;
          break;
        }
      }
      if (!contentDiffers) return collisions;
    }

    // Build reconciled list: start from in-repo canonical, merge fileStore-only
    // fields (env values, metadata) so they survive the write-back.
    const reconciled: TerminalRecipe[] = [];
    for (const recipe of inRepoById.values()) {
      const existing = fileStoreById.get(recipe.id);
      if (!existing) {
        reconciled.push(recipe);
        continue;
      }

      const mergedTerminals = recipe.terminals.map((inRepoT, i) => {
        const existingT = existing.terminals[i];
        if (!existingT?.env || Object.keys(existingT.env).length === 0) return inRepoT;
        const env: Record<string, string> = {};
        for (const key of Object.keys(inRepoT.env ?? {})) {
          env[key] = existingT.env[key] ?? "";
        }
        return { ...inRepoT, env };
      });

      reconciled.push({
        ...recipe,
        terminals: mergedTerminals,
        projectId: existing.projectId,
        worktreeId: existing.worktreeId,
        lastUsedAt: existing.lastUsedAt,
        usageHistory: existing.usageHistory,
      });
    }

    // Keep project-local recipes that couldn't be promoted (filename collision)
    // so they survive the write-back rather than being silently dropped.
    reconciled.push(...keptLocal);

    await this.fileStore.saveRecipes(projectId, reconciled);
    return collisions;
  }

  async saveRecipes(projectId: string, recipes: TerminalRecipe[]): Promise<void> {
    return this.fileStore.saveRecipes(projectId, recipes);
  }

  async addRecipe(projectId: string, recipe: TerminalRecipe): Promise<void> {
    return this.fileStore.addRecipe(projectId, recipe);
  }

  async updateRecipe(
    projectId: string,
    recipeId: string,
    updates: Partial<Omit<TerminalRecipe, "id" | "projectId" | "createdAt">>
  ): Promise<void> {
    return this.fileStore.updateRecipe(projectId, recipeId, updates);
  }

  async deleteRecipe(projectId: string, recipeId: string): Promise<void> {
    return this.fileStore.deleteRecipe(projectId, recipeId);
  }

  // --- Global Recipes ---

  async getGlobalRecipes(): Promise<TerminalRecipe[]> {
    return this.globalFileStore.getRecipes();
  }

  async addGlobalRecipe(recipe: TerminalRecipe): Promise<void> {
    return this.globalFileStore.addRecipe(recipe);
  }

  async updateGlobalRecipe(
    recipeId: string,
    updates: Partial<Omit<TerminalRecipe, "id" | "projectId" | "createdAt">>
  ): Promise<void> {
    return this.globalFileStore.updateRecipe(recipeId, updates);
  }

  async deleteGlobalRecipe(recipeId: string): Promise<void> {
    return this.globalFileStore.deleteRecipe(recipeId);
  }
}

export const projectStore = new ProjectStore();
