import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ProjectSettingsManager } from "../ProjectSettingsManager.js";
import { generateProjectId } from "../projectStorePaths.js";

vi.mock("../ProjectEnvSecureStorage.js", () => ({
  projectEnvSecureStorage: {
    get: vi.fn(() => undefined),
    set: vi.fn(),
    delete: vi.fn(),
    listKeys: vi.fn(() => []),
    deleteAllForProject: vi.fn(),
    migrateAllForProject: vi.fn(),
  },
}));

function createMockStore() {
  return {
    get: vi.fn(() => ({
      enabled: true,
      completedEnabled: true,
      waitingEnabled: true,
      soundEnabled: false,
      completedSoundFile: null,
      waitingSoundFile: null,
      escalationSoundFile: null,
      waitingEscalationEnabled: false,
      waitingEscalationDelayMs: 30_000,
    })),
    set: vi.fn(),
  } as unknown as ConstructorParameters<typeof ProjectSettingsManager>[1];
}

describe("ProjectSettingsManager caching", () => {
  let tempDir: string;
  let manager: ProjectSettingsManager;
  let projectId: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canopy-settings-"));
    manager = new ProjectSettingsManager(tempDir, createMockStore());

    projectId = generateProjectId("/test/project");
    const projectDir = path.join(tempDir, projectId);
    await fs.mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("returns cached settings on second call without re-reading disk", async () => {
    const settingsPath = path.join(tempDir, projectId, "settings.json");
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ runCommands: [{ id: "npm-dev", name: "dev", command: "npm run dev" }] }),
      "utf-8"
    );

    const first = await manager.getProjectSettings(projectId);
    expect(first.runCommands).toHaveLength(1);

    const readSpy = vi.spyOn(fs, "readFile");
    const second = await manager.getProjectSettings(projectId);
    expect(second).toEqual(first);
    expect(readSpy).not.toHaveBeenCalled();
    readSpy.mockRestore();
  });

  it("invalidates cache on save so next read refreshes from disk", async () => {
    const settingsPath = path.join(tempDir, projectId, "settings.json");
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ runCommands: [{ id: "npm-dev", name: "dev", command: "npm run dev" }] }),
      "utf-8"
    );

    const first = await manager.getProjectSettings(projectId);
    expect(first.runCommands).toHaveLength(1);

    await manager.saveProjectSettings(projectId, {
      runCommands: [
        { id: "npm-dev", name: "dev", command: "npm run dev" },
        { id: "npm-build", name: "build", command: "npm run build" },
      ],
    });

    const readSpy = vi.spyOn(fs, "readFile");
    const afterSave = await manager.getProjectSettings(projectId);
    expect(readSpy).toHaveBeenCalled();
    expect(afterSave.runCommands).toHaveLength(2);
    readSpy.mockRestore();
  });

  it("does not cache when settings file does not exist", async () => {
    const nonexistentId = generateProjectId("/nonexistent/project");

    const first = await manager.getProjectSettings(nonexistentId);
    expect(first).toEqual({ runCommands: [] });

    const projectDir = path.join(tempDir, nonexistentId);
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "settings.json"),
      JSON.stringify({ runCommands: [{ id: "npm-dev", name: "dev", command: "npm run dev" }] }),
      "utf-8"
    );

    const second = await manager.getProjectSettings(nonexistentId);
    expect(second.runCommands).toHaveLength(1);
  });

  it("does not cache when settings file contains invalid JSON", async () => {
    const settingsPath = path.join(tempDir, projectId, "settings.json");
    await fs.writeFile(settingsPath, "{{invalid json", "utf-8");

    const first = await manager.getProjectSettings(projectId);
    expect(first).toEqual({ runCommands: [] });

    await fs.writeFile(
      settingsPath,
      JSON.stringify({ runCommands: [{ id: "npm-dev", name: "dev", command: "npm run dev" }] }),
      "utf-8"
    );

    const second = await manager.getProjectSettings(projectId);
    expect(second.runCommands).toHaveLength(1);
  });

  it("re-reads after TTL expires", async () => {
    vi.useFakeTimers();
    try {
      const settingsPath = path.join(tempDir, projectId, "settings.json");
      await fs.writeFile(
        settingsPath,
        JSON.stringify({ runCommands: [{ id: "npm-dev", name: "dev", command: "npm run dev" }] }),
        "utf-8"
      );

      await manager.getProjectSettings(projectId);

      vi.advanceTimersByTime(31_000);

      const readSpy = vi.spyOn(fs, "readFile");
      await manager.getProjectSettings(projectId);
      expect(readSpy).toHaveBeenCalled();
      readSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});
