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
    // rather than Electron's real userData. The inner ProjectFileStore captures
    // its dir at construction, so override it too — otherwise fileStore writes
    // to the shared os.tmpdir()/projects path and leaks recipes across runs.
    store = new ProjectStore();
    (store as unknown as { projectsConfigDir: string }).projectsConfigDir = tmpDir;
    (store as unknown as { fileStore: { projectsConfigDir: string } }).fileStore.projectsConfigDir =
      tmpDir;

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

  it("in-repo mirror survives when .daintree/recipes/ is absent, keeping env/metadata (#11347)", async () => {
    // Model a real checkout: the project root exists but the recipes directory
    // does not (e.g. checked out a branch/commit predating .daintree/recipes/).
    // A missing directory must NOT be read as "the recipe was deleted" — doing
    // so wipes the local-only env values and usage metadata this test guards.
    await fs.mkdir(projectPath, { recursive: true });

    const mirror = makeRecipe({
      id: stableInRepoId("Kept Recipe"),
      name: "Kept Recipe",
      terminals: [{ type: "terminal", command: "echo hi", env: { API_KEY: "secret" } }],
      lastUsedAt: 123,
      usageHistory: [123, 456],
    });
    await seedFileStore([mirror]);

    await store.reconcileProjectRecipes(projectPath, projectId);

    const fs2 = await readFileStore();
    expect(fs2).toHaveLength(1);
    expect(fs2[0]!.id).toBe(mirror.id);
    expect(fs2[0]!.terminals[0]!.env).toEqual({ API_KEY: "secret" });
    expect(fs2[0]!.lastUsedAt).toBe(123);
    expect(fs2[0]!.usageHistory).toEqual([123, 456]);

    // Reconciliation must not create the absent directory as a side effect.
    await expect(fs.access(path.join(projectPath, ".daintree", "recipes"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    // No in-repo recipes are visible while the directory is absent.
    const inr = await readInRepo();
    expect(inr).toEqual([]);
  });

  it("in-repo mirror IS pruned when the directory exists but is empty", async () => {
    // An empty-but-present directory is authoritative (e.g. the recipe file was
    // deleted from .daintree/recipes/ while the dir itself remains). The mirror
    // is genuinely stale here and must still be pruned — only the *missing*
    // directory case is treated as inconclusive.
    const recipesDir = path.join(projectPath, ".daintree", "recipes");
    await fs.mkdir(recipesDir, { recursive: true });

    const stale = makeRecipe({ id: stableInRepoId("Deleted Recipe"), name: "Deleted Recipe" });
    await seedFileStore([stale]);

    await store.reconcileProjectRecipes(projectPath, projectId);

    const fs2 = await readFileStore();
    expect(fs2).toEqual([]);
    const inr = await readInRepo();
    expect(inr).toEqual([]);
  });

  it("missing directory + mirror & legacy recipe: reconcile is a stable no-op, mirror never lost (#11347)", async () => {
    // Without the guard, the parent implementation would promote the legacy
    // recipe (recreating .daintree/recipes/) AND prune the in-repo mirror in the
    // same pass. The guard must instead protect the mirror and skip promotion, so
    // repeated reconciliations leave the store and filesystem byte-for-byte
    // unchanged — no sibling promotion opens a window that a later pass prunes.
    await fs.mkdir(projectPath, { recursive: true });

    const mirror = makeRecipe({
      id: stableInRepoId("Mirror"),
      name: "Mirror",
      terminals: [{ type: "terminal", command: "echo m", env: { TOKEN: "keep-me" } }],
    });
    const legacy = makeRecipe({ id: "recipe-legacy-abc", name: "Legacy", projectId });
    await seedFileStore([mirror, legacy]);
    const before = await readFileStore();

    const collisions1 = await store.reconcileProjectRecipes(projectPath, projectId);
    const after1 = await readFileStore();
    const collisions2 = await store.reconcileProjectRecipes(projectPath, projectId);
    const after2 = await readFileStore();

    // Each pass reports no collisions and leaves the store unchanged.
    expect(collisions1).toEqual([]);
    expect(collisions2).toEqual([]);
    expect(after1).toEqual(before);
    expect(after2).toEqual(before);

    // The mirror's local-only env survived and the directory was never created.
    expect(after2.find((r) => r.id === mirror.id)?.terminals[0]!.env).toEqual({ TOKEN: "keep-me" });
    expect(after2.find((r) => r.id === legacy.id)).toBeDefined();
    await expect(fs.access(path.join(projectPath, ".daintree", "recipes"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reconciliation populates the in-repo hash cache so a follow-up checked write succeeds", async () => {
    // reconcileProjectRecipes now reads through a private helper; verify that
    // helper still repopulates the hash cache the staleness guard depends on.
    const recipe = makeRecipe({ id: stableInRepoId("Recon Cache"), name: "Recon Cache" });
    await seedInRepo(recipe);

    const fresh = new ProjectStore();
    (fresh as unknown as { projectsConfigDir: string }).projectsConfigDir = tmpDir;
    (fresh as unknown as { fileStore: { projectsConfigDir: string } }).fileStore.projectsConfigDir =
      tmpDir;
    await fresh.initialize();

    // Without any prior read, a checked write would conflict (file exists, no
    // cached hash). Reconciling first must populate the cache.
    await fresh.reconcileProjectRecipes(projectPath, projectId);
    await expect(fresh.writeInRepoRecipeChecked(projectPath, recipe)).resolves.toBeUndefined();
  });

  it("opaque-UUID mirror (scope 'inrepo', no prefix) survives an absent directory (#11347)", async () => {
    // Guards the object-based classification: a mirror identified by its scope,
    // not an `inrepo-` id prefix, must also be protected when the directory is
    // gone. A guard narrowed to `id.startsWith("inrepo-")` would drop this.
    await fs.mkdir(projectPath, { recursive: true });

    const mirror = makeRecipe({
      id: "recipe-opaque-uuid",
      name: "Opaque Mirror",
      scope: "inrepo",
      terminals: [{ type: "terminal", command: "echo o", env: { API_KEY: "secret" } }],
      lastUsedAt: 42,
      usageHistory: [42],
    });
    await seedFileStore([mirror]);

    await store.reconcileProjectRecipes(projectPath, projectId);

    const fs2 = await readFileStore();
    expect(fs2).toHaveLength(1);
    expect(fs2[0]!.id).toBe("recipe-opaque-uuid");
    expect(fs2[0]!.terminals[0]!.env).toEqual({ API_KEY: "secret" });
    expect(fs2[0]!.lastUsedAt).toBe(42);
    await expect(fs.access(path.join(projectPath, ".daintree", "recipes"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("normal reconciliation merges local env values into the in-repo recipe instead of blanking them", async () => {
    // The on-disk in-repo copy is redacted (env keys kept, values blanked); the
    // real values live only in the file store. Reconcile with the directory
    // present must merge those values back, not overwrite them with placeholders
    // — the same env-preservation guarantee #11347 protects on the missing path.
    const id = stableInRepoId("Merged");
    const onDisk = makeRecipe({
      id,
      name: "Merged",
      terminals: [{ type: "terminal", command: "echo x", env: { API_KEY: "v", NEW_KEY: "v" } }],
    });
    await seedInRepo(onDisk); // written redacted → on-disk env values become ""

    const local = makeRecipe({
      id,
      name: "Merged",
      terminals: [{ type: "terminal", command: "echo x", env: { API_KEY: "secret" } }],
      lastUsedAt: 999,
      usageHistory: [999],
    });
    await seedFileStore([local]);

    await store.reconcileProjectRecipes(projectPath, projectId);

    const fs2 = await readFileStore();
    expect(fs2).toHaveLength(1);
    // Keys come from the canonical on-disk recipe; values from the local copy.
    expect(fs2[0]!.terminals[0]!.env).toEqual({ API_KEY: "secret", NEW_KEY: "" });
    expect(fs2[0]!.lastUsedAt).toBe(999);
    expect(fs2[0]!.usageHistory).toEqual([999]);
  });

  it("does not prune a mirror when a recipe file can't be read mid-scan (#11347)", async () => {
    // readdir lists the file, but reading it fails (e.g. a checkout unlinks it
    // between readdir and read). The snapshot is non-authoritative, so the mirror
    // must survive rather than be classified stale.
    const recipesDir = path.join(projectPath, ".daintree", "recipes");
    await fs.mkdir(recipesDir, { recursive: true });
    const mirror = makeRecipe({
      id: stableInRepoId("Partial"),
      name: "Partial",
      terminals: [{ type: "terminal", command: "echo p", env: { SECRET: "keep" } }],
    });
    const filePath = path.join(recipesDir, "partial.json");
    await fs.writeFile(filePath, JSON.stringify(mirror), "utf-8");
    await seedFileStore([mirror]);
    await fs.chmod(filePath, 0o000);

    // Some environments (e.g. running as root) ignore the mode; only assert the
    // partial-scan protection when the file is genuinely unreadable here.
    let readable = true;
    try {
      await fs.readFile(filePath, "utf-8");
    } catch {
      readable = false;
    }

    try {
      await store.reconcileProjectRecipes(projectPath, projectId);
      const fs2 = await readFileStore();
      expect(fs2).toHaveLength(1);
      expect(fs2[0]!.id).toBe(mirror.id);
      if (!readable) {
        // Incomplete scan ⇒ the guard preserved the mirror and its env.
        expect(fs2[0]!.terminals[0]!.env).toEqual({ SECRET: "keep" });
      }
    } finally {
      await fs.chmod(filePath, 0o600);
    }
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

  it("returns an empty collision list when nothing collides", async () => {
    const recipe = makeRecipe({ id: "recipe-opaque-uuid", name: "Opaque", scope: "inrepo" });
    await seedInRepo(recipe);

    const collisions = await store.reconcileProjectRecipes(projectPath, projectId);
    expect(collisions).toEqual([]);
  });

  it("tags loaded in-repo recipes with scope 'inrepo' (opaque-id recipe detected without prefix)", async () => {
    const recipe = makeRecipe({ id: "recipe-opaque-uuid", name: "Opaque" });
    await seedInRepo(recipe);

    const inr = await readInRepo();
    expect(inr).toHaveLength(1);
    expect(inr[0]!.scope).toBe("inrepo");

    // Reconcile must treat it as in-repo (case 1/2) via scope, not the id prefix.
    await store.reconcileProjectRecipes(projectPath, projectId);
    const fs2 = await readFileStore();
    expect(fs2.map((r) => r.id)).toContain("recipe-opaque-uuid");
  });

  it("a legacy file with no id gets a deterministic inrepo- id and is not rewritten on read", async () => {
    const recipesDir = path.join(projectPath, ".daintree", "recipes");
    await fs.mkdir(recipesDir, { recursive: true });
    const filePath = path.join(recipesDir, "legacy.json");
    const raw =
      JSON.stringify(
        { name: "Legacy", terminals: [{ type: "terminal", command: "echo hi" }], createdAt: 1 },
        null,
        2
      ) + "\n";
    await fs.writeFile(filePath, raw, "utf-8");

    const first = await store.readInRepoRecipes(projectPath);
    expect(first).toHaveLength(1);
    expect(first[0]!.id).toBe("inrepo-legacy");
    expect(first[0]!.scope).toBe("inrepo");

    // Deterministic across reads, and reading never rewrites the file (a random
    // UUID per read would churn the id and dirty teammates' working trees).
    const second = await store.readInRepoRecipes(projectPath);
    expect(second[0]!.id).toBe("inrepo-legacy");
    expect(await fs.readFile(filePath, "utf-8")).toBe(raw);
  });

  it("deduplicates two in-repo files that share the same opaque id (keeps one, no silent collapse)", async () => {
    const recipesDir = path.join(projectPath, ".daintree", "recipes");
    await fs.mkdir(recipesDir, { recursive: true });
    const mk = (name: string, command: string) =>
      JSON.stringify(
        {
          id: "recipe-dup",
          name,
          scope: "inrepo",
          terminals: [{ type: "terminal", command }],
          createdAt: 1,
        },
        null,
        2
      ) + "\n";
    await fs.writeFile(path.join(recipesDir, "a.json"), mk("A", "echo a"), "utf-8");
    await fs.writeFile(path.join(recipesDir, "b.json"), mk("B", "echo b"), "utf-8");

    const inr = await store.readInRepoRecipes(projectPath);
    // Only one entry survives — the shared id is not allowed to silently
    // overwrite the hash map / collapse during reconciliation.
    expect(inr).toHaveLength(1);
    expect(inr[0]!.id).toBe("recipe-dup");
  });

  it("filename collision: the un-promotable recipe is kept (not dropped) and the collision is returned", async () => {
    // Two distinct project-local recipes whose names slugify to the same
    // filename — only one can own .daintree/recipes/my-recipe.json.
    const a = makeRecipe({ id: "recipe-a", name: "My Recipe", projectId });
    const b = makeRecipe({ id: "recipe-b", name: "my recipe", projectId });
    await seedFileStore([a, b]);

    const collisions = await store.reconcileProjectRecipes(projectPath, projectId);

    expect(collisions).toHaveLength(1);
    expect(collisions[0]!.filename).toBe("my-recipe.json");
    expect([collisions[0]!.keptId, collisions[0]!.droppedId].sort()).toEqual([
      "recipe-a",
      "recipe-b",
    ]);

    // The loser is NOT silently dropped — both survive in ProjectFileStore.
    const fs2 = await readFileStore();
    expect(fs2.map((r) => r.id).sort()).toEqual(["recipe-a", "recipe-b"]);

    // Exactly one was promoted to .daintree/.
    const inr = await readInRepo();
    expect(inr).toHaveLength(1);
  });

  it("serializes reconcile against a concurrent addRecipe (neither clobbers the other)", async () => {
    // Seed one in-repo recipe so reconcile has real write work (backfill it to
    // the ProjectFileStore mirror). reconcile does a full read-compute-write of
    // recipes.json; addRecipe does a read-modify-write of the same file. Run
    // both at once: without per-project serialization, reconcile's full-list
    // write (built from a pre-add snapshot) clobbers the freshly added recipe,
    // or the add clobbers reconcile's backfill — one recipe is always lost.
    const inRepo = makeRecipe({ id: "recipe-inrepo", name: "In Repo", scope: "inrepo" });
    await seedInRepo(inRepo);

    const added = makeRecipe({ id: "recipe-added", name: "Added", projectId });
    await Promise.all([
      store.reconcileProjectRecipes(projectPath, projectId),
      store.addRecipe(projectId, added),
    ]);

    const ids = (await readFileStore()).map((r) => r.id).sort();
    // Both survive regardless of which turn the queue ran first.
    expect(ids).toContain("recipe-added");
    expect(ids).toContain("recipe-inrepo");
  });
});

describe("ProjectStore.writeInRepoRecipeChecked (in-repo recipe staleness guard, #9186)", () => {
  let tmpDir: string;
  let projectPath: string;
  let store: ProjectStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-recipe-check-"));
    projectPath = path.join(tmpDir, "repo");
    store = new ProjectStore();
    (store as unknown as { projectsConfigDir: string }).projectsConfigDir = tmpDir;
    (store as unknown as { fileStore: { projectsConfigDir: string } }).fileStore.projectsConfigDir =
      tmpDir;
    await store.initialize();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("allows the write when the file does not exist (create path)", async () => {
    const recipe = makeRecipe({ id: stableInRepoId("New"), name: "New" });
    await expect(store.writeInRepoRecipeChecked(projectPath, recipe)).resolves.toBeUndefined();
    const onDisk = await fs.readFile(
      path.join(projectPath, ".daintree", "recipes", "new.json"),
      "utf-8"
    );
    expect(JSON.parse(onDisk).name).toBe("New");
  });

  it("allows the write when the cached hash matches on-disk bytes", async () => {
    const recipe = makeRecipe({ id: stableInRepoId("Stable"), name: "Stable" });
    await store.writeInRepoRecipe(projectPath, recipe);

    // Editing through the checked path should succeed because the cached
    // hash matches what's on disk.
    const updated = { ...recipe, terminals: [{ type: "terminal" as const, command: "echo new" }] };
    await expect(store.writeInRepoRecipeChecked(projectPath, updated)).resolves.toBeUndefined();
    const onDisk = await fs.readFile(
      path.join(projectPath, ".daintree", "recipes", "stable.json"),
      "utf-8"
    );
    expect(JSON.parse(onDisk).terminals[0].command).toBe("echo new");
  });

  it("throws RECIPE_STALE_CONFLICT when the file was changed externally", async () => {
    const recipe = makeRecipe({ id: stableInRepoId("Drift"), name: "Drift" });
    await store.writeInRepoRecipe(projectPath, recipe);

    // Simulate an external change (git pull, branch switch, etc.).
    const filePath = path.join(projectPath, ".daintree", "recipes", "drift.json");
    const current = await fs.readFile(filePath, "utf-8");
    await fs.writeFile(filePath, current.replace("Drift", "Drift!!"));

    const updated = { ...recipe, terminals: [{ type: "terminal" as const, command: "mine" }] };
    await expect(store.writeInRepoRecipeChecked(projectPath, updated)).rejects.toMatchObject({
      code: "RECIPE_STALE_CONFLICT",
    });
    // On-disk content must be untouched after a rejected write.
    expect(await fs.readFile(filePath, "utf-8")).toBe(current.replace("Drift", "Drift!!"));
  });

  it("force=true bypasses the staleness check and updates the cached hash", async () => {
    const recipe = makeRecipe({ id: stableInRepoId("Forced"), name: "Forced" });
    await store.writeInRepoRecipe(projectPath, recipe);

    // External edit invalidates the cache.
    const filePath = path.join(projectPath, ".daintree", "recipes", "forced.json");
    const current = await fs.readFile(filePath, "utf-8");
    await fs.writeFile(filePath, current.replace("Forced", "External Edit"));

    const updated = {
      ...recipe,
      terminals: [{ type: "terminal" as const, command: "my own" }],
    };
    await expect(
      store.writeInRepoRecipeChecked(projectPath, updated, { force: true })
    ).resolves.toBeUndefined();
    expect(JSON.parse(await fs.readFile(filePath, "utf-8")).terminals[0].command).toBe("my own");

    // A follow-up checked write should now succeed because force-write
    // refreshed the cache to match the new on-disk bytes.
    const secondUpdate = {
      ...recipe,
      terminals: [{ type: "terminal" as const, command: "follow up" }],
    };
    await expect(
      store.writeInRepoRecipeChecked(projectPath, secondUpdate)
    ).resolves.toBeUndefined();
  });

  it("refuses a rename when the old-name file was externally modified", async () => {
    const recipe = makeRecipe({ id: stableInRepoId("Old Name"), name: "Old Name" });
    await store.writeInRepoRecipe(projectPath, recipe);

    // External edit to the old file between load and rename.
    const oldPath = path.join(projectPath, ".daintree", "recipes", "old-name.json");
    const original = await fs.readFile(oldPath, "utf-8");
    await fs.writeFile(oldPath, original.replace("Old Name", "External Old Name"));

    // Ids are stable across renames now — only the name (and thus filename)
    // changes. The old-name file's hash was cached under this same id.
    const renamed = {
      ...recipe,
      name: "New Name",
    };
    await expect(
      store.writeInRepoRecipeChecked(projectPath, renamed, { previousName: "Old Name" })
    ).rejects.toMatchObject({ code: "RECIPE_STALE_CONFLICT" });

    // New-name file must not be written, old-name file must be untouched.
    const newPath = path.join(projectPath, ".daintree", "recipes", "new-name.json");
    await expect(fs.access(newPath)).rejects.toThrow();
    expect(await fs.readFile(oldPath, "utf-8")).toBe(
      original.replace("Old Name", "External Old Name")
    );
  });

  it("force=true allows a rename even when the old-name file was externally modified", async () => {
    const recipe = makeRecipe({ id: stableInRepoId("Old Forced"), name: "Old Forced" });
    await store.writeInRepoRecipe(projectPath, recipe);
    const oldPath = path.join(projectPath, ".daintree", "recipes", "old-forced.json");
    const original = await fs.readFile(oldPath, "utf-8");
    await fs.writeFile(oldPath, original.replace("Old Forced", "External Edit"));

    const renamed = {
      ...recipe,
      name: "New Forced",
    };
    await expect(
      store.writeInRepoRecipeChecked(projectPath, renamed, {
        previousName: "Old Forced",
        force: true,
      })
    ).resolves.toBeUndefined();
    const newPath = path.join(projectPath, ".daintree", "recipes", "new-forced.json");
    expect(JSON.parse(await fs.readFile(newPath, "utf-8")).name).toBe("New Forced");
  });

  it("rename moves the file but persists the original stable id on disk", async () => {
    const recipe = makeRecipe({ id: "recipe-stable-uuid", name: "Before", scope: "inrepo" });
    await store.writeInRepoRecipe(projectPath, recipe);

    const renamed = { ...recipe, name: "After" };
    await store.writeInRepoRecipeChecked(projectPath, renamed, { previousName: "Before" });
    // The IPC handler deletes the old-name file after a rename; emulate that.
    await store.deleteInRepoRecipe(projectPath, "Before");

    const oldPath = path.join(projectPath, ".daintree", "recipes", "before.json");
    const newPath = path.join(projectPath, ".daintree", "recipes", "after.json");
    await expect(fs.access(oldPath)).rejects.toThrow();
    const onDisk = JSON.parse(await fs.readFile(newPath, "utf-8"));
    expect(onDisk.id).toBe("recipe-stable-uuid");
    expect(onDisk.name).toBe("After");
    expect(onDisk.scope).toBe("inrepo");
  });

  it("readInRepoRecipes populates the hash cache so a follow-up edit can proceed", async () => {
    // Simulate an existing in-repo recipe written by a previous session.
    const recipe = makeRecipe({ id: stableInRepoId("Loaded"), name: "Loaded" });
    await store.writeInRepoRecipe(projectPath, recipe);

    // A fresh store doesn't know about the file yet.
    const fresh = new ProjectStore();
    (fresh as unknown as { projectsConfigDir: string }).projectsConfigDir = tmpDir;
    await fresh.initialize();

    // Without loading first, a write would see the file exists but no cached
    // hash → conflict.
    await expect(fresh.writeInRepoRecipeChecked(projectPath, recipe)).rejects.toMatchObject({
      code: "RECIPE_STALE_CONFLICT",
    });

    // After loading, the cache is populated and the same write succeeds.
    await fresh.readInRepoRecipes(projectPath);
    await expect(fresh.writeInRepoRecipeChecked(projectPath, recipe)).resolves.toBeUndefined();
  });
});
