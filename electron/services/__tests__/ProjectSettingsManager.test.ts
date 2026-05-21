import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ProjectSettingsManager } from "../ProjectSettingsManager.js";
import { generateProjectId } from "../projectStorePaths.js";
import { PROJECT_SETTINGS_SCHEMA_VERSION } from "../projectSettingsCodec.js";

vi.mock("../CommandService.js", () => ({
  commandService: {
    invalidateOverridesCache: vi.fn(),
  },
}));

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

const broadcastSpy = vi.fn();
vi.mock("../../ipc/utils.js", () => ({
  broadcastToRenderer: (...args: unknown[]) => broadcastSpy(...args),
  // Re-export the other surface members that production callers might pull
  // in transitively; tests only exercise broadcastToRenderer here.
  typedHandle: vi.fn(),
  typedHandleValidated: vi.fn(),
  typedHandleWithContext: vi.fn(),
  typedHandleWithContextValidated: vi.fn(),
  typedBroadcast: vi.fn(),
  typedSend: vi.fn(),
  sendToRenderer: vi.fn(),
  sendToRendererContext: vi.fn(),
  channelToCategory: {},
  checkRateLimit: vi.fn(),
  waitForRateLimitSlot: vi.fn(),
  drainRateLimitQueues: vi.fn(),
  armRestoreQuota: vi.fn(),
  consumeRestoreQuota: vi.fn(),
  _resetRateLimitQueuesForTest: vi.fn(),
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
    broadcastSpy.mockReset();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-settings-"));
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

  it("round-trips turbopackEnabled=false through save/load", async () => {
    await manager.saveProjectSettings(projectId, {
      runCommands: [],
      turbopackEnabled: false,
    });

    // Advance past cache TTL so we actually hit disk on read.
    const freshManager = new ProjectSettingsManager(tempDir, createMockStore());
    const loaded = await freshManager.getProjectSettings(projectId);
    expect(loaded.turbopackEnabled).toBe(false);
  });

  it("treats missing turbopackEnabled as undefined (default-on at read sites)", async () => {
    const settingsPath = path.join(tempDir, projectId, "settings.json");
    await fs.writeFile(settingsPath, JSON.stringify({ runCommands: [] }), "utf-8");

    const loaded = await manager.getProjectSettings(projectId);
    expect(loaded.turbopackEnabled).toBeUndefined();
  });

  it("rejects non-boolean turbopackEnabled in the settings file", async () => {
    const settingsPath = path.join(tempDir, projectId, "settings.json");
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ runCommands: [], turbopackEnabled: "yes" }),
      "utf-8"
    );

    const loaded = await manager.getProjectSettings(projectId);
    expect(loaded.turbopackEnabled).toBeUndefined();
  });

  it.each(["off", "workbench", "action", "system"] as const)(
    "round-trips daintreeMcpTier=%s through save/load",
    async (tier) => {
      await manager.saveProjectSettings(projectId, {
        runCommands: [],
        daintreeMcpTier: tier,
      });

      const freshManager = new ProjectSettingsManager(tempDir, createMockStore());
      const loaded = await freshManager.getProjectSettings(projectId);
      expect(loaded.daintreeMcpTier).toBe(tier);
    }
  );

  it("round-trips forgeProviderOverride through save/load", async () => {
    await manager.saveProjectSettings(projectId, {
      runCommands: [],
      forgeProviderOverride: "daintree.github.github",
    });

    const freshManager = new ProjectSettingsManager(tempDir, createMockStore());
    const loaded = await freshManager.getProjectSettings(projectId);
    expect(loaded.forgeProviderOverride).toBe("daintree.github.github");
  });

  it("canonicalizes legacy 'github' on load to 'daintree.github.github' (#8451)", async () => {
    const settingsPath = path.join(tempDir, projectId, "settings.json");
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ runCommands: [], forgeProviderOverride: "github" }),
      "utf-8"
    );

    const loaded = await manager.getProjectSettings(projectId);
    expect(loaded.forgeProviderOverride).toBe("daintree.github.github");
  });

  it("canonicalizes legacy 'builtin.github' on load to 'daintree.github.github' (#8451)", async () => {
    const settingsPath = path.join(tempDir, projectId, "settings.json");
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ runCommands: [], forgeProviderOverride: "builtin.github" }),
      "utf-8"
    );

    const loaded = await manager.getProjectSettings(projectId);
    expect(loaded.forgeProviderOverride).toBe("daintree.github.github");
  });

  it("treats missing forgeProviderOverride as undefined", async () => {
    const settingsPath = path.join(tempDir, projectId, "settings.json");
    await fs.writeFile(settingsPath, JSON.stringify({ runCommands: [] }), "utf-8");

    const loaded = await manager.getProjectSettings(projectId);
    expect(loaded.forgeProviderOverride).toBeUndefined();
  });

  it("preserves null forgeProviderOverride from disk as null", async () => {
    const settingsPath = path.join(tempDir, projectId, "settings.json");
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ runCommands: [], forgeProviderOverride: null }),
      "utf-8"
    );

    const loaded = await manager.getProjectSettings(projectId);
    expect(loaded.forgeProviderOverride).toBeNull();
  });

  it("rejects non-string forgeProviderOverride values from disk", async () => {
    const settingsPath = path.join(tempDir, projectId, "settings.json");
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ runCommands: [], forgeProviderOverride: 42 }),
      "utf-8"
    );

    const loaded = await manager.getProjectSettings(projectId);
    expect(loaded.forgeProviderOverride).toBeUndefined();
  });

  it("rejects unknown daintreeMcpTier values from disk", async () => {
    const settingsPath = path.join(tempDir, projectId, "settings.json");
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ runCommands: [], daintreeMcpTier: "godmode" }),
      "utf-8"
    );

    const loaded = await manager.getProjectSettings(projectId);
    expect(loaded.daintreeMcpTier).toBeUndefined();
  });

  it("migrates the deprecated exposeDaintreeMcpToAgents flag to daintreeMcpTier on read", async () => {
    const settingsPath = path.join(tempDir, projectId, "settings.json");
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ runCommands: [], exposeDaintreeMcpToAgents: true }),
      "utf-8"
    );

    const loaded = await manager.getProjectSettings(projectId);
    // The codec normalises legacy exposeDaintreeMcpToAgents: true to
    // daintreeMcpTier: "workbench". The legacy field is still surfaced so
    // callers in mixed-version cohorts don't break.
    expect(loaded.daintreeMcpTier).toBe("workbench");
    expect(loaded.exposeDaintreeMcpToAgents).toBe(true);
  });

  it("loads settings whose JSON is prefixed with a UTF-8 BOM", async () => {
    const settingsPath = path.join(tempDir, projectId, "settings.json");
    const json = JSON.stringify({
      runCommands: [{ id: "npm-dev", name: "dev", command: "npm run dev" }],
    });
    await fs.writeFile(settingsPath, "﻿" + json, "utf-8");

    const loaded = await manager.getProjectSettings(projectId);
    expect(loaded.runCommands).toHaveLength(1);
    expect(loaded.runCommands?.[0]?.command).toBe("npm run dev");

    // Verify the BOM-prefixed file was not quarantined as corrupted.
    const dirEntries = await fs.readdir(path.join(tempDir, projectId));
    expect(dirEntries.some((name) => name.includes(".corrupted."))).toBe(false);
  });

  it("does not quarantine the settings file on transient (non-SyntaxError) read failures", async () => {
    const settingsPath = path.join(tempDir, projectId, "settings.json");
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ runCommands: [{ id: "npm-dev", name: "dev", command: "npm run dev" }] }),
      "utf-8"
    );

    const enoent = Object.assign(new Error("ENOENT: file disappeared"), { code: "ENOENT" });
    const readSpy = vi.spyOn(fs, "readFile").mockRejectedValueOnce(enoent);

    const result = await manager.getProjectSettings(projectId);
    expect(result).toEqual({ runCommands: [] });

    readSpy.mockRestore();

    // Original file untouched, no quarantine entry created.
    const dirEntries = await fs.readdir(path.join(tempDir, projectId));
    expect(dirEntries).toContain("settings.json");
    expect(dirEntries.some((name) => name.includes(".corrupted."))).toBe(false);

    // After the transient failure, a normal subsequent read should still work.
    const recovered = await manager.getProjectSettings(projectId);
    expect(recovered.runCommands).toHaveLength(1);
  });

  it("still quarantines settings files that contain truly invalid JSON", async () => {
    const settingsPath = path.join(tempDir, projectId, "settings.json");
    await fs.writeFile(settingsPath, "{{invalid json", "utf-8");

    const result = await manager.getProjectSettings(projectId);
    expect(result).toEqual({ runCommands: [] });

    const dirEntries = await fs.readdir(path.join(tempDir, projectId));
    expect(dirEntries.some((name) => name.includes(".corrupted."))).toBe(true);
    expect(dirEntries).not.toContain("settings.json");
  });

  it.runIf(process.platform !== "win32")(
    "writes the settings file with mode 0o600 on POSIX",
    async () => {
      await manager.saveProjectSettings(projectId, { runCommands: [] });

      const settingsPath = path.join(tempDir, projectId, "settings.json");
      const stat = await fs.stat(settingsPath);
      expect(stat.mode & 0o777).toBe(0o600);
    }
  );

  it("does not quarantine on permission errors and surfaces them via console.error", async () => {
    const settingsPath = path.join(tempDir, projectId, "settings.json");
    await fs.writeFile(settingsPath, JSON.stringify({ runCommands: [] }), "utf-8");

    const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const readSpy = vi.spyOn(fs, "readFile").mockRejectedValueOnce(eacces);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await manager.getProjectSettings(projectId);
    expect(result).toEqual({ runCommands: [] });
    expect(errorSpy).toHaveBeenCalledTimes(1);

    readSpy.mockRestore();
    errorSpy.mockRestore();

    const dirEntries = await fs.readdir(path.join(tempDir, projectId));
    expect(dirEntries).toContain("settings.json");
    expect(dirEntries.some((name) => name.includes(".corrupted."))).toBe(false);
  });

  it("preserves a blank secure env value through resolution rather than treating it as unresolved", async () => {
    const { projectEnvSecureStorage } = await import("../ProjectEnvSecureStorage.js");
    const getMock = projectEnvSecureStorage.get as unknown as ReturnType<typeof vi.fn>;
    getMock.mockImplementation((_pid: string, key: string) =>
      key === "OPTIONAL_TOKEN" ? "" : undefined
    );

    const settingsPath = path.join(tempDir, projectId, "settings.json");
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ runCommands: [], secureEnvironmentVariables: ["OPTIONAL_TOKEN"] }),
      "utf-8"
    );

    const loaded = await manager.getProjectSettings(projectId);
    expect(loaded.environmentVariables?.OPTIONAL_TOKEN).toBe("");
    expect(loaded.unresolvedSecureEnvironmentVariables).toBeUndefined();

    getMock.mockReset();
    getMock.mockReturnValue(undefined);
  });

  it("writes the schema version envelope on save", async () => {
    await manager.saveProjectSettings(projectId, { runCommands: [] });

    const settingsPath = path.join(tempDir, projectId, "settings.json");
    const onDisk = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    expect(onDisk._schemaVersion).toBe(PROJECT_SETTINGS_SCHEMA_VERSION);
  });

  it("migrates legacy resourceEnvironment to resourceEnvironments on read", async () => {
    const settingsPath = path.join(tempDir, projectId, "settings.json");
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        runCommands: [],
        resourceEnvironment: { provision: ["echo legacy"] },
      }),
      "utf-8"
    );

    const loaded = await manager.getProjectSettings(projectId);
    expect(loaded.resourceEnvironments).toEqual({ default: { provision: ["echo legacy"] } });
    expect(loaded.activeResourceEnvironment).toBe("default");
  });

  it("migrates legacy exposeDaintreeMcpToAgents true to daintreeMcpTier workbench", async () => {
    const settingsPath = path.join(tempDir, projectId, "settings.json");
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ runCommands: [], exposeDaintreeMcpToAgents: true }),
      "utf-8"
    );

    const loaded = await manager.getProjectSettings(projectId);
    expect(loaded.daintreeMcpTier).toBe("workbench");
  });

  it("broadcasts a corruption toast when JSON.parse fails", async () => {
    const settingsPath = path.join(tempDir, projectId, "settings.json");
    await fs.writeFile(settingsPath, "{{invalid json", "utf-8");

    const result = await manager.getProjectSettings(projectId);
    expect(result).toEqual({ runCommands: [] });

    // `broadcastCorruption` is fire-and-forget via `void` and lazy-imports
    // `broadcastToRenderer` on first hit, so the spy resolves on the next
    // microtask after `getProjectSettings` returns.
    await vi.waitFor(() => expect(broadcastSpy).toHaveBeenCalledTimes(1));
    const [channel, payload] = broadcastSpy.mock.calls[0];
    expect(channel).toBe("notification:show-toast");
    expect(payload).toMatchObject({ type: "error", title: "Project settings corrupted" });
  });

  it("forces _schemaVersion to the codec's authoritative value when a caller injects one", async () => {
    // A malicious or buggy caller cannot trick the manager into writing a
    // future _schemaVersion that would self-quarantine on next load — the
    // codec strips the injected key and stamps its own version.
    await manager.saveProjectSettings(projectId, {
      runCommands: [],
      _schemaVersion: 999,
    } as unknown as Parameters<typeof manager.saveProjectSettings>[1]);

    const settingsPath = path.join(tempDir, projectId, "settings.json");
    const onDisk = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    expect(onDisk._schemaVersion).toBe(PROJECT_SETTINGS_SCHEMA_VERSION);
  });

  it("strips agentInstructions so it never persists to disk", async () => {
    await manager.saveProjectSettings(projectId, {
      runCommands: [],
      agentInstructions: "should-not-persist",
    } as unknown as Parameters<typeof manager.saveProjectSettings>[1]);

    const settingsPath = path.join(tempDir, projectId, "settings.json");
    const onDisk = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    expect(onDisk.agentInstructions).toBeUndefined();
  });

  it("quarantines and broadcasts on a future-version envelope without overwriting the file", async () => {
    const settingsPath = path.join(tempDir, projectId, "settings.json");
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ _schemaVersion: PROJECT_SETTINGS_SCHEMA_VERSION + 99, runCommands: [] }),
      "utf-8"
    );

    const result = await manager.getProjectSettings(projectId);
    expect(result).toEqual({ runCommands: [] });

    const dirEntries = await fs.readdir(path.join(tempDir, projectId));
    expect(dirEntries.some((name) => name.includes(".future-v"))).toBe(true);
    expect(dirEntries).not.toContain("settings.json");

    await vi.waitFor(() => expect(broadcastSpy).toHaveBeenCalledTimes(1));
    const [, payload] = broadcastSpy.mock.calls[0];
    expect(payload).toMatchObject({ type: "error", title: "Settings file too new" });
  });
});
