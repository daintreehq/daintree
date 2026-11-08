import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ProjectSettingsManager } from "../ProjectSettingsManager.js";
import { generateProjectId } from "../projectStorePaths.js";
import { resilientAtomicWriteFile } from "../../utils/fs.js";

vi.mock("../../utils/fs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/fs.js")>();
  return { ...actual, resilientAtomicWriteFile: vi.fn(actual.resilientAtomicWriteFile) };
});

const storeState = vi.hoisted(() => ({ projectEnv: {} as unknown }));

// The real secure storage runs over this store, so the counts below are the
// config.json reads and rewrites one settings read or save costs.
const storeMock = vi.hoisted(() => ({
  get: vi.fn((key: string) => (key === "projectEnv" ? storeState.projectEnv : undefined)),
  set: vi.fn((key: string, value: unknown) => {
    if (key === "projectEnv") storeState.projectEnv = value;
  }),
}));

vi.mock("../../store.js", () => ({ store: storeMock }));

function projectEnvWrites(): number {
  return storeMock.set.mock.calls.filter(([key]) => key === "projectEnv").length;
}

function projectEnvReads(): number {
  return storeMock.get.mock.calls.filter(([key]) => key === "projectEnv").length;
}

describe("ProjectSettingsManager secure env storage costs", () => {
  let tempDir: string;
  let manager: ProjectSettingsManager;
  let projectId: string;
  let settingsPath: string;

  beforeEach(async () => {
    storeState.projectEnv = {};
    vi.clearAllMocks();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-secure-env-"));
    manager = new ProjectSettingsManager(
      tempDir,
      storeMock as unknown as ConstructorParameters<typeof ProjectSettingsManager>[1]
    );
    projectId = generateProjectId("/test/project");
    await fs.mkdir(path.join(tempDir, projectId), { recursive: true });
    settingsPath = path.join(tempDir, projectId, "settings.json");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function readSettingsFile(): Promise<Record<string, unknown>> {
    return JSON.parse(await fs.readFile(settingsPath, "utf-8"));
  }

  describe("saving", () => {
    it("stores every new secure variable in one write", async () => {
      await manager.saveProjectSettings(projectId, {
        runCommands: [],
        environmentVariables: { A_TOKEN: "a", B_TOKEN: "b", C_TOKEN: "c", PLAIN: "visible" },
      });

      expect(projectEnvWrites()).toBe(1);
      expect(storeState.projectEnv).toEqual({
        [`${projectId}:A_TOKEN`]: "a",
        [`${projectId}:B_TOKEN`]: "b",
        [`${projectId}:C_TOKEN`]: "c",
      });
      const onDisk = await readSettingsFile();
      expect(onDisk.environmentVariables).toEqual({ PLAIN: "visible" });
      expect(onDisk.secureEnvironmentVariables).toEqual(["A_TOKEN", "B_TOKEN", "C_TOKEN"]);
    });

    it("writes nothing when the secure values are unchanged", async () => {
      storeState.projectEnv = { [`${projectId}:A_TOKEN`]: "a", [`${projectId}:B_TOKEN`]: "b" };

      await manager.saveProjectSettings(projectId, {
        runCommands: [],
        environmentVariables: { A_TOKEN: "a", B_TOKEN: "b" },
      });

      expect(projectEnvWrites()).toBe(0);
      expect((await readSettingsFile()).secureEnvironmentVariables).toEqual(["A_TOKEN", "B_TOKEN"]);
    });

    it("writes nothing for a project with no secure variables", async () => {
      await manager.saveProjectSettings(projectId, {
        runCommands: [],
        environmentVariables: { PLAIN: "visible" },
      });

      expect(projectEnvWrites()).toBe(0);
    });

    it("writes once when a single value changes", async () => {
      storeState.projectEnv = { [`${projectId}:A_TOKEN`]: "a", [`${projectId}:B_TOKEN`]: "b" };

      await manager.saveProjectSettings(projectId, {
        runCommands: [],
        environmentVariables: { A_TOKEN: "a", B_TOKEN: "changed" },
      });

      expect(projectEnvWrites()).toBe(1);
      expect(storeState.projectEnv).toEqual({
        [`${projectId}:A_TOKEN`]: "a",
        [`${projectId}:B_TOKEN`]: "changed",
      });
    });

    it("treats a value blanked out as a change, and a stored blank as unchanged", async () => {
      storeState.projectEnv = { [`${projectId}:A_TOKEN`]: "a", [`${projectId}:B_TOKEN`]: "" };

      await manager.saveProjectSettings(projectId, {
        runCommands: [],
        environmentVariables: { A_TOKEN: "a", B_TOKEN: "" },
      });
      expect(projectEnvWrites()).toBe(0);

      await manager.saveProjectSettings(projectId, {
        runCommands: [],
        environmentVariables: { A_TOKEN: "", B_TOKEN: "" },
      });
      expect(projectEnvWrites()).toBe(1);
      expect(storeState.projectEnv).toEqual({
        [`${projectId}:A_TOKEN`]: "",
        [`${projectId}:B_TOKEN`]: "",
      });
    });

    it("removes every key that stopped being secure in the one write that also sets values", async () => {
      storeState.projectEnv = {
        [`${projectId}:OLD_TOKEN`]: "old",
        [`${projectId}:OTHER_SECRET`]: "other",
        [`${projectId}:KEPT_TOKEN`]: "kept",
        "another-project:OLD_TOKEN": "theirs",
      };

      await manager.saveProjectSettings(projectId, {
        runCommands: [],
        environmentVariables: { KEPT_TOKEN: "kept", NEW_TOKEN: "new" },
      });

      expect(projectEnvWrites()).toBe(1);
      expect(storeState.projectEnv).toEqual({
        [`${projectId}:KEPT_TOKEN`]: "kept",
        [`${projectId}:NEW_TOKEN`]: "new",
        "another-project:OLD_TOKEN": "theirs",
      });
    });

    it("removes keys in one write when only removals are needed", async () => {
      storeState.projectEnv = { [`${projectId}:A_TOKEN`]: "a", [`${projectId}:B_TOKEN`]: "b" };

      await manager.saveProjectSettings(projectId, { runCommands: [], environmentVariables: {} });

      expect(projectEnvWrites()).toBe(1);
      expect(storeState.projectEnv).toEqual({});
    });

    it("keeps the stored value of a key the save lists as unresolved", async () => {
      storeState.projectEnv = { [`${projectId}:RESTORED_TOKEN`]: "restored" };

      await manager.saveProjectSettings(projectId, {
        runCommands: [],
        environmentVariables: {},
        unresolvedSecureEnvironmentVariables: ["RESTORED_TOKEN"],
      });

      expect(projectEnvWrites()).toBe(0);
      expect((await readSettingsFile()).secureEnvironmentVariables).toEqual(["RESTORED_TOKEN"]);
    });

    it("leaves the map and settings.json untouched when the one write fails", async () => {
      storeState.projectEnv = { [`${projectId}:OLD_TOKEN`]: "old" };
      await fs.writeFile(settingsPath, JSON.stringify({ runCommands: [] }), "utf-8");
      const before = await fs.readFile(settingsPath, "utf-8");
      vi.spyOn(console, "error").mockImplementation(() => {});
      storeMock.set.mockImplementationOnce(() => {
        throw new Error("disk full");
      });

      await expect(
        manager.saveProjectSettings(projectId, {
          runCommands: [],
          environmentVariables: { A_TOKEN: "a", B_TOKEN: "b" },
        })
      ).rejects.toThrow("disk full");

      expect(projectEnvWrites()).toBe(1);
      expect(storeState.projectEnv).toEqual({ [`${projectId}:OLD_TOKEN`]: "old" });
      expect(await fs.readFile(settingsPath, "utf-8")).toBe(before);
    });

    it("stores the secure values before settings.json, which can then fail on its own", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(resilientAtomicWriteFile).mockRejectedValueOnce(new Error("disk full"));

      await expect(
        manager.saveProjectSettings(projectId, {
          runCommands: [],
          environmentVariables: { A_TOKEN: "a" },
        })
      ).rejects.toThrow("disk full");

      expect(storeState.projectEnv).toEqual({ [`${projectId}:A_TOKEN`]: "a" });
    });

    it("costs no write when a single-field update leaves the secure values alone", async () => {
      storeState.projectEnv = { [`${projectId}:A_TOKEN`]: "a", [`${projectId}:B_TOKEN`]: "b" };
      await fs.writeFile(
        settingsPath,
        JSON.stringify({
          runCommands: [],
          secureEnvironmentVariables: ["A_TOKEN", "B_TOKEN"],
        }),
        "utf-8"
      );

      await manager.addBrowserAllowedHost(projectId, "example.com");

      expect(projectEnvWrites()).toBe(0);
      const onDisk = await readSettingsFile();
      expect(onDisk.browserAllowedHosts).toEqual(["example.com"]);
      expect(onDisk.secureEnvironmentVariables).toEqual(["A_TOKEN", "B_TOKEN"]);
    });
  });

  describe("reading", () => {
    it("resolves all secure keys from one read of the map", async () => {
      storeState.projectEnv = {
        [`${projectId}:A_TOKEN`]: "a",
        [`${projectId}:B_TOKEN`]: "",
        "another-project:C_TOKEN": "theirs",
      };
      await fs.writeFile(
        settingsPath,
        JSON.stringify({
          runCommands: [],
          environmentVariables: { PLAIN: "visible" },
          secureEnvironmentVariables: ["A_TOKEN", "B_TOKEN", "C_TOKEN", "D_TOKEN"],
        }),
        "utf-8"
      );

      const loaded = await manager.getProjectSettings(projectId);

      expect(projectEnvReads()).toBe(1);
      expect(loaded.environmentVariables).toEqual({ PLAIN: "visible", A_TOKEN: "a", B_TOKEN: "" });
      expect(loaded.unresolvedSecureEnvironmentVariables).toEqual(["C_TOKEN", "D_TOKEN"]);
    });

    it("does not read the map for settings with no secure keys", async () => {
      await fs.writeFile(
        settingsPath,
        JSON.stringify({ runCommands: [], environmentVariables: { PLAIN: "visible" } }),
        "utf-8"
      );

      await manager.getProjectSettings(projectId);

      expect(projectEnvReads()).toBe(0);
    });

    it("reports a secure key named like an Object member as unresolved", async () => {
      await fs.writeFile(
        settingsPath,
        JSON.stringify({ runCommands: [], secureEnvironmentVariables: ["constructor"] }),
        "utf-8"
      );

      const loaded = await manager.getProjectSettings(projectId);

      expect(loaded.unresolvedSecureEnvironmentVariables).toEqual(["constructor"]);
    });

    it("reads back what a save stored", async () => {
      await manager.saveProjectSettings(projectId, {
        runCommands: [],
        environmentVariables: { A_TOKEN: "a", PLAIN: "visible" },
      });

      const loaded = await manager.getProjectSettings(projectId);

      expect(loaded.environmentVariables).toEqual({ PLAIN: "visible", A_TOKEN: "a" });
      expect(loaded.secureEnvironmentVariables).toEqual(["A_TOKEN"]);
      expect(loaded.unresolvedSecureEnvironmentVariables).toBeUndefined();
    });
  });
});
