import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createHash } from "crypto";
import type {
  ProjectSettings,
  ProjectTerminalSettings,
  TerminalRecipe,
} from "../../types/index.js";
import {
  PROJECT_SETTINGS_SHAREABILITY,
  PROJECT_TERMINAL_SETTINGS_SHAREABILITY,
} from "../../../shared/types/project.js";
import {
  ProjectIdentityFiles,
  buildInRepoRecipePayloadString,
  hashRecipePayload,
} from "../ProjectIdentityFiles.js";

const DAINTREE_PROJECT_JSON = ".daintree/project.json";
const DAINTREE_SETTINGS_JSON = ".daintree/settings.json";
const DAINTREE_RECIPES_DIR = ".daintree/recipes";

function makeSettings(overrides: Partial<ProjectSettings> = {}): ProjectSettings {
  return { runCommands: [], ...overrides };
}

describe("writeInRepoProjectIdentity", () => {
  let tmpDir: string;
  let identityFiles: ProjectIdentityFiles;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-write-test-"));
    identityFiles = new ProjectIdentityFiles();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates .daintree/ directory and project.json when absent", async () => {
    await identityFiles.writeInRepoProjectIdentity(tmpDir, {
      name: "My App",
      emoji: "🚀",
      color: "blue",
    });

    const filePath = path.join(tmpDir, DAINTREE_PROJECT_JSON);
    const content = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(content).toEqual({ version: 1, name: "My App", emoji: "🚀", color: "blue" });
  });

  it("writes version: 1 in all cases", async () => {
    await identityFiles.writeInRepoProjectIdentity(tmpDir, {});
    const content = JSON.parse(
      await fs.readFile(path.join(tmpDir, DAINTREE_PROJECT_JSON), "utf-8")
    );
    expect(content.version).toBe(1);
  });

  it("omits undefined fields from output", async () => {
    await identityFiles.writeInRepoProjectIdentity(tmpDir, { name: "Only Name" });
    const content = JSON.parse(
      await fs.readFile(path.join(tmpDir, DAINTREE_PROJECT_JSON), "utf-8")
    );
    expect(content).toEqual({ version: 1, name: "Only Name" });
    expect(content).not.toHaveProperty("emoji");
    expect(content).not.toHaveProperty("color");
  });

  it("overwrites existing file with new values", async () => {
    await identityFiles.writeInRepoProjectIdentity(tmpDir, { name: "Old Name", emoji: "🌲" });
    await identityFiles.writeInRepoProjectIdentity(tmpDir, { name: "New Name", emoji: "🚀" });
    const content = JSON.parse(
      await fs.readFile(path.join(tmpDir, DAINTREE_PROJECT_JSON), "utf-8")
    );
    expect(content.name).toBe("New Name");
    expect(content.emoji).toBe("🚀");
  });

  it("is atomic: no .tmp files left after write", async () => {
    await identityFiles.writeInRepoProjectIdentity(tmpDir, { name: "Test" });
    const daintreeDir = path.join(tmpDir, ".daintree");
    const files = await fs.readdir(daintreeDir);
    const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });

  it("writes pretty-printed JSON (2-space indent)", async () => {
    await identityFiles.writeInRepoProjectIdentity(tmpDir, { name: "Formatted" });
    const raw = await fs.readFile(path.join(tmpDir, DAINTREE_PROJECT_JSON), "utf-8");
    expect(raw).toContain("\n");
    expect(raw).toContain("  ");
  });

  it("works when .daintree/ already exists", async () => {
    await fs.mkdir(path.join(tmpDir, ".daintree"), { recursive: true });
    await identityFiles.writeInRepoProjectIdentity(tmpDir, { name: "Existing Dir" });
    const content = JSON.parse(
      await fs.readFile(path.join(tmpDir, DAINTREE_PROJECT_JSON), "utf-8")
    );
    expect(content.name).toBe("Existing Dir");
  });
});

