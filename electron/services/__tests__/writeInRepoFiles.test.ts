import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import type { ProjectSettings } from "../../types/index.js";
import { ProjectIdentityFiles } from "../ProjectIdentityFiles.js";

const CANOPY_PROJECT_JSON = ".canopy/project.json";
const CANOPY_SETTINGS_JSON = ".canopy/settings.json";

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

    const filePath = path.join(tmpDir, CANOPY_PROJECT_JSON);
    const content = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(content).toEqual({ version: 1, name: "My App", emoji: "🚀", color: "blue" });
  });

  it("writes version: 1 in all cases", async () => {
    await identityFiles.writeInRepoProjectIdentity(tmpDir, {});
    const content = JSON.parse(await fs.readFile(path.join(tmpDir, CANOPY_PROJECT_JSON), "utf-8"));
    expect(content.version).toBe(1);
  });

  it("omits undefined fields from output", async () => {
    await identityFiles.writeInRepoProjectIdentity(tmpDir, { name: "Only Name" });
    const content = JSON.parse(await fs.readFile(path.join(tmpDir, CANOPY_PROJECT_JSON), "utf-8"));
    expect(content).toEqual({ version: 1, name: "Only Name" });
    expect(content).not.toHaveProperty("emoji");
    expect(content).not.toHaveProperty("color");
  });

  it("overwrites existing file with new values", async () => {
    await identityFiles.writeInRepoProjectIdentity(tmpDir, { name: "Old Name", emoji: "🌲" });
    await identityFiles.writeInRepoProjectIdentity(tmpDir, { name: "New Name", emoji: "🚀" });
    const content = JSON.parse(await fs.readFile(path.join(tmpDir, CANOPY_PROJECT_JSON), "utf-8"));
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
    const raw = await fs.readFile(path.join(tmpDir, CANOPY_PROJECT_JSON), "utf-8");
    expect(raw).toContain("\n");
    expect(raw).toContain("  ");
  });

  it("works when .canopy/ already exists", async () => {
    await fs.mkdir(path.join(tmpDir, ".canopy"), { recursive: true });
    await identityFiles.writeInRepoProjectIdentity(tmpDir, { name: "Existing Dir" });
    const content = JSON.parse(await fs.readFile(path.join(tmpDir, CANOPY_PROJECT_JSON), "utf-8"));
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

    const filePath = path.join(tmpDir, CANOPY_SETTINGS_JSON);
    const content = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(content.version).toBe(1);
    expect(content.runCommands).toHaveLength(1);
    expect(content.devServerCommand).toBe("npm run dev");
    expect(content.excludedPaths).toEqual(["node_modules"]);
  });

  it("omits machine-local fields: devServerDismissed", async () => {
    await identityFiles.writeInRepoSettings(tmpDir, makeSettings({ devServerDismissed: true }));
    const content = JSON.parse(await fs.readFile(path.join(tmpDir, CANOPY_SETTINGS_JSON), "utf-8"));
    expect(content).not.toHaveProperty("devServerDismissed");
  });

  it("omits machine-local fields: devServerAutoDetected", async () => {
    await identityFiles.writeInRepoSettings(tmpDir, makeSettings({ devServerAutoDetected: true }));
    const content = JSON.parse(await fs.readFile(path.join(tmpDir, CANOPY_SETTINGS_JSON), "utf-8"));
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
    const content = JSON.parse(await fs.readFile(path.join(tmpDir, CANOPY_SETTINGS_JSON), "utf-8"));
    expect(content).not.toHaveProperty("environmentVariables");
    expect(content).not.toHaveProperty("secureEnvironmentVariables");
  });

  it("omits projectIconSvg from output", async () => {
    await identityFiles.writeInRepoSettings(
      tmpDir,
      makeSettings({ projectIconSvg: "<svg>...</svg>" })
    );
    const content = JSON.parse(await fs.readFile(path.join(tmpDir, CANOPY_SETTINGS_JSON), "utf-8"));
    expect(content).not.toHaveProperty("projectIconSvg");
  });

  it("includes copyTreeSettings when present", async () => {
    await identityFiles.writeInRepoSettings(
      tmpDir,
      makeSettings({ copyTreeSettings: { maxFileSize: 50000 } })
    );
    const content = JSON.parse(await fs.readFile(path.join(tmpDir, CANOPY_SETTINGS_JSON), "utf-8"));
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
    const raw = await fs.readFile(path.join(tmpDir, CANOPY_SETTINGS_JSON), "utf-8");
    expect(raw).toContain("\n");
    expect(raw).toContain("  ");
  });

  it("omits runCommands from output when empty", async () => {
    await identityFiles.writeInRepoSettings(tmpDir, makeSettings());
    const content = JSON.parse(await fs.readFile(path.join(tmpDir, CANOPY_SETTINGS_JSON), "utf-8"));
    expect(content).not.toHaveProperty("runCommands");
  });
});
