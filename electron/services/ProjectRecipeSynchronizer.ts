import type { TerminalRecipe, RecipeNameCollision } from "../types/index.js";
import { AppError } from "../utils/errorTypes.js";
import type { ProjectFileStore } from "./ProjectFileStore.js";
import type { ProjectIdentityFiles } from "./ProjectIdentityFiles.js";
import { matchRecipeSteps } from "./recipeStepMatching.js";
import { safeRecipeFilename } from "../utils/recipeFilename.js";
import { describeRecipeForwardIncompat } from "../../shared/utils/recipeCompatibility.js";
import { isInRepoRecipeId } from "../../shared/utils/recipeFilename.js";

/**
 * Synchronization and conflict policy between the canonical `.daintree/recipes/`
 * files ({@link ProjectIdentityFiles}) and the per-project local mirror
 * ({@link ProjectFileStore}), which also holds the local-only env values and
 * usage metadata the in-repo files never carry.
 */
export class ProjectRecipeSynchronizer {
  // SHA-256 of the raw on-disk bytes for each in-repo recipe, captured on
  // every successful read/write. Used by `writeInRepoRecipeChecked` to refuse
  // a write when an external tool (git pull, branch switch, stash pop) changed
  // the file since the renderer loaded it. Keyed by `${projectPath}|${recipeId}`
  // so the same recipe id in two different project clones stays separate.
  private inRepoRecipeHashes = new Map<string, string>();

  constructor(
    private readonly identityFiles: ProjectIdentityFiles,
    private readonly fileStore: Pick<ProjectFileStore, "enqueueRecipesUpdate">
  ) {}

  private hashKey(projectPath: string, recipeId: string): string {
    return `${projectPath}|${recipeId}`;
  }

  // Drop every cached recipe hash for a project path. Called on remove/relocate
  // so stale `${projectPath}|...` entries don't accumulate after the path is
  // gone. Mirrors the prefix-scan in readInRepoRecipes.
  pruneInRepoRecipeHashes(projectPath: string): void {
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
      // Checked before staleness: an unchanged file can still be one this build
      // would strip on write-back, and that loss is invisible to a hash
      // comparison taken from those same unchanged bytes (#12261). A rename
      // reads both destinations, since the old-name file is deleted below.
      await this.assertInRepoRecipesForwardCompatible(projectPath, [
        recipe.name,
        ...(options.previousName ? [options.previousName] : []),
      ]);
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

  /**
   * Refuses a write into `.daintree/recipes/` that would delete content this
   * build cannot represent (#12261).
   *
   * `.daintree/recipes/*.json` is git-tracked and shared between machines on
   * different builds. This build rebuilds every recipe from an explicit field
   * list and drops terminals whose `type` it doesn't know, then serializes that
   * reduced object straight back over the file — so without this guard an older
   * build silently commits away whatever a newer one wrote. The staleness guard
   * cannot catch it: the file hasn't changed, so its hash still matches.
   *
   * Each destination is read fresh rather than looked up in
   * `inRepoRecipeHashes`. The files most at risk are the ones the reader
   * dropped entirely, which never get a cache entry at all — a cold cache must
   * never read as "safe to overwrite".
   *
   * Names are deduplicated by resolved filename so a rename whose two names
   * collapse to one file is reported once.
   *
   * Public so the batch writers (enable-in-repo-settings, recipe sync) can
   * pre-flight every destination before their first write and fail the whole
   * operation, rather than stopping halfway with some files already rewritten.
   */
  async assertInRepoRecipesForwardCompatible(
    projectPath: string,
    recipeNames: string[]
  ): Promise<void> {
    const seen = new Set<string>();
    const affected: string[] = [];
    for (const name of recipeNames) {
      const filename = safeRecipeFilename(name);
      if (seen.has(filename)) continue;
      seen.add(filename);
      const loss = await this.identityFiles.inspectInRepoRecipeForwardCompat(projectPath, name);
      if (loss) affected.push(`${filename} — ${describeRecipeForwardIncompat(loss)}`);
    }
    if (affected.length === 0) return;

    // The detail has to travel in `userMessage`: `context` never crosses the
    // contextBridge (the preload reconstructs only code/message/userMessage),
    // and packaged builds strip it outright.
    const detail = affected.join("\n");
    throw new AppError({
      code: "RECIPE_FORWARD_COMPAT_CONFLICT",
      message: `Saving would delete unsupported content from ${affected.length} in-repo recipe file(s)`,
      userMessage: detail,
      context: { projectPath, affected },
    });
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
    // queued promise resolves. The updater reads the fileStore only through the
    // unqueued reader the turn hands it and writes only in-repo files
    // (writeInRepoRecipe), never a queued fileStore method, so it cannot
    // self-deadlock behind its own turn.
    const collisions: RecipeNameCollision[] = [];
    await this.fileStore.enqueueRecipesUpdate(projectId, async (readFileStoreRecipes) => {
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
      const fileStoreRecipes = await readFileStoreRecipes();

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

        // `seenFilenames` only knows about recipes the reader returned, so a
        // file it dropped whole — every terminal of a type this build doesn't
        // know — records no owner and would be promoted straight over (#12261).
        // That is the worst case of all: it needs no user action, since an
        // ordinary project load runs reconciliation. Unlike the write paths this
        // one cannot throw, so keep the local recipe in the mirror and leave the
        // file alone; both survive, and neither is silently dropped.
        const loss = await this.identityFiles.inspectInRepoRecipeForwardCompat(
          projectPath,
          recipe.name
        );
        if (loss) {
          console.warn(
            `[ProjectStore] Not promoting recipe "${recipe.name}" — ${filename} holds content ` +
              `this build does not support: ${describeRecipeForwardIncompat(loss)}`
          );
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

        const localSteps = matchRecipeSteps(recipe.terminals, existing.terminals);
        const mergedTerminals = recipe.terminals.map((inRepoT, i) => {
          const existingT = localSteps[i];
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
}