describe("writeInRepoSettings", () => {
  let tmpDir: string;
  let identityFiles: ProjectIdentityFiles;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-settings-test-"));
    identityFiles = new ProjectIdentityFiles();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates .daintree/ directory and settings.json when absent", async () => {
    await identityFiles.writeInRepoSettings(
      tmpDir,
      makeSettings({
        runCommands: [{ id: "dev", name: "Dev Server", command: "npm run dev" }],
        devServerCommand: "npm run dev",
        excludedPaths: ["node_modules"],
      })
    );

    const filePath = path.join(tmpDir, DAINTREE_SETTINGS_JSON);
    const content = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(content.version).toBe(1);
    expect(content.runCommands).toHaveLength(1);
    expect(content.devServerCommand).toBe("npm run dev");
    expect(content.excludedPaths).toEqual(["node_modules"]);
  });

  // Table-driven coverage: every non-shareable field defined in
  // PROJECT_SETTINGS_SHAREABILITY must be absent from the on-disk JSON, and
  // every shareable field must appear when set. The table is the single
  // source of truth — adding a new field here without classifying it is a
  // compile-time error, and this loop guarantees the write boundary honors
  // the classification at runtime.
  const NON_SHAREABLE_FIELDS = (
    Object.keys(PROJECT_SETTINGS_SHAREABILITY) as Array<keyof ProjectSettings>
  ).filter((k) => PROJECT_SETTINGS_SHAREABILITY[k] !== "shareable");

  // Per-field sample values that are non-empty (so omission isn't an artifact
  // of the writer's empty-array / empty-string skip rule). Only non-shareable
  // fields need samples here.
  const NON_SHAREABLE_SAMPLES: { [K in keyof ProjectSettings]?: ProjectSettings[K] } = {
    environmentVariables: { API_KEY: "secret123" },
    secureEnvironmentVariables: ["DB_PASS"],
    insecureEnvironmentVariables: ["PLAIN_KEY"],
    unresolvedSecureEnvironmentVariables: ["LOCKED_KEY"],
    projectIconSvg: "<svg>...</svg>",
    defaultWorktreeRecipeId: "recipe-1",
    devServerDismissed: true,
    devServerAutoDetected: true,
    cloudSyncWarningDismissed: true,
    commandOverrides: [{ commandId: "git.push", disabled: true }],
    gitInitDefaults: { createInitialCommit: false },
    preferredEditor: { id: "vscode" },
    preferredImageViewer: { mode: "os" },
    branchPrefixMode: "custom",
    branchPrefixCustom: "feature/",
    forgeRemote: "upstream",
    githubRemote: "upstream",
    forgeProviderOverride: "github-com",
    fleetSavedScopes: [
      { kind: "predicate", id: "s1", name: "All", scope: "all", stateFilter: "all", createdAt: 1 },
    ],
    notificationOverrides: { soundEnabled: false },
    resourceEnvironment: { provision: ["echo provision"] },
    resourceEnvironments: { default: { provision: ["echo provision"] } },
    activeResourceEnvironment: "default",
    defaultWorktreeMode: "local",
    browserAllowedHosts: ["example.com"],
    daintreeMcpTier: "workbench",
    exposeDaintreeMcpToAgents: true,
  };

  it.each(NON_SHAREABLE_FIELDS)(
    "omits non-shareable field %s from .daintree/settings.json",
    async (field) => {
      const sample = NON_SHAREABLE_SAMPLES[field];
      expect(
        sample,
        `missing sample value for non-shareable field ${field} — update NON_SHAREABLE_SAMPLES`
      ).not.toBeUndefined();
      await identityFiles.writeInRepoSettings(
        tmpDir,
        makeSettings({ [field]: sample } as Partial<ProjectSettings>)
      );
      const content = JSON.parse(
        await fs.readFile(path.join(tmpDir, DAINTREE_SETTINGS_JSON), "utf-8")
      );
      expect(content).not.toHaveProperty(field);
    }
  );

  it("includes copyTreeSettings when present", async () => {
    await identityFiles.writeInRepoSettings(
      tmpDir,
      makeSettings({ copyTreeSettings: { maxFileSize: 50000 } })
    );
    const content = JSON.parse(
      await fs.readFile(path.join(tmpDir, DAINTREE_SETTINGS_JSON), "utf-8")
    );
    expect(content.copyTreeSettings).toEqual({ maxFileSize: 50000 });
  });

  it("is atomic: no .tmp files left after write", async () => {
    await identityFiles.writeInRepoSettings(tmpDir, makeSettings());
    const daintreeDir = path.join(tmpDir, ".daintree");
    const files = await fs.readdir(daintreeDir);
    const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });

  it("writes pretty-printed JSON (2-space indent)", async () => {
    await identityFiles.writeInRepoSettings(
      tmpDir,
      makeSettings({
        runCommands: [{ id: "build", name: "Build", command: "npm run build" }],
      })
    );
    const raw = await fs.readFile(path.join(tmpDir, DAINTREE_SETTINGS_JSON), "utf-8");
    expect(raw).toContain("\n");
    expect(raw).toContain("  ");
  });

  it("omits runCommands from output when empty", async () => {
    await identityFiles.writeInRepoSettings(tmpDir, makeSettings());
    const content = JSON.parse(
      await fs.readFile(path.join(tmpDir, DAINTREE_SETTINGS_JSON), "utf-8")
    );
    expect(content).not.toHaveProperty("runCommands");
  });

  // Mirror of the omission table: every shareable top-level field appears in
  // the on-disk JSON when populated. `terminalSettings` is exercised via the
  // dedicated nested test below.
  const SHAREABLE_TOP_LEVEL_FIELDS = (
    Object.keys(PROJECT_SETTINGS_SHAREABILITY) as Array<keyof ProjectSettings>
  ).filter((k) => PROJECT_SETTINGS_SHAREABILITY[k] === "shareable" && k !== "terminalSettings");

  const SHAREABLE_SAMPLES: { [K in keyof ProjectSettings]?: ProjectSettings[K] } = {
    runCommands: [{ id: "dev", name: "Dev", command: "npm run dev" }],
    excludedPaths: ["node_modules"],
    devServerCommand: "npm run dev",
    devServerLoadTimeout: 60,
    turbopackEnabled: true,
    copyTreeSettings: { maxFileSize: 50000 },
    worktreePathPattern: "../{name}",
  };

  it.each(SHAREABLE_TOP_LEVEL_FIELDS)(
    "includes shareable field %s in .daintree/settings.json",
    async (field) => {
      const sample = SHAREABLE_SAMPLES[field];
      expect(
        sample,
        `missing sample value for shareable field ${field} — update SHAREABLE_SAMPLES`
      ).not.toBeUndefined();
      await identityFiles.writeInRepoSettings(
        tmpDir,
        makeSettings({ [field]: sample } as Partial<ProjectSettings>)
      );
      const content = JSON.parse(
        await fs.readFile(path.join(tmpDir, DAINTREE_SETTINGS_JSON), "utf-8")
      );
      expect(content[field]).toEqual(sample);
    }
  );

  describe("terminalSettings nested shareability", () => {
    const TERMINAL_NON_SHAREABLE: Array<keyof ProjectTerminalSettings> = (
      Object.keys(PROJECT_TERMINAL_SETTINGS_SHAREABILITY) as Array<keyof ProjectTerminalSettings>
    ).filter((k) => PROJECT_TERMINAL_SETTINGS_SHAREABILITY[k] !== "shareable");

    const TERMINAL_SHAREABLE: Array<keyof ProjectTerminalSettings> = (
      Object.keys(PROJECT_TERMINAL_SETTINGS_SHAREABILITY) as Array<keyof ProjectTerminalSettings>
    ).filter((k) => PROJECT_TERMINAL_SETTINGS_SHAREABILITY[k] === "shareable");

    const TERMINAL_NON_SHAREABLE_SAMPLES: {
      [K in keyof ProjectTerminalSettings]?: ProjectTerminalSettings[K];
    } = {
      shell: "/bin/zsh",
      defaultWorkingDirectory: "/Users/me/project",
    };

    const TERMINAL_SHAREABLE_SAMPLES: {
      [K in keyof ProjectTerminalSettings]?: ProjectTerminalSettings[K];
    } = {
      shellArgs: ["-l"],
      scrollbackLines: 5000,
    };

    it.each(TERMINAL_NON_SHAREABLE)("omits non-shareable terminal sub-field %s", async (field) => {
      const sample = TERMINAL_NON_SHAREABLE_SAMPLES[field];
      expect(
        sample,
        `missing sample value for non-shareable terminal field ${field}`
      ).not.toBeUndefined();
      await identityFiles.writeInRepoSettings(
        tmpDir,
        makeSettings({
          terminalSettings: { [field]: sample } as ProjectTerminalSettings,
        })
      );
      const content = JSON.parse(
        await fs.readFile(path.join(tmpDir, DAINTREE_SETTINGS_JSON), "utf-8")
      );
      // The terminalSettings block must be absent if its only field was non-shareable.
      expect(content).not.toHaveProperty("terminalSettings");
    });

    it.each(TERMINAL_SHAREABLE)("includes shareable terminal sub-field %s", async (field) => {
      const sample = TERMINAL_SHAREABLE_SAMPLES[field];
      expect(
        sample,
        `missing sample value for shareable terminal field ${field}`
      ).not.toBeUndefined();
      await identityFiles.writeInRepoSettings(
        tmpDir,
        makeSettings({
          terminalSettings: { [field]: sample } as ProjectTerminalSettings,
        })
      );
      const content = JSON.parse(
        await fs.readFile(path.join(tmpDir, DAINTREE_SETTINGS_JSON), "utf-8")
      );
      expect(content.terminalSettings?.[field]).toEqual(sample);
    });

    it("strips shell from a mixed terminalSettings while keeping shareable siblings", async () => {
      await identityFiles.writeInRepoSettings(
        tmpDir,
        makeSettings({
          terminalSettings: {
            shell: "/bin/zsh",
            shellArgs: ["-l"],
            scrollbackLines: 2000,
          },
        })
      );
      const content = JSON.parse(
        await fs.readFile(path.join(tmpDir, DAINTREE_SETTINGS_JSON), "utf-8")
      );
      expect(content.terminalSettings).toEqual({ shellArgs: ["-l"], scrollbackLines: 2000 });
      expect(content.terminalSettings).not.toHaveProperty("shell");
    });

    it("preserves scrollbackLines: 0 (defined but falsy)", async () => {
      await identityFiles.writeInRepoSettings(
        tmpDir,
        makeSettings({ terminalSettings: { scrollbackLines: 0 } })
      );
      const content = JSON.parse(
        await fs.readFile(path.join(tmpDir, DAINTREE_SETTINGS_JSON), "utf-8")
      );
      expect(content.terminalSettings).toEqual({ scrollbackLines: 0 });
    });
  });

  it("preserves turbopackEnabled: false (defined but falsy)", async () => {
    await identityFiles.writeInRepoSettings(tmpDir, makeSettings({ turbopackEnabled: false }));
    const content = JSON.parse(
      await fs.readFile(path.join(tmpDir, DAINTREE_SETTINGS_JSON), "utf-8")
    );
    expect(content.turbopackEnabled).toBe(false);
  });

  it("omits null values from output (e.g. when renderer sends 'clear this field')", async () => {
    // The renderer occasionally sends `null` to clear an optional field. The
    // type declares `string` for most of these, but the IPC handler calls the
    // writer with raw incoming settings before sanitization runs. Writing
    // `null` produces a spurious git diff that means nothing to teammates.
    await identityFiles.writeInRepoSettings(
      tmpDir,
      makeSettings({
        devServerCommand: null as unknown as string,
        worktreePathPattern: null as unknown as string,
      })
    );
    const content = JSON.parse(
      await fs.readFile(path.join(tmpDir, DAINTREE_SETTINGS_JSON), "utf-8")
    );
    expect(content).not.toHaveProperty("devServerCommand");
    expect(content).not.toHaveProperty("worktreePathPattern");
  });

  it("refuses to write when .daintree/ is a symlink", async () => {
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-symlink-target-"));
    try {
      await fs.symlink(target, path.join(tmpDir, ".daintree"));
      await expect(identityFiles.writeInRepoSettings(tmpDir, makeSettings())).rejects.toThrow(
        /symbolic link/
      );
    } finally {
      await fs.rm(target, { recursive: true, force: true });
    }
  });
});

