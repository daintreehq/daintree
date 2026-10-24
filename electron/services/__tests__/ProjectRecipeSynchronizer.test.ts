import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import type { TerminalRecipe } from "../../types/index.js";
import { ProjectIdentityFiles } from "../ProjectIdentityFiles.js";
import { ProjectRecipeSynchronizer } from "../ProjectRecipeSynchronizer.js";

function makeRecipe(overrides: Partial<TerminalRecipe> = {}): TerminalRecipe {
  return {
    id: "recipe-sync-1",
    name: "Sync Recipe",
    projectId: "a".repeat(64),
    terminals: [{ type: "terminal", command: "echo hello" }],
    createdAt: 1,
    ...overrides,
  };
}

describe("ProjectRecipeSynchronizer", () => {
  let tmpDir: string;
  let projectPath: string;
  let siblingPath: string;
  let mirror: TerminalRecipe[];
  let enqueueRecipesUpdate: ReturnType<typeof vi.fn>;
  let sync: ProjectRecipeSynchronizer;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-recipe-sync-"));
    projectPath = path.join(tmpDir, "repo");
    // Shares `projectPath` as a string prefix, so a prune that matched on the
    // bare path instead of `${path}|` would wrongly drop this project's hashes.
    siblingPath = path.join(tmpDir, "repo-clone");
    mirror = [];
    enqueueRecipesUpdate = vi.fn(
      async (
        _projectId: string,
        updater: (read: () => Promise<TerminalRecipe[]>) => Promise<TerminalRecipe[] | null>
      ) => {
        const next = await updater(async () => mirror);
        if (next) mirror = next;
      }
    );
    sync = new ProjectRecipeSynchronizer(new ProjectIdentityFiles(), { enqueueRecipesUpdate });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("forgets a pruned path's load-time hashes, leaving other paths intact", async () => {
    const recipe = makeRecipe();
    await sync.writeInRepoRecipe(projectPath, recipe);
    await sync.writeInRepoRecipe(siblingPath, recipe);

    sync.pruneInRepoRecipeHashes(projectPath);

    await expect(sync.writeInRepoRecipeChecked(projectPath, recipe)).rejects.toMatchObject({
      code: "RECIPE_STALE_CONFLICT",
    });
    await expect(sync.writeInRepoRecipeChecked(siblingPath, recipe)).resolves.toBeUndefined();
  });

  it("re-reading a pruned path restores its hashes", async () => {
    const recipe = makeRecipe();
    await sync.writeInRepoRecipe(projectPath, recipe);
    sync.pruneInRepoRecipeHashes(projectPath);

    await sync.readInRepoRecipes(projectPath);

    await expect(sync.writeInRepoRecipeChecked(projectPath, recipe)).resolves.toBeUndefined();
  });

  it("reconciles inside one queued turn of the injected file store", async () => {
    const local = makeRecipe({ id: "local-only", name: "Local Only" });
    mirror = [local];

    const collisions = await sync.reconcileProjectRecipes(projectPath, "a".repeat(64));

    expect(collisions).toEqual([]);
    expect(enqueueRecipesUpdate).toHaveBeenCalledTimes(1);
    expect(enqueueRecipesUpdate.mock.calls[0][0]).toBe("a".repeat(64));
    const inRepo = await sync.readInRepoRecipes(projectPath);
    expect(inRepo.map((r) => r.name)).toEqual(["Local Only"]);
    expect(mirror.map((r) => r.id)).toEqual(inRepo.map((r) => r.id));
  });
});
