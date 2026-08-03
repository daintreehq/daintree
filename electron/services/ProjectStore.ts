// eager-import-allow: reads/writes the project list via sync fs during startup
import type {
  Project,
  ProjectAddOptions,
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
import { assertProjectDirectory, isMissingExecutableError } from "./projectOpenPreflight.js";
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
import {
  generateProjectId,
  mintProjectId,
  isValidProjectId,
  getProjectStateDir,
} from "./projectStorePaths.js";
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

import { bumpFrecencyScore, decayFrecencyScore, FRECENCY_COLD_START } from "./frecency.js";
import { getWritesSuppressed } from "./diskPressureState.js";
import { rewriteProjectStatePaths } from "./projectPathStateRewrite.js";
import { rewriteAgentSessionPathsForProject } from "./pty/agentSessionHistory.js";
import { getPendingHelpHibernationStore } from "./PendingHelpHibernationStore.js";
import { repairMovedSubmodulePaths } from "./git/submodulePathRepair.js";

export { DEFAULT_PROJECT_EMOJI } from "../../shared/utils/projectEmoji.js";
import { DEFAULT_PROJECT_EMOJI } from "../../shared/utils/projectEmoji.js";

/**
 * The single spelling of a project path used for identity comparisons. Separator
 * normalization and Unicode normalization are independent problems: a
 * Finder-dragged NFD path and a typed NFC path denote the same folder on macOS
 * but are different strings, so both operands of any path comparison have to go
 * through here.
 */
export function normalizeProjectPath(projectPath: string): string {
  return path.normalize(projectPath).normalize("NFC");
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT"
  );
}

/**
 * Best-effort re-link of a moved project's linked worktrees. Deliberately never
 * throws: a project whose folder moved is still perfectly usable on its own, so
 * a repair failure must not fail the relocation and strand the user with an
 * unregistered project.
 */
