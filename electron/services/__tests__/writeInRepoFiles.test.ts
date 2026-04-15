import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import type { ProjectSettings, TerminalRecipe } from "../../types/index.js";
import { ProjectIdentityFiles } from "../ProjectIdentityFiles.js";

const DAINTREE_PROJECT_JSON = ".canopy/project.json";
const DAINTREE_SETTINGS_JSON = ".canopy/settings.json";
const DAINTREE_RECIPES_DIR = ".canopy/recipes";

function makeSettings(overrides: Partial<ProjectSettings> = {}): ProjectSettings {
  return { runCommands: [], ...overrides };
}

describe("writeInRepoProjectIdentity", () => {
  let tmpDir: string;
  let identityFiles: ProjectIdentityFiles;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "canopy-write-test-"));
    identityFiles = new ProjectIdentityFiles();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates .canopy/ directory and project.json when absent", async () => {
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
    const canopyDir = path.join(tmpDir, ".canopy");
    const files = await fs.readdir(canopyDir);
    const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });

  it("writes pretty-printed JSON (2-space indent)", async () => {
    await identityFiles.writeInRepoProjectIdentity(tmpDir, { name: "Formatted" });
    const raw = await fs.readFile(path.join(tmpDir, DAINTREE_PROJECT_JSON), "utf-8");
    expect(raw).toContain("\n");
    expect(raw).toContain("  ");
  });

  it("works when .canopy/ already exists", async () => {
    await fs.mkdir(path.join(tmpDir, ".canopy"), { recursive: true });
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
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "canopy-settings-test-"));
    identityFiles = new ProjectIdentityFiles();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates .canopy/ directory and settings.json when absent", async () => {
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

  it("omits machine-local fields: devServerDismissed", async () => {
    await identityFiles.writeInRepoSettings(tmpDir, makeSettings({ devServerDismissed: true }));
    const content = JSON.parse(
      await fs.readFile(path.join(tmpDir, DAINTREE_SETTINGS_JSON), "utf-8")
    );
    expect(content).not.toHaveProperty("devServerDismissed");
  });

  it("omits machine-local fields: devServerAutoDetected", async () => {
    await identityFiles.writeInRepoSettings(tmpDir, makeSettings({ devServerAutoDetected: true }));
    const content = JSON.parse(
      await fs.readFile(path.join(tmpDir, DAINTREE_SETTINGS_JSON), "utf-8")
    );
    expect(content).not.toHaveProperty("devServerAutoDetected");
  });

  it("omits environment variables from output", async () => {
    await identityFiles.writeInRepoSettings(
      tmpDir,
      makeSettings({
        environmentVariables: { API_KEY: "secret123" },
        secureEnvironmentVariables: ["DB_PASS"],
      })
    );
    const content = JSON.parse(
      await fs.readFile(path.join(tmpDir, DAINTREE_SETTINGS_JSON), "utf-8")
    );
    expect(content).not.toHaveProperty("environmentVariables");
    expect(content).not.toHaveProperty("secureEnvironmentVariables");
  });

  it("omits projectIconSvg from output", async () => {
    await identityFiles.writeInRepoSettings(
      tmpDir,
      makeSettings({ projectIconSvg: "<svg>...</svg>" })
    );
    const content = JSON.parse(
      await fs.readFile(path.join(tmpDir, DAINTREE_SETTINGS_JSON), "utf-8")
    );
    expect(content).not.toHaveProperty("projectIconSvg");
  });

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
    const canopyDir = path.join(tmpDir, ".canopy");
    const files = await fs.readdir(canopyDir);
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
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "canopy-recipe-write-test-"));
    identityFiles = new ProjectIdentityFiles();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates .canopy/recipes/ directory and writes recipe file", async () => {
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
});

describe("readInRepoRecipes", () => {
  let tmpDir: string;
  let identityFiles: ProjectIdentityFiles;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "canopy-recipe-read-test-"));
    identityFiles = new ProjectIdentityFiles();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when .canopy/recipes/ does not exist", async () => {
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
});

describe("deleteInRepoRecipe", () => {
  let tmpDir: string;
  let identityFiles: ProjectIdentityFiles;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "canopy-recipe-delete-test-"));
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
