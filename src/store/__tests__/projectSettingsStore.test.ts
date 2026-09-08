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

  it("recovers with safe defaults when loading fails", async () => {
    getSettingsMock.mockRejectedValueOnce(new Error("boom"));
    detectRunnersMock.mockResolvedValueOnce(DETECTED_RUNNERS);

    await useProjectSettingsStore.getState().loadSettings("project-fail");

    const state = useProjectSettingsStore.getState();
    expect(state.projectId).toBe("project-fail");
    expect(state.settings).toEqual({ runCommands: [] });
    expect(state.detectedRunners).toEqual([]);
    expect(state.allDetectedRunners).toEqual([]);
    expect(state.error).toBe("boom");
    expect(state.isLoading).toBe(false);
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
  });
});