async function repairLinkedWorktrees(oldPath: string, newPath: string): Promise<void> {
  try {
    await new GitService(newPath).repairWorktrees();
  } catch (error) {
    logError(`Failed to repair linked worktrees for ${newPath}`, error);
  }
  // `git worktree repair` ignores submodules; rebase any absolute submodule
  // pointers the move left stale ourselves (#11282). Never throws.
  await repairMovedSubmodulePaths(oldPath, newPath);
}

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
  if (typeof row.lastCompletionSeenAt === "number")
    project.lastCompletionSeenAt = row.lastCompletionSeenAt;
  if (typeof row.autoParkedAt === "number") project.autoParkedAt = row.autoParkedAt;
  // Only `false` is carried: null means git-backed, and so does absence.
  if (row.gitBacked === false) project.gitBacked = false;
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

  // Operation-scoped path rewrites for projects being relocated by the phase-3
  // coordinator (#11282). While a project id is present here, EVERY persisted
  // state write for it is rebased old→new before hitting disk — so a debounced
  // renderer layout write still in flight with the OLD root (the live-repoint
  // keeps the view alive, so it keeps writing) can't clobber the migrated state
  // after the folder move. Bounded to the coordinator's operation via
  // begin/endRelocationRewrite.
  private relocationRewrites = new Map<string, { oldPath: string; newPath: string }>();

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
  ): Promise<{ id?: string; name?: string; emoji?: string; color?: string; found: boolean }> {
    return this.identityFiles.readInRepoProjectIdentity(projectPath);
  }

  async writeInRepoProjectIdentity(
    projectPath: string,
    data: { id?: string; name?: string; emoji?: string; color?: string }
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
    const { recipes } = await this.readInRepoRecipesWithMeta(projectPath);
    return recipes;
  }

  /**
   * Cache-populating read shared by {@link readInRepoRecipes} and
   * {@link reconcileProjectRecipes}. In addition to the recipes, it surfaces
   * `dirExists` so reconciliation can tell an absent `.daintree/recipes/`
   * directory (a checked-out branch/commit that predates recipes) apart from an
   * authoritatively empty one — the former must never authorize pruning
   * project-local mirrors (#11347). The public array-returning
   * {@link readInRepoRecipes} keeps its signature for its unrelated callers.
   */
  private async readInRepoRecipesWithMeta(
    projectPath: string
  ): Promise<{ recipes: TerminalRecipe[]; dirExists: boolean; scanComplete: boolean }> {
    const { recipes, hashes, dirExists, scanComplete } =
      await this.identityFiles.readInRepoRecipesWithHashes(projectPath);
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
    return { recipes, dirExists, scanComplete };
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

  /**
   * Canonical spelling of a path for comparison against a resolved git root:
   * realpath (resolving symlinks and case) then the same separator + NFC
   * normalization the root gets. Returns null if the path can't be resolved,
   * which compares unequal to every root — the safe direction.
   */
  private async canonicalizeForCompare(input: string): Promise<string | null> {
    try {
      return normalizeProjectPath(await fs.realpath(input));
    } catch {
      return null;
    }
  }

  private async getGitRoot(projectPath: string): Promise<string> {
    const gitService = new GitService(projectPath);
    const root = await gitService.getRepositoryRoot(projectPath);
    const canonical = await fs.realpath(root);
    return canonical;
  }

  /**
   * Decide whether a folder is backed by a repository, or throw the classified
   * reason we couldn't tell.
   *
   * The only trustworthy answer to that question in the codebase. `gitBacked:
   * false` is returned exclusively for a folder git positively reports as "not a
   * git repository" *and* which still validates as a readable directory —
   * everything ambiguous (missing binary, dubious ownership, dead mount,
   * permissions, anything unrecognized) throws its own code instead, because
   * callers use a negative answer to withdraw a project's git identity and must
   * never do that off a transient failure. `WorkspaceService.isGitRepository`
   * deliberately makes the opposite trade (any failure means "no repository")
   * and is correct for withholding features, but must not drive a stored
   * classification.
   */
  async classifyGitBacking(
    projectPath: string
  ): Promise<{ gitBacked: true; gitRoot: string } | { gitBacked: false }> {
    // Classify the path before git ever sees it. simple-git's own synchronous
    // baseDir check throws first otherwise, and its error can't distinguish a
    // missing folder from a file — the root cause of #11409.
    await assertProjectDirectory(projectPath);

    try {
      return { gitBacked: true, gitRoot: await this.getGitRoot(projectPath) };
    } catch (error) {
      const message = formatErrorMessage(error, "Failed to add project");

      const causeMessage =
        isDaintreeError(error) && error.cause instanceof Error ? error.cause.message : undefined;
      const combined = [message, causeMessage].filter(Boolean).join("\n");
      const lower = combined.toLowerCase();

      // Classified before the directory re-check below because it's a property
      // of the machine, not the path: a transient stat failure must not mask
      // "git isn't installed", and a missing binary must not be reported as a
      // problem with the folder.
      if (isMissingExecutableError(error)) {
        throw new AppError({
          code: "GIT_NOT_INSTALLED",
          message: "Git executable not found",
          context: { projectPath },
          cause: error instanceof Error ? error : undefined,
        });
      }

      if (lower.includes("dubious ownership") || lower.includes("safe.directory")) {
        // The substring match is against git's own stderr, which git genuinely
        // emits. What the renderer keys on is the code, so this message is
        // diagnostic copy and free to be reworded.
        throw new AppError({
          code: "DUBIOUS_OWNERSHIP",
          message:
            "Git refused to open this repository due to 'dubious ownership'. Mark it as safe.directory and try again.",
          context: { projectPath },
        });
      }

      // Re-check the directory before reporting no-repository: several awaits
      // have passed since the pre-flight, and a folder deleted or swapped for a
      // file in that window reports as "not a git repository" too. Offering to
      // run `git init` in a folder that no longer exists — or demoting a row on
      // the strength of it — would be worse than useless, so a path that stopped
      // validating is reclassified here.
      await assertProjectDirectory(projectPath);

      if (lower.includes("not a git repository")) {
        return { gitBacked: false };
      }

      // Everything unrecognized becomes one opaque code, and the raw text is
      // demoted to diagnostics. The old fallback rethrew `combined` as the
      // message, which is how "Git operation failed: getRepositoryRoot" and
      // simple-git's own wording reached the user (#11409) — keeping it out of
      // `message` means even a surface that naively renders `error.message`
      // can't leak it.
      logError("Failed to open project", error, { projectPath });
      throw new AppError({
        code: "PROJECT_OPEN_FAILED",
        message: `Failed to open project: ${projectPath}`,
        context: { projectPath, detail: combined },
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * `options.identity` is the name/emoji chosen in a creation dialog. It is
   * consulted only where a brand-new row is minted below — every earlier return
   * (already-registered path, adopted move, lost insert race) keeps the
   * identity it already has, so re-adding a folder can never rename it.
   * In-repo `.daintree/project.json` still wins field-wise.
   *
   * `options.gitBacked === false` adopts a folder that has no repository at
   * all; anything else keeps the strict git-root requirement. The two options
   * are read independently — a lightweight open carries no identity, and an
   * identity never implies a mode.
   */
  async addProject(projectPath: string, options?: ProjectAddOptions): Promise<Project> {
    const creationIdentity = options?.identity;
    const classification = await this.classifyGitBacking(projectPath);

    if (!classification.gitBacked) {
      // The folder has no repository. Adopt it as a lightweight workspace when
      // the caller asked for that explicitly, or when it is already registered
      // as one — the latter is what lets Recents, Dock drops, Open With and the
      // CLI reopen it without re-prompting (#11405). Anything else keeps
      // today's behavior and drives the choice dialog.
      //
      // A registered *git-backed* row is deliberately not demoted on its own:
      // git failing to see a repository at a path we recorded as one is an
      // anomaly (an unmounted volume, a permissions blip, a `.git` deleted out
      // from under us), and silently rewriting the row would lose that project's
      // git identity for good. It falls through to the choice dialog, where
      // demotion becomes the user's explicit decision — which is also how the
      // switch/reopen handlers reach that dialog, since they surface this same
      // code rather than activating a row whose repository is gone (#11649).
      const lightweight = await this.resolveLightweightPath(projectPath);
      if (lightweight) {
        const existing = await this.getProjectByPath(lightweight);
        if (existing) {
          if (existing.gitBacked === false || options?.gitBacked === false) {
            return this.touchExistingProject(existing, { gitBacked: false });
          }
        } else if (options?.gitBacked === false) {
          return this.insertLightweightProject(lightweight);
        }
      }

      throw new AppError({
        code: "NOT_A_GIT_REPO",
        message: `Not a git repository: ${projectPath}`,
      });
    }

    // NFC-normalize for dedup so a Finder-dragged NFD path and a typed NFC
    // path map to the same project row on macOS. `path.normalize` only
    // handles separator/segment normalization; Unicode normalization is
    // independent.
    const normalizedPath = path.normalize(classification.gitRoot).normalize("NFC");

    // The registered project is the git ROOT, which is not always the path the
    // caller handed us: creating `/repo/child` inside an existing repository
    // resolves back to `/repo`. Identity chosen for the child must not be
    // stamped onto the ancestor, so it only survives when the two agree.
    //
    // Both sides are canonicalized the same way (`normalizedPath` already comes
    // from a realpath'd git root). A lexical-only comparison here would treat a
    // symlinked path, a trailing separator, or different casing on a
    // case-insensitive volume as a mismatch and silently discard an identity
    // the user actually chose.
    const mintIdentity =
      (await this.canonicalizeForCompare(projectPath)) === normalizedPath
        ? creationIdentity
        : undefined;

    const existing = await this.getProjectByPath(normalizedPath);
    if (existing) {
      // A git root resolved, so promote a row that was adopted without one —
      // this is what `git init` on a lightweight workspace lands on (#11405).
      return this.touchExistingProject(existing, { gitBacked: true });
    }

    const inRepo = await this.readInRepoProjectIdentity(normalizedPath);

    // The folder may be a project we already know that simply moved. `inRepo.id`
    // is the anchor written into `.daintree/project.json`; if it names a row
    // whose registered path is gone, this is that project at its new home and
    // its identity — and therefore every id-keyed piece of state — is preserved
    // in place (#11282).
    const relocated = await this.tryAdoptMovedProject(inRepo.id, normalizedPath);
    if (relocated) return relocated;

    // Re-check under the same tick as the insert. Several awaits have happened
    // since the lookup above, and a concurrent `addProject` for this same folder
    // would otherwise get past that stale check, find the path-derived id taken,
    // mint a *random* one and insert a second row for one directory — the path
    // column has no unique index to catch it.
    const raced = await this.getProjectByPath(normalizedPath);
    if (raced) return raced;

    const now = Date.now();
    const project: Project = {
      id: mintProjectId(normalizedPath, (candidate) => this.isProjectIdTaken(candidate)),
      path: normalizedPath,
      name: inRepo.name ?? mintIdentity?.name ?? path.basename(normalizedPath),
      emoji: inRepo.emoji ?? mintIdentity?.emoji ?? DEFAULT_PROJECT_EMOJI,
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

  /**
   * Reopen an already-registered project: bump its ranking signals and reconcile
   * its git-backed mode.
   *
   * The mode flip is written even while disk-pressure suppression is on. Frecency
   * and `lastOpened` are non-critical ranking churn and are rightly dropped under
   * pressure, but the mode decides whether the workspace host enumerates
   * worktrees at all — losing it would leave the row describing the wrong kind of
   * workspace until the next uncontended open.
   */
  private touchExistingProject(existing: Project, mode: { gitBacked: boolean }): Project {
    // Stored as null rather than 1 for a repository, so a git-backed row is
    // indistinguishable from every row predating the column.
    const nextGitBacked = mode.gitBacked ? undefined : false;
    const modeChanged = existing.gitBacked !== nextGitBacked;

    const now = Date.now();
    if (getWritesSuppressed()) {
      return modeChanged ? this.updateProject(existing.id, { gitBacked: nextGitBacked }) : existing;
    }

    // The pre-update lastOpened is the debounce clock: re-adding a project you
    // left moments ago must not count as fresh engagement.
    const newScore = bumpFrecencyScore(
      existing.frecencyScore ?? FRECENCY_COLD_START,
      existing.lastAccessedAt ?? 0,
      existing.lastOpened ?? 0,
      now
    );
    return this.updateProject(existing.id, {
      lastOpened: now,
      frecencyScore: newScore,
      lastAccessedAt: now,
      ...(modeChanged ? { gitBacked: nextGitBacked } : {}),
    });
  }

  /**
   * Canonical registry path for a folder with no repository, or `null` when it
   * isn't a usable directory.
   *
   * Git-backed projects register their repository root; a lightweight workspace
   * has none, so the adopted folder itself is the identity. Symlinks are resolved
   * and the result NFC-normalized to match {@link addProject}'s dedup rules.
   */
  private async resolveLightweightPath(projectPath: string): Promise<string | null> {
    try {
      const canonical = await fs.realpath(projectPath);
      const stats = await fs.stat(canonical);
      if (!stats.isDirectory()) return null;
      return path.normalize(canonical).normalize("NFC");
    } catch {
      return null;
    }
  }

  /**
   * Register a folder that has no repository.
   *
   * Deliberately skips `.daintree/project.json`: reading identity from an
   * arbitrary folder would let a downloaded archive carrying a stray anchor
   * either rename itself after an unrelated project or, through
   * {@link tryAdoptMovedProject}, take over that project's id and inherit its
   * panels, settings and Assistant history.
   */
  private insertLightweightProject(normalizedPath: string): Project {
    const now = Date.now();
    const project: Project = {
      id: mintProjectId(normalizedPath, (candidate) => this.isProjectIdTaken(candidate)),
      path: normalizedPath,
      name: path.basename(normalizedPath),
      emoji: DEFAULT_PROJECT_EMOJI,
      lastOpened: now,
      status: "closed",
      frecencyScore: FRECENCY_COLD_START,
      lastAccessedAt: now,
      gitBacked: false,
    };

    getSharedDb()
      .insert(projectsTable)
      .values({
        id: project.id,
        path: project.path,
        name: project.name,
        emoji: project.emoji,
        lastOpened: project.lastOpened,
        status: project.status ?? null,
        frecencyScore: FRECENCY_COLD_START,
        lastAccessedAt: now,
        gitBacked: false,
      })
      .run();

    return project;
  }

  /**
   * True if `candidate` may not be handed to a new project.
   *
   * A registered row is the obvious case, but a leftover *state directory* is
   * just as disqualifying: cleanup after a removed project is best-effort, so an
   * orphaned directory can outlive its row. Reusing its id would silently serve
   * a dead project's panels, settings and secure-env keys to an unrelated
   * repository.
   */
  private isProjectIdTaken(candidate: string): boolean {
    if (this.getProjectById(candidate) !== null) return true;
    const stateDir = getProjectStateDir(this.projectsConfigDir, candidate);
    return stateDir !== null && existsSync(stateDir);
  }

  /**
   * Decides whether the folder now at `normalizedPath` is an already-registered
   * project that moved, and if so repoints it in place.
   *
   * `.daintree/project.json` is git-tracked, so a clone or fork inherits the
   * anchor of the repository it was copied from. The discriminator is whether
   * the anchored project's registered path is *still there*: if it is, this
   * folder is a copy living alongside the original and must get its own
   * identity; only a vanished original means "the same project moved here".
   *
   * Every uncertain case returns `null`, which falls through to registering a
   * brand-new project — today's behavior. Failing that direction costs the user
   * a re-link; the opposite failure would silently hand one project's panels,
   * settings and Assistant history to a different repository.
   */
  private async tryAdoptMovedProject(
    anchorId: string | undefined,
    normalizedPath: string
  ): Promise<Project | null> {
    if (!anchorId || !isValidProjectId(anchorId)) return null;

    const anchored = this.getProjectById(anchorId);
    if (!anchored) return null;

    // Already registered here; the caller's path lookup should have caught it.
    if (normalizeProjectPath(anchored.path) === normalizedPath) return null;

    // Repointing the project a window is currently displaying would strand that
    // view, its workspace host and its PTYs on the old path — the same reason
    // `relocateProject` refuses it. Rebinding a live project needs the
    // quiesce/rebind sequence that doesn't exist yet, so decline the adoption
    // and let this register as an ordinary new project.
    if (anchorId === this.getCurrentProjectId()) return null;

    let originalIsGone: boolean;
    try {
      await fs.access(anchored.path);
      originalIsGone = false;
    } catch (error) {
      // Only a genuinely absent original proves a move. A permissions or I/O
      // failure tells us nothing, so it must not be read as "gone".
      originalIsGone = isEnoent(error);
    }
    if (!originalIsGone) return null;

    const adopted = this.updateProject(anchorId, {
      path: normalizedPath,
      status: "closed",
    });

    this.pruneInRepoRecipeHashes(anchored.path);
    await this.migratePathBearingStateAfterMove(anchorId, anchored.path, normalizedPath);
    await repairLinkedWorktrees(anchored.path, normalizedPath);

    return adopted;
  }

  /**
   * Delete a workspace's state directory without touching the project table.
   *
   * Scratches persist their panel grid under the same `projects/<id>/` layout
   * (#11484) but are removed through `ScratchStore`, which knows nothing about
   * project rows. Without this the state directory would outlive every scratch
   * forever. Best-effort: a failed removal is logged, never thrown, so it can
   * never block a scratch deletion that has already tombstoned its row.
   */
  async removeWorkspaceStateDir(workspaceId: string): Promise<void> {
    const stateDir = getProjectStateDir(this.projectsConfigDir, workspaceId);
    if (!stateDir) return;

    if (existsSync(stateDir)) {
      try {
        await fs.rm(stateDir, { recursive: true, force: true });
      } catch (error) {
        logError(`Failed to remove state directory for ${workspaceId}`, error);
      }
    }
    this.stateManager.invalidateProjectStateCache(workspaceId);
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
      lastCompletionSeenAt: number;
      autoParkedAt: number | null;
      gitBacked: boolean | null;
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
    if (updates.lastCompletionSeenAt !== undefined)
      set.lastCompletionSeenAt = updates.lastCompletionSeenAt;
    if ("autoParkedAt" in updates) set.autoParkedAt = updates.autoParkedAt ?? null;
    // Keyed on presence, not on `!== undefined`: promoting a lightweight
    // workspace clears the flag by passing `undefined`, which an existence-blind
    // check would silently drop and leave the row lightweight forever.
    if ("gitBacked" in updates) set.gitBacked = updates.gitBacked ?? null;

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

    // The SQL orderBy pre-sorts on the raw persisted score, but raw scores are
    // snapshots frozen at different lastAccessedAt dates and must never be
    // compared directly — decay both to one shared `now` first. One `now` for
    // the whole list keeps the comparison internally consistent.
    const projects = rows.map(rowToProject);
    const now = Date.now();
    projects.sort((a, b) => {
      const scoreA = decayFrecencyScore(a.frecencyScore ?? 0, a.lastAccessedAt ?? 0, now);
      const scoreB = decayFrecencyScore(b.frecencyScore ?? 0, b.lastAccessedAt ?? 0, now);
      if (scoreA !== scoreB) return scoreB - scoreA;
      return (b.lastOpened ?? 0) - (a.lastOpened ?? 0);
    });
    return projects;
  }

  async getProjectByPath(projectPath: string): Promise<Project | null> {
    const normalizedPath = path.normalize(projectPath).normalize("NFC");
    const db = getSharedDb();
    const row = db.select().from(projectsTable).where(eq(projectsTable.path, normalizedPath)).get();
    return row ? rowToProject(row) : null;
  }

  /**
   * Resolves the id of the project registered at `projectPath`.
   *
   * Prefer this over `generateProjectId(path)` anywhere the answer is used to
   * look something up: ids survive a folder move, so a relocated project's id
   * no longer equals the hash of its current path and hashing would silently
   * resolve to a project that does not exist (#11282). Falls back to the hash
   * for paths that were never registered, preserving the previous behavior for
   * callers that run before/without a project row.
   */
  resolveProjectIdForPath(projectPath: string): string {
    const normalizedPath = normalizeProjectPath(projectPath);
    const db = getSharedDb();
    const row = db.select().from(projectsTable).where(eq(projectsTable.path, normalizedPath)).get();
    return row?.id ?? generateProjectId(normalizedPath);
  }

  getProjectById(projectId: string): Project | null {
    const db = getSharedDb();
    const row = db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).get();
    return row ? rowToProject(row) : null;
  }

  /**
   * Acknowledgement watermarks for the completed-agent tallies: project id →
   * epoch ms up to which the user has seen that project's completions. Only
   * projects with a stamp appear. Read on every stats compute, so it selects
   * the two columns it needs rather than hydrating full rows.
   */
  getLastCompletionSeenMap(): Map<string, number> {
    const db = getSharedDb();
    const rows = db
      .select({
        id: projectsTable.id,
        lastCompletionSeenAt: projectsTable.lastCompletionSeenAt,
      })
      .from(projectsTable)
      .all();
    const map = new Map<string, number>();
    for (const row of rows) {
      if (typeof row.lastCompletionSeenAt === "number" && row.lastCompletionSeenAt > 0) {
        map.set(row.id, row.lastCompletionSeenAt);
      }
    }
    return map;
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

  /**
   * Rebase the path-bearing Daintree state this phase covers after a moved or
   * renamed project folder leaves it stale (#11282, phase 2). The project id is
   * immutable (phase 1), so id-keyed files — the state dir, settings, secure
   * env, hibernation token — stay reachable; the absolute paths INSIDE them
   * (panel cwds, worktree ids, file-panel paths, MRU entries, captured session
   * dirs, Assistant hibernation cwd) and the path-KEYED window-state store are
   * rewritten here.
   *
   * Deliberately NOT covered yet (tracked as follow-ups under #11282): recipe
   * `worktreeId` bindings, `terminalSettings.defaultWorkingDirectory`, and the
   * worktree-keyed `worktreeIssueMap` / `wslGitByWorktree` / preset maps — each
   * needs its own serialized/global-map rewrite contract, kept out to keep this
   * phase reviewable.
   *
   * Best-effort by design: the DB row has already moved and is authoritative, so
   * a failure in any ancillary surface is logged rather than surfaced as a
   * relocation error (reporting failure after the row moved would misrepresent
   * the real state). Each surface is an independently-settled thunk, so neither a
   * rejection nor a SYNCHRONOUS throw in one can skip the others. Reached for a
   * genuine folder move via any path: closed-project reattach/adoption, or the
   * phase-3 coordinator relocating an OPEN project (which has already quiesced
   * that project's live runtimes before the rewrite runs).
   */
  private async migratePathBearingStateAfterMove(
    projectId: string,
    oldPath: string,
    newPath: string
  ): Promise<void> {
    // Thunks (not eager promises): running each through Promise.resolve().then
    // converts a synchronous throw while BUILDING the promise — e.g. the first
    // `getPendingHelpHibernationStore()` touches `app.getPath` — into a rejected
    // result instead of letting it escape allSettled and reject the relocation.
    const surfaces: Array<() => Promise<unknown>> = [
      () =>
        this.enqueueProjectStateUpdate(projectId, (existing) => {
          if (!existing) return null;
          const rewritten = rewriteProjectStatePaths(existing, oldPath, newPath);
          // Same object reference back ⇒ nothing rebased ⇒ skip the disk write.
          return rewritten === existing ? null : rewritten;
        }),
      async () => {
        // Dynamic import breaks the ProjectStore ⇄ windowState cycle at module
        // eval (windowState imports the projectStore singleton).
        const { rekeyWindowStateForPath } = await import("../windowState.js");
        rekeyWindowStateForPath(oldPath, newPath);
      },
      () => rewriteAgentSessionPathsForProject(projectId, oldPath, newPath),
      () => getPendingHelpHibernationStore().rewriteProjectPath(projectId, oldPath, newPath),
    ];

    const results = await Promise.allSettled(surfaces.map((task) => Promise.resolve().then(task)));
    for (const result of results) {
      if (result.status === "rejected") {
        logError(`Failed to migrate path-bearing state for ${projectId}`, result.reason);
      }
    }
  }

  async relocateProject(projectId: string, newPath: string): Promise<Project> {
    const project = this.getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    // Defense-in-depth: an OPEN project must go through the phase-3
    // quiesce/rebind coordinator (which calls `finalizeRelocatedPath` directly
    // after tearing down its runtimes), never this closed-project reattach path
    // — repointing a live view/host/PTY from here would strand them on the old
    // path (#11282). This single-window pointer only catches the last-focused
    // window; the authoritative open-anywhere fork lives at the IPC boundary
    // (`collectActiveProjectIds`), which routes open projects to the coordinator.
    if (projectId === this.getCurrentProjectId()) {
      throw new Error("Cannot relocate the currently active project");
    }

    // A plain reattach always parks the project as `closed`; the coordinator is
    // the only caller that preserves an open project's live status.
    return this.finalizeRelocatedPath({
      projectId,
      expectedOldPath: project.path,
      newPath,
      status: "closed",
    });
  }

  /**
   * Commit a project's move to a folder that ALREADY exists at `newPath`:
   * canonicalize the new Git root, update the immutable-id row, and rebase every
   * path-bearing surface. The caller owns the filesystem move — a plain reattach
   * via {@link relocateProject} (folder moved externally), or the phase-3
   * relocation coordinator after its own same-volume `fs.rename`.
   *
   * Split out from `relocateProject` so the coordinator can relocate an OPEN
   * project while PRESERVING its `status` (forcing `"closed"` would make the
   * visible project and the DB row disagree); `relocateProject` always closes.
   *
   * `expectedOldPath` guards a concurrent move: if the row no longer points where
   * the caller captured it, the state rebase would run against a stale old root,
   * so bail rather than corrupt state.
   */
  async finalizeRelocatedPath(opts: {
    projectId: string;
    expectedOldPath: string;
    newPath: string;
    status: Project["status"];
  }): Promise<Project> {
    const { projectId, expectedOldPath, newPath, status } = opts;
    const project = this.getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }
    if (normalizeProjectPath(project.path) !== normalizeProjectPath(expectedOldPath)) {
      throw new Error(
        `Project ${projectId} moved concurrently (expected ${expectedOldPath}, found ${project.path})`
      );
    }

    // Normalize to the same NFC spelling `addProject`/`getProjectByPath` use, so
    // a decomposed-Unicode destination on macOS is stored in the form later
    // lookups query by — otherwise `resolveProjectIdForPath` misses it and falls
    // back to the path hash, defeating the immutable id (#11282).
    const canonicalNewPath = normalizeProjectPath(await this.getGitRoot(newPath));

    // A project id is immutable once registered, so reattaching a folder is a
    // path update on the existing row — not a new identity (#11282). Everything
    // keyed by the id (state dir, settings, secure env, panel/terminal ids,
    // Assistant hibernation, session journal) stays reachable with no copying or
    // re-keying of the containers. The absolute paths stored INSIDE that state,
    // plus the path-keyed window-state store, are rebased separately by
    // `migratePathBearingStateAfterMove` below (phase 2).
    const existingAtNewPath = await this.getProjectByPath(canonicalNewPath);
    if (existingAtNewPath && existingAtNewPath.id !== projectId) {
      throw new Error(`A project already exists at that location: ${existingAtNewPath.name}`);
    }

    const oldPath = project.path;
    const updatedProject = this.updateProject(projectId, {
      path: canonicalNewPath,
      status,
    });

    if (normalizeProjectPath(oldPath) !== normalizeProjectPath(canonicalNewPath)) {
      // The old path no longer backs this project — drop its cached recipe
      // hashes so they don't linger.
      this.pruneInRepoRecipeHashes(oldPath);
      await this.migratePathBearingStateAfterMove(projectId, oldPath, canonicalNewPath);
      await repairLinkedWorktrees(oldPath, canonicalNewPath);
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
   * displaying — the one whose departing `lastOpened` gets the MRU bump. Three
   * distinct meanings:
   *   - omitted/`undefined`: infer from the global pointer (single-window and
   *     legacy callers, where the two always agree).
   *   - a string: treat exactly that project as the departing one. Multi-window
   *     callers pass their own view's project; the global pointer names whichever
   *     window switched most recently, which is a different question (#11101).
   *   - `null`: the window had no project displayed (welcome view), so nothing
   *     departed — only the pointer moves and the incoming row activates.
   * `?? this.getCurrentProjectId()` would collapse that `null` back into an
   * unrelated window's project, which is the bug this parameter exists to fix.
   *
   * The durable effect is on `lastOpened` (Alt+Tab MRU order), which nothing
   * else rewrites. The `status` flip is comparatively cosmetic: `getAllProjects`
   * reconciles `status` to a singleton keyed on the global pointer, demoting
   * every other active row, so status converges the same way regardless of what
   * is passed here. Per-window status would require changing that reconciler.
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
    // Debounced on the incoming project's pre-switch lastOpened: bouncing
    // between two projects inside the window keeps re-basing the score to now
    // but adds no increment, so toggling can't out-rank real engagement.
    const newScore = writesSuppressed
      ? null
      : bumpFrecencyScore(
          project.frecencyScore ?? FRECENCY_COLD_START,
          project.lastAccessedAt ?? 0,
          project.lastOpened ?? 0,
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

  /**
   * Arm the operation-scoped state-write rewrite for a relocating project
   * (#11282, phase 3). Until {@link endRelocationRewrite}, any persisted state
   * write for `projectId` is rebased old→new, so a late renderer write with the
   * old root can't undo the folder-move migration. Idempotent per id.
   */
  beginRelocationRewrite(projectId: string, oldPath: string, newPath: string): void {
    this.relocationRewrites.set(projectId, { oldPath, newPath });
  }

  endRelocationRewrite(projectId: string): void {
    this.relocationRewrites.delete(projectId);
  }

  private applyRelocationRewrite(projectId: string, state: ProjectState): ProjectState {
    const rewrite = this.relocationRewrites.get(projectId);
    if (!rewrite) return state;
    return rewriteProjectStatePaths(state, rewrite.oldPath, rewrite.newPath);
  }

  async saveProjectState(projectId: string, state: ProjectState): Promise<void> {
    // Invalidate before the write so any in-flight prefetch sees a version bump
    // and discards its result — otherwise a prefetch resolving after the write
    // could clobber the cache with pre-mutation state.
    invalidatePrefetchCache(projectId);
    return this.stateManager.saveProjectState(
      projectId,
      this.applyRelocationRewrite(projectId, state)
    );
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
        return this.applyRelocationRewrite(projectId, updated);
      }
      return updated;
    });
  }

  async getProjectState(projectId: string): Promise<ProjectState | null> {
    return this.stateManager.getProjectState(projectId);
  }

  /**
   * Count the persisted panels whose stored absolute paths a move from
   * `oldPath` to `newPath` would rewrite (#11282, phase 4). Read-only: reuses
   * the exact production rebase ({@link rewriteProjectStatePaths}) over the
   * loaded state so the "panels with rewritten paths" preview can't drift from
   * what an actual relocation rewrites. Returns 0 when nothing changes.
   */
  async countRebasedPanels(projectId: string, oldPath: string, newPath: string): Promise<number> {
    if (normalizeProjectPath(oldPath) === normalizeProjectPath(newPath)) return 0;
    const state = await this.getProjectState(projectId);
    if (!state) return 0;
    const rewritten = rewriteProjectStatePaths(state, oldPath, newPath);
    // Same reference back ⇒ nothing rebased.
    if (rewritten === state) return 0;
    const before = Array.isArray(state.terminals) ? state.terminals : [];
    const after = Array.isArray(rewritten.terminals) ? rewritten.terminals : [];
    let count = 0;
    for (let i = 0; i < before.length; i++) {
      if (after[i] !== before[i]) count++;
    }
    return count;
  }

  async getProjectStateWithRecovery(projectId: string): Promise<ProjectStateReadResult> {
    return this.stateManager.getProjectStateWithRecovery(projectId);
  }

  wasStateUnreadableThisSession(projectId: string): boolean {
    return this.stateManager.wasStateUnreadableThisSession(projectId);
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
    // Fold the whole read-compute-write into one queued turn so it can't
    // interleave with concurrent add/update/delete on the same project — the
    // reconcile-vs-CRUD TOCTOU a per-method queue would otherwise leave open.
    // The collision list is captured via this closure and returned after the
    // queued promise resolves. The updater calls only unqueued fileStore reads
    // (getRecipes) and in-repo writes (writeInRepoRecipe), never a queued
    // fileStore mutator, so it cannot self-deadlock behind its own turn.
    const collisions: RecipeNameCollision[] = [];
    await this.fileStore.enqueueRecipesUpdate(projectId, async () => {
      // Go through the cache-aware wrapper so the hash map is populated as a
      // side effect — otherwise the first renderer-driven edit after a project
      // load races the unrelated `getInRepoRecipes` call to populate the cache
      // and may see a phantom RECIPE_STALE_CONFLICT. `dirExists` distinguishes
      // an absent `.daintree/recipes/` directory from an authoritatively empty
      // one; `scanComplete` is false when the directory existed but a recipe
      // file couldn't be read (a partial snapshot, e.g. mid-checkout).
      const {
        recipes: inRepoRecipes,
        dirExists,
        scanComplete,
      } = await this.readInRepoRecipesWithMeta(projectPath);
      const fileStoreRecipes = await this.fileStore.getRecipes(projectId);

      // #11347: When the in-repo recipe directory is absent (e.g. the user checked
      // out a branch or commit that predates `.daintree/recipes/`), or the scan of
      // it was incomplete (a file vanished/locked mid-read), we cannot tell a
      // recipe that was deleted from one that merely lives on another checkout.
      // If any project-local recipe is in-repo-scoped, pruning it would destroy
      // local-only env values / usage metadata, and promoting a *sibling*
      // local-only recipe would recreate the directory — making the very next
      // reconcile observe `dirExists: true` and prune the recipe we just
      // protected. So when the view isn't authoritative and there is anything to
      // protect, make no filesystem changes at all and defer reconciliation until
      // the directory is observable again. Projects with only promotable
      // (non-in-repo) recipes still migrate/collision-check as before.
      if ((!dirExists || !scanComplete) && fileStoreRecipes.some((r) => isInRepoRecipeId(r))) {
        return null;
      }

      const inRepoById = new Map(inRepoRecipes.map((r) => [r.id, r]));
      const fileStoreById = new Map(fileStoreRecipes.map((r) => [r.id, r]));

      let promoted = false;
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
        if (!contentDiffers) return null;
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

      return reconciled;
    });
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