function makeRecipe(overrides: Partial<TerminalRecipe> = {}): TerminalRecipe {
  return {
    id: "recipe-test-1",
    name: "Test Recipe",
    projectId: "proj-1",
    terminals: [{ type: "terminal", title: "Shell" }],
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("writeInRepoRecipe", () => {
  let tmpDir: string;
  let identityFiles: ProjectIdentityFiles;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-recipe-write-test-"));
    identityFiles = new ProjectIdentityFiles();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates .daintree/recipes/ directory and writes recipe file", async () => {
    await identityFiles.writeInRepoRecipe(tmpDir, makeRecipe({ name: "My Recipe" }));
    const filePath = path.join(tmpDir, DAINTREE_RECIPES_DIR, "my-recipe.json");
    const content = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(content.name).toBe("My Recipe");
    expect(content.terminals).toHaveLength(1);
  });

  it("strips projectId and worktreeId from output", async () => {
    await identityFiles.writeInRepoRecipe(
      tmpDir,
      makeRecipe({ projectId: "proj-1", worktreeId: "wt-1" })
    );
    const filePath = path.join(tmpDir, DAINTREE_RECIPES_DIR, "test-recipe.json");
    const content = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(content).not.toHaveProperty("projectId");
    expect(content).not.toHaveProperty("worktreeId");
  });

  it("redacts env values (keeps keys)", async () => {
    await identityFiles.writeInRepoRecipe(
      tmpDir,
      makeRecipe({
        terminals: [{ type: "terminal", env: { API_KEY: "secret123", DB_HOST: "localhost" } }],
      })
    );
    const filePath = path.join(tmpDir, DAINTREE_RECIPES_DIR, "test-recipe.json");
    const content = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(content.terminals[0].env).toEqual({ API_KEY: "", DB_HOST: "" });
  });

  it("writes pretty-printed JSON", async () => {
    await identityFiles.writeInRepoRecipe(tmpDir, makeRecipe());
    const filePath = path.join(tmpDir, DAINTREE_RECIPES_DIR, "test-recipe.json");
    const raw = await fs.readFile(filePath, "utf-8");
    expect(raw).toContain("\n");
    expect(raw).toContain("  ");
  });

  it("overwrites existing recipe file", async () => {
    await identityFiles.writeInRepoRecipe(tmpDir, makeRecipe({ name: "Same Name" }));
    await identityFiles.writeInRepoRecipe(
      tmpDir,
      makeRecipe({ name: "Same Name", id: "recipe-2" })
    );
    const filePath = path.join(tmpDir, DAINTREE_RECIPES_DIR, "same-name.json");
    const content = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(content.id).toBe("recipe-2");
  });

  it("writeInRepoRecipe returns the SHA-256 hash of the bytes written", async () => {
    const recipe = makeRecipe({ name: "Hashed" });
    const returned = await identityFiles.writeInRepoRecipe(tmpDir, recipe);
    const onDisk = await fs.readFile(
      path.join(tmpDir, DAINTREE_RECIPES_DIR, "hashed.json"),
      "utf-8"
    );
    expect(returned).toBe(createHash("sha256").update(onDisk, "utf-8").digest("hex"));
  });

  it("buildInRepoRecipePayloadString matches the bytes writeInRepoRecipe persists", async () => {
    const recipe = makeRecipe({
      name: "Payload Match",
      terminals: [{ type: "terminal", env: { SECRET: "shh", OTHER: "x" } }],
    });
    await identityFiles.writeInRepoRecipe(tmpDir, recipe);
    const onDisk = await fs.readFile(
      path.join(tmpDir, DAINTREE_RECIPES_DIR, "payload-match.json"),
      "utf-8"
    );
    expect(buildInRepoRecipePayloadString(recipe)).toBe(onDisk);
    // Env values redacted in the payload string the writer uses internally.
    expect(buildInRepoRecipePayloadString(recipe)).toContain('"SECRET": ""');
  });

  it("buildInRepoRecipePayloadString strips projectId and worktreeId", () => {
    const recipe = makeRecipe({ projectId: "proj-1", worktreeId: "wt-1" });
    const payload = buildInRepoRecipePayloadString(recipe);
    expect(payload).not.toContain("proj-1");
    expect(payload).not.toContain("wt-1");
  });

  it("hashRecipePayload is deterministic and produces a 64-char hex digest", () => {
    const a = hashRecipePayload("hello");
    const b = hashRecipePayload("hello");
    const c = hashRecipePayload("hello!");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("getInRepoRecipeFileHash", () => {
  let tmpDir: string;
  let identityFiles: ProjectIdentityFiles;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-recipe-hash-test-"));
    identityFiles = new ProjectIdentityFiles();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null when the recipe file does not exist", async () => {
    expect(await identityFiles.getInRepoRecipeFileHash(tmpDir, "Missing Recipe")).toBeNull();
  });

  it("returns the SHA-256 hash of the exact on-disk bytes", async () => {
    await identityFiles.writeInRepoRecipe(tmpDir, makeRecipe({ name: "Hashed Recipe" }));
    const onDisk = await fs.readFile(
      path.join(tmpDir, DAINTREE_RECIPES_DIR, "hashed-recipe.json"),
      "utf-8"
    );
    expect(await identityFiles.getInRepoRecipeFileHash(tmpDir, "Hashed Recipe")).toBe(
      createHash("sha256").update(onDisk, "utf-8").digest("hex")
    );
  });

  it("hash changes when the file is externally edited", async () => {
    await identityFiles.writeInRepoRecipe(tmpDir, makeRecipe({ name: "Drift Recipe" }));
    const before = await identityFiles.getInRepoRecipeFileHash(tmpDir, "Drift Recipe");
    const filePath = path.join(tmpDir, DAINTREE_RECIPES_DIR, "drift-recipe.json");
    const current = await fs.readFile(filePath, "utf-8");
    await fs.writeFile(filePath, current.replace("Drift Recipe", "Drift Recipe Externally Edited"));
    const after = await identityFiles.getInRepoRecipeFileHash(tmpDir, "Drift Recipe");
    expect(after).not.toBe(before);
  });
});

describe("readInRepoRecipesWithHashes", () => {
  let tmpDir: string;
  let identityFiles: ProjectIdentityFiles;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-recipe-readhash-test-"));
    identityFiles = new ProjectIdentityFiles();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns hash matching the file bytes for each loaded recipe", async () => {
    await identityFiles.writeInRepoRecipe(tmpDir, makeRecipe({ id: "r1", name: "First" }));
    await identityFiles.writeInRepoRecipe(tmpDir, makeRecipe({ id: "r2", name: "Second" }));

    const { recipes, hashes, dirExists, scanComplete } =
      await identityFiles.readInRepoRecipesWithHashes(tmpDir);
    expect(recipes).toHaveLength(2);
    expect(hashes.size).toBe(2);
    expect(dirExists).toBe(true);
    expect(scanComplete).toBe(true);
    for (const recipe of recipes) {
      const filename = recipe.name === "First" ? "first.json" : "second.json";
      const onDisk = await fs.readFile(path.join(tmpDir, DAINTREE_RECIPES_DIR, filename), "utf-8");
      const expected = createHash("sha256").update(onDisk, "utf-8").digest("hex");
      expect(hashes.get(recipe.id)).toBe(expected);
    }
  });

  it("returns empty recipes and hashes and dirExists=false when the directory is missing", async () => {
    const { recipes, hashes, dirExists, scanComplete } =
      await identityFiles.readInRepoRecipesWithHashes(tmpDir);
    expect(recipes).toEqual([]);
    expect(hashes.size).toBe(0);
    expect(dirExists).toBe(false);
    expect(scanComplete).toBe(true);
  });

  it("returns dirExists=true and scanComplete=true for an existing but empty recipes directory", async () => {
    await fs.mkdir(path.join(tmpDir, DAINTREE_RECIPES_DIR), { recursive: true });
    const { recipes, hashes, dirExists, scanComplete } =
      await identityFiles.readInRepoRecipesWithHashes(tmpDir);
    expect(recipes).toEqual([]);
    expect(hashes.size).toBe(0);
    expect(dirExists).toBe(true);
    expect(scanComplete).toBe(true);
  });

  it("reports scanComplete=false when a listed recipe file cannot be read", async () => {
    const recipesDir = path.join(tmpDir, DAINTREE_RECIPES_DIR);
    await fs.mkdir(recipesDir, { recursive: true });
    const filePath = path.join(recipesDir, "unreadable.json");
    await fs.writeFile(filePath, JSON.stringify(makeRecipe({ id: "r1", name: "R1" })), "utf-8");
    await fs.chmod(filePath, 0o000);

    // Some environments (e.g. running as root) ignore the mode; only assert the
    // partial-scan signal when the file is genuinely unreadable here.
    let readable = true;
    try {
      await fs.readFile(filePath, "utf-8");
    } catch {
      readable = false;
    }

    const { dirExists, scanComplete } = await identityFiles.readInRepoRecipesWithHashes(tmpDir);
    expect(dirExists).toBe(true);
    expect(scanComplete).toBe(readable);

    await fs.chmod(filePath, 0o600); // restore so afterEach cleanup can remove it
  });
});

