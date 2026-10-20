import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSettings, RunCommand } from "@shared/types";

const { getSettingsMock, detectRunnersMock } = vi.hoisted(() => ({
  getSettingsMock: vi.fn(),
  detectRunnersMock: vi.fn(),
}));

vi.mock("@/clients", () => ({
  projectClient: {
    getSettings: getSettingsMock,
    detectRunners: detectRunnersMock,
  },
}));

import {
  cleanupProjectSettingsStore,
  patchCachedProjectSettings,
  prePopulateProjectSettings,
  useProjectSettingsStore,
} from "../projectSettingsStore";

function createDeferred<T>() {
  let resolve: (value: T) => void;
  let reject: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve: resolve!, reject: reject! };
}

const SETTINGS_WITH_COMMANDS: ProjectSettings = {
  runCommands: [
    { id: "cmd-dev", name: "Dev", command: "npm run dev" },
    { id: "cmd-test", name: "Test", command: "npm test" },
  ],
};

const DETECTED_RUNNERS: RunCommand[] = [
  { id: "det-1", name: "Dev", command: "npm run dev" },
  { id: "det-2", name: "Build", command: "npm run build" },
];

describe("projectSettingsStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanupProjectSettingsStore();
  });

  it("loads settings and filters out already-saved detected runners", async () => {
    getSettingsMock.mockResolvedValueOnce(SETTINGS_WITH_COMMANDS);
    detectRunnersMock.mockResolvedValueOnce(DETECTED_RUNNERS);

    await useProjectSettingsStore.getState().loadSettings("project-a");

    const state = useProjectSettingsStore.getState();
    expect(state.settings).toEqual(SETTINGS_WITH_COMMANDS);
    expect(state.allDetectedRunners).toEqual(DETECTED_RUNNERS);
    expect(state.detectedRunners).toEqual([
      { id: "det-2", name: "Build", command: "npm run build" },
    ]);
    expect(state.isLoading).toBe(false);
    expect(state.error).toBeNull();
  });

  it("ignores stale responses when project switches mid-flight", async () => {
    const firstSettings = createDeferred<ProjectSettings>();
    const firstDetect = createDeferred<RunCommand[]>();
    const secondSettings = createDeferred<ProjectSettings>();
    const secondDetect = createDeferred<RunCommand[]>();

    getSettingsMock
      .mockReturnValueOnce(firstSettings.promise)
      .mockReturnValueOnce(secondSettings.promise);
    detectRunnersMock
      .mockReturnValueOnce(firstDetect.promise)
      .mockReturnValueOnce(secondDetect.promise);

    const firstLoad = useProjectSettingsStore.getState().loadSettings("project-a");
    const secondLoad = useProjectSettingsStore.getState().loadSettings("project-b");

    firstSettings.resolve(SETTINGS_WITH_COMMANDS);
    firstDetect.resolve(DETECTED_RUNNERS);

    secondSettings.resolve({
      runCommands: [{ id: "cmd-lint", name: "Lint", command: "npm run lint" }],
    });
    secondDetect.resolve([{ id: "det-lint", name: "Lint", command: "npm run lint" }]);

    await Promise.all([firstLoad, secondLoad]);

    const state = useProjectSettingsStore.getState();
    expect(state.projectId).toBe("project-b");
    expect(state.settings).toEqual({
      runCommands: [{ id: "cmd-lint", name: "Lint", command: "npm run lint" }],
    });
    expect(state.detectedRunners).toEqual([]);
    expect(state.isLoading).toBe(false);
  });

  it("leaves nothing to edit or save when the first load fails", async () => {
    getSettingsMock.mockRejectedValueOnce(new Error("boom"));
    detectRunnersMock.mockResolvedValueOnce(DETECTED_RUNNERS);

    await useProjectSettingsStore.getState().loadSettings("project-fail");

    const state = useProjectSettingsStore.getState();
    expect(state.projectId).toBe("project-fail");
    expect(state.settings).toBeNull();
    expect(state.detectedRunners).toEqual([]);
    expect(state.allDetectedRunners).toEqual([]);
    expect(state.error).toBe("boom");
    expect(state.isLoading).toBe(false);
  });

  it("refreshes runners detected empty before the project was scaffolded", async () => {
    getSettingsMock.mockResolvedValue({ runCommands: [] });
    detectRunnersMock.mockResolvedValueOnce([]);
    await useProjectSettingsStore.getState().loadSettings("project-scaffold");
    expect(useProjectSettingsStore.getState().allDetectedRunners).toEqual([]);

    // Switching away and back re-hydrates the view from the snapshot cache.
    cleanupProjectSettingsStore();
    prePopulateProjectSettings("project-scaffold");

    const deferred = createDeferred<RunCommand[]>();
    detectRunnersMock.mockReturnValueOnce(deferred.promise);
    const refresh = useProjectSettingsStore.getState().loadSettings("project-scaffold");

    // Revalidating keeps the cached settings up rather than flashing a load.
    expect(useProjectSettingsStore.getState().isLoading).toBe(false);

    deferred.resolve(DETECTED_RUNNERS);
    await refresh;
    expect(useProjectSettingsStore.getState().allDetectedRunners).toEqual(DETECTED_RUNNERS);

    cleanupProjectSettingsStore();
    prePopulateProjectSettings("project-scaffold");
    expect(useProjectSettingsStore.getState().allDetectedRunners).toEqual(DETECTED_RUNNERS);
  });

  it("keeps a save made while a revalidation was in flight", async () => {
    useProjectSettingsStore.setState({
      settings: { runCommands: [] },
      projectId: "project-save",
      isLoading: false,
    });
    const detected = createDeferred<RunCommand[]>();
    getSettingsMock.mockResolvedValueOnce({ runCommands: [] });
    detectRunnersMock.mockReturnValueOnce(detected.promise);

    const refresh = useProjectSettingsStore.getState().loadSettings("project-save");
    useProjectSettingsStore.getState().setSettings(SETTINGS_WITH_COMMANDS);
    detected.resolve(DETECTED_RUNNERS);
    await refresh;

    const state = useProjectSettingsStore.getState();
    expect(state.settings).toEqual(SETTINGS_WITH_COMMANDS);
    expect(state.allDetectedRunners).toEqual(DETECTED_RUNNERS);
    expect(state.detectedRunners).toEqual([
      { id: "det-2", name: "Build", command: "npm run build" },
    ]);
  });

  it("applies only the newest of overlapping revalidations", async () => {
    useProjectSettingsStore.setState({
      settings: { runCommands: [] },
      projectId: "project-overlap",
      isLoading: false,
    });
    const older = createDeferred<RunCommand[]>();
    const newer = createDeferred<RunCommand[]>();
    getSettingsMock.mockResolvedValue({ runCommands: [] });
    detectRunnersMock.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);

    const first = useProjectSettingsStore.getState().loadSettings("project-overlap");
    const second = useProjectSettingsStore.getState().loadSettings("project-overlap");
    newer.resolve(DETECTED_RUNNERS);
    await second;
    older.resolve([]);
    await first;

    expect(useProjectSettingsStore.getState().allDetectedRunners).toEqual(DETECTED_RUNNERS);
  });

  it("keeps cached settings when a revalidation fails", async () => {
    useProjectSettingsStore.setState({
      settings: SETTINGS_WITH_COMMANDS,
      allDetectedRunners: DETECTED_RUNNERS,
      projectId: "project-flaky",
      isLoading: false,
    });
    getSettingsMock.mockRejectedValueOnce(new Error("boom"));
    detectRunnersMock.mockResolvedValueOnce([]);

    await useProjectSettingsStore.getState().loadSettings("project-flaky");

    const state = useProjectSettingsStore.getState();
    expect(state.settings).toEqual(SETTINGS_WITH_COMMANDS);
    expect(state.allDetectedRunners).toEqual(DETECTED_RUNNERS);
    expect(state.error).toBe("boom");
    expect(state.isLoading).toBe(false);
  });

  it("does not carry another project's settings through a failed load", async () => {
    useProjectSettingsStore.setState({
      settings: SETTINGS_WITH_COMMANDS,
      allDetectedRunners: DETECTED_RUNNERS,
      projectId: "project-a",
      isLoading: false,
    });
    getSettingsMock.mockRejectedValueOnce(new Error("boom"));
    detectRunnersMock.mockResolvedValueOnce([]);

    await useProjectSettingsStore.getState().loadSettings("project-b");

    const state = useProjectSettingsStore.getState();
    expect(state.projectId).toBe("project-b");
    expect(state.settings).toBeNull();
    expect(state.allDetectedRunners).toEqual([]);
    expect(state.error).toBe("boom");
  });

  it("recomputes detected runners when settings are updated", () => {
    useProjectSettingsStore.setState({
      allDetectedRunners: DETECTED_RUNNERS,
      detectedRunners: DETECTED_RUNNERS,
      settings: { runCommands: [] },
      projectId: "project-a",
      isLoading: false,
      error: "old-error",
    });

    useProjectSettingsStore.getState().setSettings(SETTINGS_WITH_COMMANDS);

    const state = useProjectSettingsStore.getState();
    expect(state.error).toBeNull();
    expect(state.detectedRunners).toEqual([
      { id: "det-2", name: "Build", command: "npm run build" },
    ]);
  });

  describe("patchCachedProjectSettings", () => {
    it("merges the patch into the cached settings, preserving unrelated fields", () => {
      useProjectSettingsStore.setState({
        settings: { ...SETTINGS_WITH_COMMANDS, devServerCommand: "npm run dev" },
        projectId: "project-a",
        allDetectedRunners: DETECTED_RUNNERS,
        detectedRunners: [DETECTED_RUNNERS[1]!],
      });

      patchCachedProjectSettings("project-a", { preferredEditor: { id: "zed" } });

      const state = useProjectSettingsStore.getState();
      expect(state.settings?.preferredEditor).toEqual({ id: "zed" });
      expect(state.settings?.devServerCommand).toBe("npm run dev");
      expect(state.settings?.runCommands).toHaveLength(2);
      // setSettings recomputes these from allDetectedRunners; a preference-only
      // patch must not drop a runner that is still undetected-and-unsaved.
      expect(state.detectedRunners).toEqual([DETECTED_RUNNERS[1]]);
    });

    it("ignores a patch for a project the store no longer holds", () => {
      useProjectSettingsStore.setState({
        settings: SETTINGS_WITH_COMMANDS,
        projectId: "project-a",
      });

      patchCachedProjectSettings("project-b", { preferredEditor: { id: "zed" } });

      expect(useProjectSettingsStore.getState().settings?.preferredEditor).toBeUndefined();
    });

    it("ignores a patch when no settings are cached", () => {
      useProjectSettingsStore.setState({ settings: null, projectId: "project-a" });

      patchCachedProjectSettings("project-a", { preferredEditor: { id: "zed" } });

      expect(useProjectSettingsStore.getState().settings).toBeNull();
    });

    it("applies a patch made during the initial load once that load lands", async () => {
      // The load read the settings before the write the patch records.
      const settingsRead = createDeferred<ProjectSettings>();
      getSettingsMock.mockReturnValueOnce(settingsRead.promise);
      detectRunnersMock.mockResolvedValueOnce(DETECTED_RUNNERS);
      const load = useProjectSettingsStore.getState().loadSettings("project-a");

      patchCachedProjectSettings("project-a", { browserAllowedHosts: ["example.com"] });
      settingsRead.resolve(SETTINGS_WITH_COMMANDS);
      await load;

      const state = useProjectSettingsStore.getState();
      expect(state.settings).toEqual({
        ...SETTINGS_WITH_COMMANDS,
        browserAllowedHosts: ["example.com"],
      });
      expect(state.detectedRunners).toEqual([DETECTED_RUNNERS[1]]);
    });

    it("leaves a load that started after the patch with what it read", async () => {
      useProjectSettingsStore.setState({ settings: null, projectId: "project-a" });
      patchCachedProjectSettings("project-a", { browserAllowedHosts: ["example.com"] });

      getSettingsMock.mockResolvedValueOnce({
        ...SETTINGS_WITH_COMMANDS,
        browserAllowedHosts: ["example.com", "later.test"],
      });
      detectRunnersMock.mockResolvedValueOnce([]);
      await useProjectSettingsStore.getState().loadSettings("project-a");

      expect(useProjectSettingsStore.getState().settings?.browserAllowedHosts).toEqual([
        "example.com",
        "later.test",
      ]);
    });
  });

  it("keeps approved hosts through settings saved from a copy that predates them", () => {
    useProjectSettingsStore.setState({
      projectId: "project-a",
      settings: { runCommands: [], browserAllowedHosts: ["example.com"] },
    });

    // A settings control saving the copy it read before the approval landed.
    useProjectSettingsStore.getState().setSettings({
      runCommands: [],
      devServerCommand: "pnpm dev",
    });

    expect(useProjectSettingsStore.getState().settings).toEqual({
      runCommands: [],
      devServerCommand: "pnpm dev",
      browserAllowedHosts: ["example.com"],
    });
  });
});
