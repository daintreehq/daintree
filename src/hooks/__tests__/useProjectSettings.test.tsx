// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSettings, RunCommand } from "@/types";

const { getSettingsMock, detectRunnersMock, saveSettingsMock } = vi.hoisted(() => ({
  getSettingsMock: vi.fn(),
  detectRunnersMock: vi.fn(),
  saveSettingsMock: vi.fn().mockResolvedValue(undefined),
}));

const { projectState, projectSettingsState, useProjectStoreMock, useProjectSettingsStoreMock } =
  vi.hoisted(() => {
    const projectState = {
      currentProject: { id: "project-current" },
    };

    const projectSettingsState = {
      settings: null as ProjectSettings | null,
      detectedRunners: [] as RunCommand[],
      allDetectedRunners: [] as RunCommand[],
      projectId: null as string | null,
      isLoading: false,
      error: null as string | null,
      loadSettings: vi.fn(),
      setSettings: vi.fn(),
    };

    const useProjectStoreMock = vi.fn((selector: (s: typeof projectState) => unknown) =>
      selector(projectState)
    );

    const storeFn = vi.fn((selector: (s: typeof projectSettingsState) => unknown) =>
      selector(projectSettingsState)
    );
    const useProjectSettingsStoreMock = Object.assign(storeFn, {
      getState: () => projectSettingsState,
    });

    return { projectState, projectSettingsState, useProjectStoreMock, useProjectSettingsStoreMock };
  });

vi.mock("@/clients", () => ({
  projectClient: {
    getSettings: getSettingsMock,
    detectRunners: detectRunnersMock,
    saveSettings: saveSettingsMock,
  },
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: useProjectStoreMock,
}));

vi.mock("@/store/projectSettingsStore", () => ({
  useProjectSettingsStore: useProjectSettingsStoreMock,
}));

import { useProjectSettings } from "../useProjectSettings";

describe("useProjectSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectState.currentProject = { id: "project-current" };
    projectSettingsState.settings = null;
    projectSettingsState.detectedRunners = [];
    projectSettingsState.allDetectedRunners = [];
    projectSettingsState.projectId = null;
    projectSettingsState.isLoading = false;
    projectSettingsState.error = null;
  });

  it("uses the latest detected runner list when saving local project settings", async () => {
    const cmdA: RunCommand = { id: "a", name: "A", command: "npm run a" };
    const cmdB: RunCommand = { id: "b", name: "B", command: "npm run b" };

    getSettingsMock
      .mockResolvedValueOnce({ runCommands: [] })
      .mockResolvedValueOnce({ runCommands: [] });
    detectRunnersMock.mockResolvedValueOnce([cmdA]).mockResolvedValueOnce([cmdA, cmdB]);

    const { result } = renderHook(() => useProjectSettings("project-other"));

    await waitFor(() => {
      expect(result.current.allDetectedRunners).toHaveLength(1);
    });

    await act(async () => {
      await result.current.refresh();
    });

    await waitFor(() => {
      expect(result.current.allDetectedRunners).toHaveLength(2);
    });

    await act(async () => {
      await result.current.saveSettings({
        runCommands: [cmdA],
      });
    });

    expect(saveSettingsMock).toHaveBeenCalledWith("project-other", { runCommands: [cmdA] });
    expect(result.current.detectedRunners).toEqual([cmdB]);
  });

  it("exposes no settings for another project whose load failed, until a retry succeeds", async () => {
    const saved: ProjectSettings = {
      runCommands: [{ id: "t", name: "test", command: "npm test" }],
      excludedPaths: ["generated"],
    };
    getSettingsMock
      .mockRejectedValueOnce(new Error("EACCES: permission denied"))
      .mockResolvedValueOnce(saved);
    detectRunnersMock.mockResolvedValue([]);

    const { result } = renderHook(() => useProjectSettings("project-other"));

    await waitFor(() => {
      expect(result.current.error).toBe("EACCES: permission denied");
    });
    expect(result.current.settings).toBeNull();

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.settings).toEqual(saved);
    expect(result.current.error).toBeNull();
  });
});