describe("readInRepoRecipes", () => {
  let tmpDir: string;
  let identityFiles: ProjectIdentityFiles;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-recipe-read-test-"));
    identityFiles = new ProjectIdentityFiles();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when .daintree/recipes/ does not exist", async () => {
    const recipes = await identityFiles.readInRepoRecipes(tmpDir);
    expect(recipes).toEqual([]);
  });

  it("reads valid recipe files", async () => {
    const recipesDir = path.join(tmpDir, DAINTREE_RECIPES_DIR);
    await fs.mkdir(recipesDir, { recursive: true });
    await fs.writeFile(
      path.join(recipesDir, "my-recipe.json"),
      JSON.stringify({
        id: "r1",
        name: "My Recipe",
        terminals: [{ type: "terminal" }],
        createdAt: 100,
      }),
      "utf-8"
    );
    const recipes = await identityFiles.readInRepoRecipes(tmpDir);
    expect(recipes).toHaveLength(1);
    expect(recipes[0]!.name).toBe("My Recipe");
  });

  it("skips malformed JSON files", async () => {
    const recipesDir = path.join(tmpDir, DAINTREE_RECIPES_DIR);
    await fs.mkdir(recipesDir, { recursive: true });
    await fs.writeFile(path.join(recipesDir, "bad.json"), "not json", "utf-8");
    await fs.writeFile(
      path.join(recipesDir, "good.json"),
      JSON.stringify({ name: "Good", terminals: [{ type: "terminal" }], createdAt: 100 }),
      "utf-8"
    );
    const recipes = await identityFiles.readInRepoRecipes(tmpDir);
    expect(recipes).toHaveLength(1);
    expect(recipes[0]!.name).toBe("Good");
  });

  it("skips files missing required fields", async () => {
    const recipesDir = path.join(tmpDir, DAINTREE_RECIPES_DIR);
    await fs.mkdir(recipesDir, { recursive: true });
    await fs.writeFile(
      path.join(recipesDir, "no-name.json"),
      JSON.stringify({ terminals: [{ type: "terminal" }] }),
      "utf-8"
    );
    await fs.writeFile(
      path.join(recipesDir, "no-terminals.json"),
      JSON.stringify({ name: "No Terminals" }),
      "utf-8"
    );
    const recipes = await identityFiles.readInRepoRecipes(tmpDir);
    expect(recipes).toHaveLength(0);
  });

  it("assigns stable ID from filename when missing", async () => {
    const recipesDir = path.join(tmpDir, DAINTREE_RECIPES_DIR);
    await fs.mkdir(recipesDir, { recursive: true });
    await fs.writeFile(
      path.join(recipesDir, "my-recipe.json"),
      JSON.stringify({ name: "My Recipe", terminals: [{ type: "terminal" }] }),
      "utf-8"
    );
    const recipes = await identityFiles.readInRepoRecipes(tmpDir);
    expect(recipes[0]!.id).toBe("inrepo-my-recipe");
  });

  it("defaults createdAt to 0 when missing", async () => {
    const recipesDir = path.join(tmpDir, DAINTREE_RECIPES_DIR);
    await fs.mkdir(recipesDir, { recursive: true });
    await fs.writeFile(
      path.join(recipesDir, "my-recipe.json"),
      JSON.stringify({ name: "My Recipe", terminals: [{ type: "terminal" }] }),
      "utf-8"
    );
    const recipes = await identityFiles.readInRepoRecipes(tmpDir);
    expect(recipes[0]!.createdAt).toBe(0);
  });

  it("assigns stable ID from filename when id is a non-string truthy value", async () => {
    const recipesDir = path.join(tmpDir, DAINTREE_RECIPES_DIR);
    await fs.mkdir(recipesDir, { recursive: true });
    await fs.writeFile(
      path.join(recipesDir, "numeric-id.json"),
      JSON.stringify({
        id: 42,
        name: "Numeric ID",
        terminals: [{ type: "terminal" }],
        createdAt: 100,
      }),
      "utf-8"
    );
    const recipes = await identityFiles.readInRepoRecipes(tmpDir);
    expect(recipes).toHaveLength(1);
    expect(recipes[0]!.id).toBe("inrepo-numeric-id");
  });

  it("parses ISO 8601 string createdAt to a millisecond timestamp", async () => {
    const recipesDir = path.join(tmpDir, DAINTREE_RECIPES_DIR);
    await fs.mkdir(recipesDir, { recursive: true });
    await fs.writeFile(
      path.join(recipesDir, "iso-date.json"),
      JSON.stringify({
        id: "r1",
        name: "ISO Date",
        terminals: [{ type: "terminal" }],
        createdAt: "2025-01-15T10:30:00Z",
      }),
      "utf-8"
    );
    const recipes = await identityFiles.readInRepoRecipes(tmpDir);
    expect(recipes).toHaveLength(1);
    expect(recipes[0]!.createdAt).toBe(Date.parse("2025-01-15T10:30:00Z"));
  });

  it("falls back to 0 when createdAt is an unparseable string", async () => {
    const recipesDir = path.join(tmpDir, DAINTREE_RECIPES_DIR);
    await fs.mkdir(recipesDir, { recursive: true });
    await fs.writeFile(
      path.join(recipesDir, "bad-date.json"),
      JSON.stringify({
        id: "r1",
        name: "Bad Date",
        terminals: [{ type: "terminal" }],
        createdAt: "not-a-date",
      }),
      "utf-8"
    );
    const recipes = await identityFiles.readInRepoRecipes(tmpDir);
    expect(recipes).toHaveLength(1);
    expect(recipes[0]!.createdAt).toBe(0);
  });

  it("skips recipes with invalid terminal entries", async () => {
    const recipesDir = path.join(tmpDir, DAINTREE_RECIPES_DIR);
    await fs.mkdir(recipesDir, { recursive: true });
    await fs.writeFile(
      path.join(recipesDir, "bad-terminal.json"),
      JSON.stringify({
        id: "r1",
        name: "Bad Terminal",
        terminals: [{ type: "" }],
        createdAt: 100,
      }),
      "utf-8"
    );
    await fs.writeFile(
      path.join(recipesDir, "no-type.json"),
      JSON.stringify({
        id: "r2",
        name: "No Terminal Type",
        terminals: [{ title: "missing type" }],
        createdAt: 100,
      }),
      "utf-8"
    );
    const recipes = await identityFiles.readInRepoRecipes(tmpDir);
    expect(recipes).toHaveLength(0);
  });

  it("skips recipes with deep field errors in terminals", async () => {
    const recipesDir = path.join(tmpDir, DAINTREE_RECIPES_DIR);
    await fs.mkdir(recipesDir, { recursive: true });
    await fs.writeFile(
      path.join(recipesDir, "command-number.json"),
      JSON.stringify({
        id: "r1",
        name: "Command Number",
        terminals: [{ type: "terminal", command: 12345 }],
        createdAt: 100,
      }),
      "utf-8"
    );
    await fs.writeFile(
      path.join(recipesDir, "valid.json"),
      JSON.stringify({
        id: "r2",
        name: "Valid",
        terminals: [{ type: "terminal" }],
        createdAt: 100,
      }),
      "utf-8"
    );
    const recipes = await identityFiles.readInRepoRecipes(tmpDir);
    expect(recipes).toHaveLength(1);
    expect(recipes[0]!.id).toBe("r2");
  });

  it("drops a terminal with a non-allowlisted type but keeps valid terminals in the recipe", async () => {
    const recipesDir = path.join(tmpDir, DAINTREE_RECIPES_DIR);
    await fs.mkdir(recipesDir, { recursive: true });
    await fs.writeFile(
      path.join(recipesDir, "mixed.json"),
      JSON.stringify({
        id: "r1",
        name: "Mixed",
        terminals: [
          { type: "terminal", command: "npm test" },
          { type: "totally-made-up-agent", command: "rm -rf /" },
        ],
        createdAt: 100,
      }),
      "utf-8"
    );
    const recipes = await identityFiles.readInRepoRecipes(tmpDir);
    expect(recipes).toHaveLength(1);
    expect(recipes[0]!.terminals).toHaveLength(1);
    expect(recipes[0]!.terminals[0]!.type).toBe("terminal");
  });

  it("drops a terminal with control characters in command but keeps the recipe", async () => {
    const recipesDir = path.join(tmpDir, DAINTREE_RECIPES_DIR);
    await fs.mkdir(recipesDir, { recursive: true });
    await fs.writeFile(
      path.join(recipesDir, "injected.json"),
      JSON.stringify({
        id: "r1",
        name: "Injected",
        terminals: [
          { type: "terminal", command: "echo hi\nrm -rf /" },
          { type: "terminal", command: "echo safe" },
        ],
        createdAt: 100,
      }),
      "utf-8"
    );
    const recipes = await identityFiles.readInRepoRecipes(tmpDir);
    expect(recipes).toHaveLength(1);
    expect(recipes[0]!.terminals).toHaveLength(1);
    expect(recipes[0]!.terminals[0]!.command).toBe("echo safe");
  });

  it("drops a terminal with control characters in env values", async () => {
    const recipesDir = path.join(tmpDir, DAINTREE_RECIPES_DIR);
    await fs.mkdir(recipesDir, { recursive: true });
    await fs.writeFile(
      path.join(recipesDir, "env-injected.json"),
      JSON.stringify({
        id: "r1",
        name: "Env Injected",
        terminals: [
          { type: "terminal", command: "ok", env: { FOO: "bar\ninjected" } },
          { type: "terminal", command: "ok", env: { FOO: "bar" } },
        ],
        createdAt: 100,
      }),
      "utf-8"
    );
    const recipes = await identityFiles.readInRepoRecipes(tmpDir);
    expect(recipes).toHaveLength(1);
    expect(recipes[0]!.terminals).toHaveLength(1);
    expect(recipes[0]!.terminals[0]!.env).toEqual({ FOO: "bar" });
  });

  it("omits a recipe entirely when every terminal fails content validation", async () => {
    const recipesDir = path.join(tmpDir, DAINTREE_RECIPES_DIR);
    await fs.mkdir(recipesDir, { recursive: true });
    await fs.writeFile(
      path.join(recipesDir, "all-bad.json"),
      JSON.stringify({
        id: "r1",
        name: "All Bad",
        terminals: [
          { type: "fake-agent", command: "evil" },
          { type: "terminal", command: "echo\x00boom" },
        ],
        createdAt: 100,
      }),
      "utf-8"
    );
    const recipes = await identityFiles.readInRepoRecipes(tmpDir);
    expect(recipes).toHaveLength(0);
  });

  it("strips unknown passthrough fields from in-repo terminals", async () => {
    const recipesDir = path.join(tmpDir, DAINTREE_RECIPES_DIR);
    await fs.mkdir(recipesDir, { recursive: true });
    await fs.writeFile(
      path.join(recipesDir, "passthrough.json"),
      JSON.stringify({
        id: "r1",
        name: "Passthrough",
        terminals: [{ type: "terminal", command: "npm test", shell: true, poisoned: "x" }],
        createdAt: 100,
      }),
      "utf-8"
    );
    const recipes = await identityFiles.readInRepoRecipes(tmpDir);
    expect(recipes).toHaveLength(1);
    const terminal = recipes[0]!.terminals[0]! as unknown as Record<string, unknown>;
    expect(terminal.shell).toBeUndefined();
    expect(terminal.poisoned).toBeUndefined();
    expect(terminal.command).toBe("npm test");
  });

  it("caps an in-repo recipe at MAX_TERMINALS_PER_RECIPE valid terminals", async () => {
    const recipesDir = path.join(tmpDir, DAINTREE_RECIPES_DIR);
    await fs.mkdir(recipesDir, { recursive: true });
    await fs.writeFile(
      path.join(recipesDir, "huge.json"),
      JSON.stringify({
        id: "r1",
        name: "Huge",
        terminals: Array.from({ length: 25 }, (_, i) => ({
          type: "terminal",
          command: `echo ${i}`,
        })),
        createdAt: 100,
      }),
      "utf-8"
    );
    const recipes = await identityFiles.readInRepoRecipes(tmpDir);
    expect(recipes).toHaveLength(1);
    expect(recipes[0]!.terminals).toHaveLength(10);
  });

  it("keeps an initialPrompt that contains newlines", async () => {
    const recipesDir = path.join(tmpDir, DAINTREE_RECIPES_DIR);
    await fs.mkdir(recipesDir, { recursive: true });
    await fs.writeFile(
      path.join(recipesDir, "prompt.json"),
      JSON.stringify({
        id: "r1",
        name: "Prompt",
        terminals: [{ type: "claude", initialPrompt: "do this\r\nthen that" }],
        createdAt: 100,
      }),
      "utf-8"
    );
    const recipes = await identityFiles.readInRepoRecipes(tmpDir);
    expect(recipes).toHaveLength(1);
    expect(recipes[0]!.terminals[0]!.initialPrompt).toBe("do this\nthen that");
  });
});

