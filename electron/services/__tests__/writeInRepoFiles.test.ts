import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import type { ProjectSettings, TerminalRecipe } from "../../types/index.js";
import { ProjectIdentityFiles } from "../ProjectIdentityFiles.js";

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
