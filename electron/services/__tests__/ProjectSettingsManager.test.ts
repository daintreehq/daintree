import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ProjectSettingsManager } from "../ProjectSettingsManager.js";
import { generateProjectId } from "../projectStorePaths.js";
import { PROJECT_SETTINGS_SCHEMA_VERSION } from "../projectSettingsCodec.js";
import { resilientAtomicWriteFile } from "../../utils/fs.js";

vi.mock("../../utils/fs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/fs.js")>();
  return { ...actual, resilientAtomicWriteFile: vi.fn(actual.resilientAtomicWriteFile) };
});

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

  it("treats an ENOENT read as a missing file, without quarantine", async () => {
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

  it("rejects a permission error without quarantining, and recovers on the next read", async () => {
    const settingsPath = path.join(tempDir, projectId, "settings.json");
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ runCommands: [{ id: "npm-dev", name: "dev", command: "npm run dev" }] }),
      "utf-8"
    );

    const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const readSpy = vi.spyOn(fs, "readFile").mockRejectedValueOnce(eacces);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(manager.getProjectSettings(projectId)).rejects.toBe(eacces);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    readSpy.mockRestore();
    errorSpy.mockRestore();

    const dirEntries = await fs.readdir(path.join(tempDir, projectId));
    expect(dirEntries).toContain("settings.json");
    expect(dirEntries.some((name) => name.includes(".corrupted."))).toBe(false);
    expect(broadcastSpy).not.toHaveBeenCalled();

    const recovered = await manager.getProjectSettings(projectId);
    expect(recovered.runCommands).toHaveLength(1);
  });

  it("refuses a save over a file it can't read, even with the settings cached", async () => {
    const settingsPath = path.join(tempDir, projectId, "settings.json");
    const original = JSON.stringify({
      runCommands: [{ id: "npm-test", name: "test", command: "npm test" }],
      excludedPaths: ["generated"],
    });
    await fs.writeFile(settingsPath, original, "utf-8");
    await manager.getProjectSettings(projectId);

    const eio = Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
    const readSpy = vi.spyOn(fs, "readFile").mockRejectedValueOnce(eio);

    await expect(manager.saveProjectSettings(projectId, { runCommands: [] })).rejects.toBe(eio);
    readSpy.mockRestore();

    expect(await fs.readFile(settingsPath, "utf-8")).toBe(original);
  });

  it("still saves when there is no settings file yet", async () => {
    await manager.saveProjectSettings(projectId, { runCommands: [], excludedPaths: ["dist"] });

    const loaded = await manager.getProjectSettings(projectId);
    expect(loaded.excludedPaths).toEqual(["dist"]);
  });

  it("refuses to approve a browser host over a file it can't read", async () => {
    const settingsPath = path.join(tempDir, projectId, "settings.json");
    const original = JSON.stringify({
      runCommands: [{ id: "npm-test", name: "test", command: "npm test" }],
      browserAllowedHosts: ["example.com"],
    });
    await fs.writeFile(settingsPath, original, "utf-8");

    const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const readSpy = vi.spyOn(fs, "readFile").mockRejectedValueOnce(eacces);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(manager.addBrowserAllowedHost(projectId, "localhost")).rejects.toBe(eacces);
    readSpy.mockRestore();
    errorSpy.mockRestore();

    expect(await fs.readFile(settingsPath, "utf-8")).toBe(original);
    await expect(manager.addBrowserAllowedHost(projectId, "localhost")).resolves.toEqual([
      "example.com",
      "localhost",
    ]);
  });

  it("keeps other projects' notification overrides when one project's settings can't be read", async () => {
    const otherId = generateProjectId("/test/other");
    await fs.mkdir(path.join(tempDir, otherId), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, otherId, "settings.json"),
      JSON.stringify({ runCommands: [], notificationOverrides: { soundEnabled: true } }),
      "utf-8"
    );
    await fs.writeFile(
      path.join(tempDir, projectId, "settings.json"),
      JSON.stringify({ runCommands: [], notificationOverrides: { soundEnabled: false } }),
      "utf-8"
    );

    const realReadFile = fs.readFile;
    const readSpy = vi
      .spyOn(fs, "readFile")
      .mockImplementation(((
        file: Parameters<typeof fs.readFile>[0],
        options?: Parameters<typeof fs.readFile>[1]
      ) =>
        String(file).includes(projectId)
          ? Promise.reject(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }))
          : realReadFile(file, options)) as typeof fs.readFile);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const overrides = await manager.getProjectNotificationOverrides([projectId, otherId]);
    readSpy.mockRestore();
    errorSpy.mockRestore();

    expect(overrides).toEqual({ [otherId]: { soundEnabled: true } });
  });

  it.each(["EACCES", "EIO"])(
    "does not let a %s read failure turn into a save that erases the existing file",
    async (code) => {
      const settingsPath = path.join(tempDir, projectId, "settings.json");
      await fs.writeFile(
        settingsPath,
        JSON.stringify({
          runCommands: [{ id: "npm-test", name: "test", command: "npm test" }],
          excludedPaths: ["generated"],
        }),
        "utf-8"
      );

      const failure = Object.assign(new Error(`${code}: read failed`), { code });
      const readSpy = vi.spyOn(fs, "readFile").mockRejectedValueOnce(failure);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      let draft: Awaited<ReturnType<typeof manager.getProjectSettings>> | undefined;
      try {
        draft = await manager.getProjectSettings(projectId);
      } catch {
        draft = undefined;
      }
      readSpy.mockRestore();
      errorSpy.mockRestore();

      if (draft) {
        await manager.saveProjectSettings(projectId, { ...draft, devServerCommand: "npm run dev" });
      }

      const onDisk = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
      expect(onDisk.runCommands).toEqual([{ id: "npm-test", name: "test", command: "npm test" }]);
      expect(onDisk.excludedPaths).toEqual(["generated"]);
    }
  );

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

  it("never caches a read that overlapped a write", async () => {
    await manager.saveProjectSettings(projectId, {
      runCommands: [],
      devServerCommand: "npm start",
    });

    const save = manager.saveProjectSettings(projectId, {
      runCommands: [],
      devServerCommand: "pnpm dev",
    });
    const overlapping = manager.getProjectSettings(projectId);
    await Promise.all([save, overlapping]);

    expect((await manager.getProjectSettings(projectId)).devServerCommand).toBe("pnpm dev");
  });

  it("a read holding damaged bytes cannot quarantine a save that lands behind it (#13553)", async () => {
    const settingsPath = path.join(tempDir, projectId, "settings.json");
    await fs.writeFile(settingsPath, "{broken", "utf-8");

    const realReadFile = fs.readFile.bind(fs) as (p: string, enc: string) => Promise<string>;
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => (readStarted = resolve));
    let releaseRead!: () => void;
    const gate = new Promise<void>((resolve) => (releaseRead = resolve));
    let saveEntered!: () => void;
    const entered = new Promise<void>((resolve) => (saveEntered = resolve));
    let calls = 0;
    // The first read holds the damaged bytes until released; any later read is
    // the save starting its turn (it reads the saved allow-list first).
    const readSpy = vi.spyOn(fs, "readFile").mockImplementation((async (
      file: string,
      encoding: string
    ) => {
      calls += 1;
      if (calls === 1) {
        const content = await realReadFile(file, encoding);
        readStarted();
        await gate;
        return content;
      }
      saveEntered();
      return realReadFile(file, encoding);
    }) as unknown as typeof fs.readFile);

    let read: Promise<unknown> = Promise.resolve();
    let save: Promise<unknown> = Promise.resolve();
    try {
      read = manager.getProjectSettings(projectId);
      await started;
      save = manager.saveProjectSettings(projectId, {
        runCommands: [],
        devServerCommand: "npm run dev",
      });
      const saveRanFirst = await Promise.race([
        entered.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
      ]);
      expect(saveRanFirst).toBe(false);
    } finally {
      releaseRead();
      await Promise.allSettled([read, save]);
      readSpy.mockRestore();
    }
    await expect(save).resolves.toBeUndefined();

    const fresh = new ProjectSettingsManager(tempDir, createMockStore());
    expect((await fresh.getProjectSettings(projectId)).devServerCommand).toBe("npm run dev");
    const quarantined = (await fs.readdir(path.join(tempDir, projectId))).filter((name) =>
      name.startsWith("settings.json.corrupted.")
    );
    expect(quarantined).toHaveLength(1);
    expect(await fs.readFile(path.join(tempDir, projectId, quarantined[0]), "utf-8")).toBe(
      "{broken"
    );
  });

  it("a warm cache does not answer for a save that is queued but not yet written", async () => {
    await manager.saveProjectSettings(projectId, {
      runCommands: [],
      devServerCommand: "npm start",
    });
    expect((await manager.getProjectSettings(projectId)).devServerCommand).toBe("npm start");

    const save = manager.saveProjectSettings(projectId, {
      runCommands: [],
      devServerCommand: "pnpm dev",
    });
    const read = manager.getProjectSettings(projectId);

    expect((await read).devServerCommand).toBe("pnpm dev");
    await save;
  });

  it("adds a host over a damaged settings file without waiting on itself", async () => {
    await fs.writeFile(path.join(tempDir, projectId, "settings.json"), "{broken", "utf-8");

    await expect(manager.addBrowserAllowedHost(projectId, "example.com")).resolves.toEqual([
      "example.com",
    ]);
  });

  describe("notification overrides after a failed save", () => {
    const enospc = () =>
      Object.assign(new Error("ENOSPC: no space left on device"), {
        code: "ENOSPC",
      });

    beforeEach(() => {
      vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it.each([
      { saved: false, rejected: true },
      { saved: true, rejected: false },
    ])(
      "keeps completedEnabled=$saved in effect when saving $rejected fails",
      async ({ saved, rejected }) => {
        await manager.saveProjectSettings(projectId, {
          runCommands: [],
          notificationOverrides: { completedEnabled: saved },
        });
        await manager.getProjectSettings(projectId);

        vi.mocked(resilientAtomicWriteFile).mockRejectedValueOnce(enospc());
        await expect(
          manager.saveProjectSettings(projectId, {
            runCommands: [],
            notificationOverrides: { completedEnabled: rejected },
          })
        ).rejects.toThrow("ENOSPC");

        const onDisk = await new ProjectSettingsManager(
          tempDir,
          createMockStore()
        ).getProjectSettings(projectId);
        expect(onDisk.notificationOverrides?.completedEnabled).toBe(saved);
        expect(manager.getEffectiveNotificationSettings(projectId).completedEnabled).toBe(saved);
      }
    );

    it("keeps the global settings when the first save of a project fails", async () => {
      vi.mocked(resilientAtomicWriteFile).mockRejectedValueOnce(enospc());
      await expect(
        manager.saveProjectSettings(projectId, {
          runCommands: [],
          notificationOverrides: { completedEnabled: false },
        })
      ).rejects.toThrow("ENOSPC");

      expect(manager.getEffectiveNotificationSettings(projectId).completedEnabled).toBe(true);
    });

    it("publishes the overrides once a save lands after the directory is recreated", async () => {
      await fs.rm(path.join(tempDir, projectId), { recursive: true, force: true });
      vi.mocked(resilientAtomicWriteFile).mockClear();

      await manager.saveProjectSettings(projectId, {
        runCommands: [],
        notificationOverrides: { completedEnabled: false },
      });

      expect(resilientAtomicWriteFile).toHaveBeenCalledTimes(2);
      expect(manager.getEffectiveNotificationSettings(projectId).completedEnabled).toBe(false);
    });
  });

  describe("addBrowserAllowedHost", () => {
    const readFromDisk = () =>
      new ProjectSettingsManager(tempDir, createMockStore()).getProjectSettings(projectId);

    it("merges the host into the settings on disk", async () => {
      await manager.saveProjectSettings(projectId, {
        runCommands: [{ id: "npm-dev", name: "dev", command: "npm run dev" }],
        devServerCommand: "npm run dev",
        browserAllowedHosts: ["internal.corp.test"],
      });

      const hosts = await manager.addBrowserAllowedHost(projectId, "example.com");

      expect(hosts).toEqual(["internal.corp.test", "example.com"]);
      const saved = await readFromDisk();
      expect(saved.browserAllowedHosts).toEqual(["internal.corp.test", "example.com"]);
      expect(saved.devServerCommand).toBe("npm run dev");
      expect(saved.runCommands).toHaveLength(1);
    });

    it("keeps a write that lands while the host is being added", async () => {
      await manager.saveProjectSettings(projectId, {
        runCommands: [],
        devServerCommand: "npm start",
      });
      // Warm the cache with the settings as they were before the next write.
      await manager.getProjectSettings(projectId);

      const save = manager.saveProjectSettings(projectId, {
        runCommands: [],
        devServerCommand: "pnpm dev",
      });
      const add = manager.addBrowserAllowedHost(projectId, "example.com");
      await Promise.all([save, add]);

      const saved = await readFromDisk();
      expect(saved.devServerCommand).toBe("pnpm dev");
      expect(saved.browserAllowedHosts).toEqual(["example.com"]);
    });

    it("keeps the host through a save built from a copy read before the approval", async () => {
      await manager.saveProjectSettings(projectId, {
        runCommands: [],
        devServerCommand: "npm start",
      });
      // Another settings control holds this copy, which predates the approval.
      const copyBeforeApproval = await manager.getProjectSettings(projectId);

      const add = manager.addBrowserAllowedHost(projectId, "example.com");
      const staleSave = manager.saveProjectSettings(projectId, {
        ...copyBeforeApproval,
        devServerCommand: "pnpm dev",
      });
      await Promise.all([add, staleSave]);

      const saved = await readFromDisk();
      expect(saved.devServerCommand).toBe("pnpm dev");
      expect(saved.browserAllowedHosts).toEqual(["example.com"]);
    });

    it("lets a whole save add hosts, keeping the ones already saved", async () => {
      await manager.addBrowserAllowedHost(projectId, "example.com");

      await manager.saveProjectSettings(projectId, {
        runCommands: [],
        browserAllowedHosts: ["EXAMPLE.com", "docs.example"],
      });

      expect((await readFromDisk()).browserAllowedHosts).toEqual(["example.com", "docs.example"]);
    });

    it("keeps every host when several are added at once", async () => {
      await Promise.all([
        manager.addBrowserAllowedHost(projectId, "a.example"),
        manager.addBrowserAllowedHost(projectId, "b.example"),
        manager.addBrowserAllowedHost(projectId, "c.example"),
      ]);

      expect((await readFromDisk()).browserAllowedHosts).toEqual([
        "a.example",
        "b.example",
        "c.example",
      ]);
    });

    it("returns the list unchanged when the host is already allowed", async () => {
      await manager.saveProjectSettings(projectId, {
        runCommands: [],
        browserAllowedHosts: ["Example.com"],
      });

      expect(await manager.addBrowserAllowedHost(projectId, "example.com")).toEqual([
        "Example.com",
      ]);
      expect((await readFromDisk()).browserAllowedHosts).toEqual(["Example.com"]);
    });
  });
});