describe("deleteInRepoRecipe", () => {
  let tmpDir: string;
  let identityFiles: ProjectIdentityFiles;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-recipe-delete-test-"));
    identityFiles = new ProjectIdentityFiles();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("deletes an existing recipe file", async () => {
    await identityFiles.writeInRepoRecipe(tmpDir, makeRecipe({ name: "To Delete" }));
    await identityFiles.deleteInRepoRecipe(tmpDir, "To Delete");
    const recipesDir = path.join(tmpDir, DAINTREE_RECIPES_DIR);
    const files = await fs.readdir(recipesDir);
    expect(files).toHaveLength(0);
  });

  it("silently succeeds when file does not exist", async () => {
    await expect(identityFiles.deleteInRepoRecipe(tmpDir, "Nonexistent")).resolves.toBeUndefined();
  });
});

describe("readInRepoPresets", () => {
  let tmpDir: string;
  let identityFiles: ProjectIdentityFiles;
  const PRESETS_DIR = ".daintree/presets";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-presets-read-test-"));
    identityFiles = new ProjectIdentityFiles();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty object when presets directory is absent", async () => {
    const result = await identityFiles.readInRepoPresets(tmpDir);
    expect(result).toEqual({});
  });

  it("loads presets from per-agent subdirectories", async () => {
    const agentDir = path.join(tmpDir, PRESETS_DIR, "claude");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(
      path.join(agentDir, "team-opus.json"),
      JSON.stringify({ id: "team-opus", name: "Team Opus", env: { MODEL: "opus" } })
    );

    const result = await identityFiles.readInRepoPresets(tmpDir);
    expect(result).toHaveProperty("claude");
    expect(result.claude).toHaveLength(1);
    expect(result.claude?.[0]?.id).toBe("team-opus");
    expect(result.claude?.[0]?.name).toBe("Team Opus");
  });

  it("groups presets by the agent subdirectory they live in", async () => {
    const claudeDir = path.join(tmpDir, PRESETS_DIR, "claude");
    const codexDir = path.join(tmpDir, PRESETS_DIR, "codex");
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.mkdir(codexDir, { recursive: true });
    await fs.writeFile(path.join(claudeDir, "a.json"), JSON.stringify({ id: "a", name: "A" }));
    await fs.writeFile(path.join(codexDir, "b.json"), JSON.stringify({ id: "b", name: "B" }));

    const result = await identityFiles.readInRepoPresets(tmpDir);
    expect(result.claude?.map((p) => p.id)).toEqual(["a"]);
    expect(result.codex?.map((p) => p.id)).toEqual(["b"]);
  });

  it("skips malformed JSON files without throwing", async () => {
    const agentDir = path.join(tmpDir, PRESETS_DIR, "claude");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, "broken.json"), "{ not valid json");
    await fs.writeFile(
      path.join(agentDir, "valid.json"),
      JSON.stringify({ id: "valid", name: "Valid" })
    );

    const result = await identityFiles.readInRepoPresets(tmpDir);
    expect(result.claude).toHaveLength(1);
    expect(result.claude?.[0]?.id).toBe("valid");
  });

  it("skips files missing required id or name fields", async () => {
    const agentDir = path.join(tmpDir, PRESETS_DIR, "claude");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, "no-id.json"), JSON.stringify({ name: "No ID" }));
    await fs.writeFile(path.join(agentDir, "no-name.json"), JSON.stringify({ id: "no-name" }));
    await fs.writeFile(path.join(agentDir, "ok.json"), JSON.stringify({ id: "ok", name: "OK" }));

    const result = await identityFiles.readInRepoPresets(tmpDir);
    expect(result.claude).toHaveLength(1);
    expect(result.claude?.[0]?.id).toBe("ok");
  });

  it("ignores non-.json files in agent directories", async () => {
    const agentDir = path.join(tmpDir, PRESETS_DIR, "claude");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, "README.md"), "# Notes");
    await fs.writeFile(path.join(agentDir, "p.json"), JSON.stringify({ id: "p", name: "P" }));

    const result = await identityFiles.readInRepoPresets(tmpDir);
    expect(result.claude).toHaveLength(1);
  });

  it("deduplicates presets with the same id within an agent directory and warns", async () => {
    const agentDir = path.join(tmpDir, PRESETS_DIR, "claude");
    await fs.mkdir(agentDir, { recursive: true });
    // Two files, same id. Filesystem readdir order is non-deterministic;
    // the behavior we pin is: at most one entry, with a warning.
    await fs.writeFile(path.join(agentDir, "a.json"), JSON.stringify({ id: "dup", name: "First" }));
    await fs.writeFile(
      path.join(agentDir, "b.json"),
      JSON.stringify({ id: "dup", name: "Second" })
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await identityFiles.readInRepoPresets(tmpDir);
    expect(result.claude).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Duplicate preset id"));
    warnSpy.mockRestore();
  });

  it("does not leak env values when warning about a shape-invalid preset", async () => {
    const agentDir = path.join(tmpDir, PRESETS_DIR, "claude");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(
      path.join(agentDir, "leaky.json"),
      JSON.stringify({ id: 42, name: "Bad ID Type", env: { API_KEY: "sk-live-secret-xyz" } })
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await identityFiles.readInRepoPresets(tmpDir);

    const allWarnArgs = warnSpy.mock.calls.flat();
    const serialized = allWarnArgs
      .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ");
    expect(serialized).not.toContain("sk-live-secret-xyz");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Skipping invalid preset"),
      expect.anything()
    );
    warnSpy.mockRestore();
  });

  it("rejects unsafe agent subdirectory names", async () => {
    const presetsDir = path.join(tmpDir, PRESETS_DIR);
    await fs.mkdir(presetsDir, { recursive: true });
    // "bad/name" can't be created as a directory name but "..hidden" passes
    // normal filesystem rules and must be rejected by the SAFE_AGENT_ID check.
    const unsafeDir = path.join(presetsDir, "has space");
    await fs.mkdir(unsafeDir, { recursive: true });
    await fs.writeFile(path.join(unsafeDir, "x.json"), JSON.stringify({ id: "x", name: "X" }));

    const result = await identityFiles.readInRepoPresets(tmpDir);
    expect(result).not.toHaveProperty("has space");
  });
});
