import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import type { TerminalRecipe } from "../../types/index.js";
import { stableInRepoId } from "../../../shared/utils/recipeFilename.js";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => os.tmpdir()),
  },
}));

import { ProjectStore } from "../ProjectStore.js";

function makeRecipe(overrides: Partial<TerminalRecipe> = {}): TerminalRecipe {
  return {
    id: overrides.id ?? "recipe-test-1",
    name: overrides.name ?? "Test Recipe",
    projectId: overrides.projectId ?? "a".repeat(64),
    terminals: overrides.terminals ?? [{ type: "terminal", command: "echo hello" }],
    createdAt: overrides.createdAt ?? Date.now(),
    ...overrides,
  };
}

describe("ProjectStore recipe reconciliation", () => {
  let tmpDir: string;
  let projectPath: string;
  let projectId: string;
  let store: ProjectStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-recipe-recon-"));
    projectPath = path.join(tmpDir, "repo");
    projectId = "a".repeat(64);

    // Override the userData path so ProjectFileStore writes into tmpDir
    // rather than Electron's real userData.
    store = new ProjectStore();
    (store as unknown as { projectsConfigDir: string }).projectsConfigDir = tmpDir;

    await store.initialize();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // --- Helper: write an in-repo recipe directly (simulating normal write path) ---

  async function seedInRepo(recipe: TerminalRecipe) {
    await store.writeInRepoRecipe(projectPath, recipe);
  }

  // --- Helper: seed ProjectFileStore directly ---

  async function seedFileStore(recipes: TerminalRecipe[]) {
    await store.saveRecipes(projectId, recipes);
  }

  // --- Helper: read both stores ---

  async function readFileStore(): Promise<TerminalRecipe[]> {
    return store.getRecipes(projectId);
  }

  async function readInRepo(): Promise<TerminalRecipe[]> {
    return store.readInRepoRecipes(projectPath);
  }

  it("empty stores: reconciliation is a no-op", async () => {
    await store.reconcileProjectRecipes(projectPath, projectId);
    const fs2 = await readFileStore();
    const inr = await readInRepo();
    expect(fs2).toEqual([]);
    expect(inr).toEqual([]);
  });

  it("in-repo-only recipe is backfilled to ProjectFileStore", async () => {
    const recipe = makeRecipe({ id: stableInRepoId("Backfill Test") });
    await seedInRepo(recipe);

    await store.reconcileProjectRecipes(projectPath, projectId);

    const fsRecipes = await readFileStore();
    expect(fsRecipes).toHaveLength(1);
    expect(fsRecipes[0]!.id).toBe(recipe.id);
    expect(fsRecipes[0]!.name).toBe(recipe.name);
  });

  it("ProjectFileStore-only legacy recipe (non-inrepo id) is promoted to .daintree/", async () => {
    const recipe = makeRecipe({
      id: "recipe-legacy-123",
      projectId,
    });
    await seedFileStore([recipe]);

    await store.reconcileProjectRecipes(projectPath, projectId);

    const inr = await readInRepo();
    expect(inr).toHaveLength(1);
    expect(inr[0]!.name).toBe(recipe.name);

    // ProjectFileStore should now match (backfilled)
    const fs2 = await readFileStore();
    expect(fs2).toHaveLength(1);
    expect(fs2[0]!.name).toBe(recipe.name);
  });

  it("ProjectFileStore-only recipe with inrepo- prefix is removed as stale", async () => {
    const staleId = stableInRepoId("Deleted Recipe");
    const staleRecipe = makeRecipe({
      id: staleId,
      name: "Deleted Recipe",
    });
    await seedFileStore([staleRecipe]);

    await store.reconcileProjectRecipes(projectPath, projectId);

    const fs2 = await readFileStore();
    expect(fs2).toEqual([]);
    // No promotion to in-repo
    const inr = await readInRepo();
    expect(inr).toEqual([]);
  });

  it("in-repo recipe overwrites differing ProjectFileStore copy", async () => {
    const id = stableInRepoId("Conflict Recipe");
    const inRepoVersion = makeRecipe({
      id,
      name: "Conflict Recipe",
      terminals: [{ type: "terminal", command: "echo in-repo" }],
    });
    const fileStoreVersion = makeRecipe({
      id,
      name: "Conflict Recipe",
      terminals: [{ type: "terminal", command: "echo stale" }],
    });

    await seedInRepo(inRepoVersion);
    await seedFileStore([fileStoreVersion]);

    await store.reconcileProjectRecipes(projectPath, projectId);

    const fs2 = await readFileStore();
    expect(fs2).toHaveLength(1);
    expect(fs2[0]!.terminals[0]!.command).toBe("echo in-repo");
  });

  it("handles a mix of all cases in one reconciliation pass", async () => {
    // 1. In-repo recipe (should backfill)
    const inRepoOnly = makeRecipe({
      id: stableInRepoId("In Repo Only"),
      name: "In Repo Only",
    });
    await seedInRepo(inRepoOnly);

    // 2. Legacy recipe in ProjectFileStore (should promote)
    const legacy = makeRecipe({
      id: "recipe-legacy-456",
      name: "Legacy Recipe",
      projectId,
    });

    // 3. Stale inrepo- entry in ProjectFileStore (should remove)
    const stale = makeRecipe({
      id: stableInRepoId("Stale Recipe"),
      name: "Stale Recipe",
    });

    // 4. Recipe in both but ProjectFileStore out of date
    const conflictId = stableInRepoId("Conflict");
    const inRepoConflict = makeRecipe({
      id: conflictId,
      name: "Conflict",
      terminals: [{ type: "terminal", command: "echo good" }],
    });
    const fileStoreConflict = makeRecipe({
      id: conflictId,
      name: "Conflict",
      terminals: [{ type: "terminal", command: "echo bad" }],
    });
    await seedInRepo(inRepoConflict);

    await seedFileStore([legacy, stale, fileStoreConflict]);

    await store.reconcileProjectRecipes(projectPath, projectId);

    // After reconciliation:
    // - FileStore should have: inRepoOnly, conflict (good), legacy (promoted)
    // - FileStore should NOT have: stale
    const fs2 = await readFileStore();
    const fsIds = fs2.map((r) => r.id).sort();
    expect(fsIds).toContain(inRepoOnly.id);
    expect(fsIds).toContain(conflictId);
    expect(fsIds).toContain(legacy.id);
    expect(fsIds).not.toContain(stale.id);

    // Conflict should have the in-repo version
    const resolved = fs2.find((r) => r.id === conflictId);
    expect(resolved!.terminals[0]!.command).toBe("echo good");

    // In-repo should have: inRepoOnly, conflict, legacy (promoted)
    const inr = await readInRepo();
    const inrIds = inr.map((r) => r.id).sort();
    expect(inrIds).toContain(inRepoOnly.id);
    expect(inrIds).toContain(conflictId);
    expect(inrIds).toContain(legacy.id);
  });

  it("double reconciliation is idempotent", async () => {
    const inRepoOnly = makeRecipe({
      id: stableInRepoId("Idempotent Test"),
      name: "Idempotent Test",
    });
    const legacy = makeRecipe({
      id: "recipe-legacy-789",
      name: "Legacy Idempotent",
      projectId,
    });

    await seedInRepo(inRepoOnly);
    await seedFileStore([legacy]);

    await store.reconcileProjectRecipes(projectPath, projectId);
    const after1Fs = await readFileStore();
    const after1Inr = await readInRepo();

    await store.reconcileProjectRecipes(projectPath, projectId);
    const after2Fs = await readFileStore();
    const after2Inr = await readInRepo();

    // Second run should produce no changes
    expect(after2Fs.map((r) => r.id).sort()).toEqual(after1Fs.map((r) => r.id).sort());
    expect(after2Inr.map((r) => r.id).sort()).toEqual(after1Inr.map((r) => r.id).sort());
  });

  it("deleted in-repo recipe is cleaned from ProjectFileStore on next reconciliation", async () => {
    // Simulate: recipe was in both stores, then deleted from .daintree/
    // (but ProjectFileStore still has it)
    const recipeId = stableInRepoId("To Delete");
    const recipe = makeRecipe({ id: recipeId, name: "To Delete" });

    // First: seed both stores and reconcile (normal state)
    await seedInRepo(recipe);
    await seedFileStore([recipe]);
    await store.reconcileProjectRecipes(projectPath, projectId);

    // Now delete from in-repo only (simulating crash before ProjectFileStore cleanup)
    await store.deleteInRepoRecipe(projectPath, "To Delete");

    // Reconcile — should detect the stale entry
    await store.reconcileProjectRecipes(projectPath, projectId);

    const fs2 = await readFileStore();
    expect(fs2.find((r) => r.id === recipeId)).toBeUndefined();
  });

  it("reconciliation does not fail when ProjectFileStore JSON is corrupted", async () => {
    // Simulate corrupted recipes.json via direct fs write
    const stateDir = path.join(tmpDir, projectId);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, "recipes.json"), "not valid json {{{", "utf-8");

    const recipe = makeRecipe({ id: stableInRepoId("Survivor") });
    await seedInRepo(recipe);

    // Should not throw — corrupted file is quarantined and we proceed with in-repo data
    await store.reconcileProjectRecipes(projectPath, projectId);

    const fs2 = await readFileStore();
    expect(fs2).toHaveLength(1);
    expect(fs2[0]!.id).toBe(recipe.id);
  });
});
