// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSettings } from "@/types";

const {
  mockSettings,
  mockSaveSettings,
  mockUpdateProject,
  mockEnableInRepoSettings,
  mockDisableInRepoSettings,
  mockProjects,
} = vi.hoisted(() => ({
  mockSettings: { value: null as ProjectSettings | null },
  mockSaveSettings: vi.fn().mockResolvedValue(undefined),
  mockUpdateProject: vi.fn().mockResolvedValue(undefined),
  mockEnableInRepoSettings: vi.fn(),
  mockDisableInRepoSettings: vi.fn(),
  mockProjects: {
    value: [
      { id: "proj-1", name: "Test Project", emoji: "🌲", color: undefined, path: "/test" },
    ] as Array<{
      id: string;
      name: string;
      emoji: string;
      color: string | undefined;
      path: string;
    }>,
  },
}));

vi.mock("@/hooks/useProjectSettings", () => ({
  useProjectSettings: () => ({
    settings: mockSettings.value,
    saveSettings: mockSaveSettings,
    isLoading: false,
    error: null,
  }),
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: () => ({
    projects: mockProjects.value,
    updateProject: mockUpdateProject,
    enableInRepoSettings: mockEnableInRepoSettings,
    disableInRepoSettings: mockDisableInRepoSettings,
  }),
}));

vi.mock("@/hooks/useWorktrees", () => ({
  useWorktrees: () => ({
    worktrees: [],
    worktreeMap: new Map(),
  }),
}));

vi.mock("@/store/recipeStore", () => ({
  useRecipeStore: () => ({ recipes: [], isLoading: false }),
}));

import { useProjectSettingsForm } from "../useProjectSettingsForm";

const baseSettings: ProjectSettings = {
  runCommands: [{ id: "rc-1", name: "Dev", command: "npm run dev" }],
  environmentVariables: { NODE_ENV: "development" },
  excludedPaths: ["node_modules"],
  projectIconSvg: undefined,
  defaultWorktreeRecipeId: undefined,
  devServerCommand: "npm run dev",
  devServerLoadTimeout: 5000,
  commandOverrides: [],
  copyTreeSettings: {},
  branchPrefixMode: "username",
  branchPrefixCustom: "gpriday",
  worktreePathPattern: "",
  terminalSettings: { shell: "/bin/zsh", shellArgs: ["-l"] },
  notificationOverrides: { soundEnabled: true },
  githubRemote: "origin",
};

function resetMocks() {
  mockSettings.value = null;
  mockProjects.value = [
    { id: "proj-1", name: "Test Project", emoji: "🌲", color: undefined, path: "/test" },
  ];
}

// Mirror the real lifecycle: dialog opens while settings are still null (loading),
// then settings arrive. This avoids the mount-time race between init and reset effects
// (the reset effect fires on isOpen change, then the init effect fires when settings arrive).
interface FormProps {
  isOpen: boolean;
  tick: number;
  projectId: string;
}

function renderOpenForm(projectId = "proj-1") {
  // Step 1: Render closed with no settings (mimics real dialog mount)
  const hook = renderHook(
    ({ isOpen, tick, projectId }: FormProps) => useProjectSettingsForm({ projectId, isOpen }),
    { initialProps: { isOpen: false, tick: 0, projectId } }
  );

  // Step 2: Open the dialog (settings still null — reset effect fires, init skips)
  hook.rerender({ isOpen: true, tick: 1, projectId });

  // Step 3: Settings "arrive" — update mock and force re-render with tick change
  mockSettings.value = baseSettings;
  hook.rerender({ isOpen: true, tick: 2, projectId });

  return hook;
}

describe("useProjectSettingsForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMocks();
  });

  it("stays uninitialized when isOpen is false", () => {
    mockSettings.value = baseSettings;
    const { result } = renderHook(() =>
      useProjectSettingsForm({ projectId: "proj-1", isOpen: false })
    );
    expect(result.current.projectIsInitialized).toBe(false);
    expect(result.current.projectName).toBe("");
  });

  it("initializes all state from projectSettings when dialog opens", async () => {
    const { result } = renderOpenForm("proj-1");
    await waitFor(() => {
      expect(result.current.projectIsInitialized).toBe(true);
    });
    expect(result.current.projectName).toBe("Test Project");
    expect(result.current.projectEmoji).toBe("🌲");
    expect(result.current.devServerCommand).toBe("npm run dev");
    expect(result.current.devServerLoadTimeout).toBe(5000);
    expect(result.current.branchPrefixMode).toBe("username");
    expect(result.current.branchPrefixCustom).toBe("gpriday");
    expect(result.current.terminalShell).toBe("/bin/zsh");
    expect(result.current.terminalShellArgs).toBe("-l");
    expect(result.current.githubRemote).toBe("origin");
    expect(result.current.runCommands).toHaveLength(1);
    expect(result.current.environmentVariables).toHaveLength(1);
    expect(result.current.environmentVariables[0].key).toBe("NODE_ENV");
    expect(result.current.excludedPaths).toEqual(["node_modules"]);
  });

  it("resets state when dialog closes", async () => {
    const { result, rerender } = renderOpenForm("proj-1");
    await waitFor(() => {
      expect(result.current.projectIsInitialized).toBe(true);
    });

    rerender({ isOpen: false, tick: 3, projectId: "proj-1" });
    await waitFor(() => {
      expect(result.current.projectIsInitialized).toBe(false);
    });
    expect(result.current.devServerCommand).toBe("");
    expect(result.current.environmentVariables).toEqual([]);
    expect(result.current.projectAutoSaveError).toBeNull();
  });

  it("triggers debounced save when state changes after initialization", async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ isOpen, tick }: { isOpen: boolean; tick: number }) =>
        useProjectSettingsForm({ projectId: "proj-1", isOpen }),
      { initialProps: { isOpen: false, tick: 0 } }
    );
    rerender({ isOpen: true, tick: 1 });
    mockSettings.value = baseSettings;
    rerender({ isOpen: true, tick: 2 });
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(result.current.projectIsInitialized).toBe(true);

    act(() => {
      result.current.setProjectName("Renamed Project");
    });

    expect(mockSaveSettings).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(mockSaveSettings).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does not save when snapshot is unchanged", async () => {
    vi.useFakeTimers();
    const { rerender } = renderHook(
      ({ isOpen, tick }: { isOpen: boolean; tick: number }) =>
        useProjectSettingsForm({ projectId: "proj-1", isOpen }),
      { initialProps: { isOpen: false, tick: 0 } }
    );
    rerender({ isOpen: true, tick: 1 });
    mockSettings.value = baseSettings;
    rerender({ isOpen: true, tick: 2 });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    vi.clearAllMocks();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(mockSaveSettings).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("flush() triggers immediate save if debounce is pending", async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ isOpen, tick }: { isOpen: boolean; tick: number }) =>
        useProjectSettingsForm({ projectId: "proj-1", isOpen }),
      { initialProps: { isOpen: false, tick: 0 } }
    );
    rerender({ isOpen: true, tick: 1 });
    mockSettings.value = baseSettings;
    rerender({ isOpen: true, tick: 2 });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    act(() => {
      result.current.setProjectName("Flushed Name");
    });

    expect(mockSaveSettings).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.flush();
    });
    expect(mockSaveSettings).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("calls updateProject when identity fields change", async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ isOpen, tick }: { isOpen: boolean; tick: number }) =>
        useProjectSettingsForm({ projectId: "proj-1", isOpen }),
      { initialProps: { isOpen: false, tick: 0 } }
    );
    rerender({ isOpen: true, tick: 1 });
    mockSettings.value = baseSettings;
    rerender({ isOpen: true, tick: 2 });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    act(() => {
      result.current.setProjectName("New Name");
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(mockUpdateProject).toHaveBeenCalledWith("proj-1", {
      name: "New Name",
      emoji: "🌲",
      color: undefined,
    });
    vi.useRealTimers();
  });

  it("does not call updateProject when non-identity fields change", async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ isOpen, tick }: { isOpen: boolean; tick: number }) =>
        useProjectSettingsForm({ projectId: "proj-1", isOpen }),
      { initialProps: { isOpen: false, tick: 0 } }
    );
    rerender({ isOpen: true, tick: 1 });
    mockSettings.value = baseSettings;
    rerender({ isOpen: true, tick: 2 });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    act(() => {
      result.current.setExcludedPaths(["node_modules", "dist"]);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(mockSaveSettings).toHaveBeenCalled();
    expect(mockUpdateProject).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("sets projectAutoSaveError when save fails", async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ isOpen, tick }: { isOpen: boolean; tick: number }) =>
        useProjectSettingsForm({ projectId: "proj-1", isOpen }),
      { initialProps: { isOpen: false, tick: 0 } }
    );
    rerender({ isOpen: true, tick: 1 });
    mockSettings.value = baseSettings;
    rerender({ isOpen: true, tick: 2 });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    mockSaveSettings.mockRejectedValueOnce(new Error("Save failed"));
    act(() => {
      result.current.setExcludedPaths(["new-path"]);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(result.current.projectAutoSaveError).toBe("Save failed");
    vi.useRealTimers();
  });

  it("exposes store and external data", async () => {
    const { result } = renderOpenForm("proj-1");
    await waitFor(() => {
      expect(result.current.projectIsInitialized).toBe(true);
    });
    expect(result.current.projectSettings).toBe(baseSettings);
    expect(result.current.projectIsLoading).toBe(false);
    expect(result.current.projectError).toBeNull();
    expect(result.current.currentProject).toBeDefined();
    expect(result.current.recipes).toEqual([]);
    expect(result.current.worktrees).toEqual([]);
    expect(result.current.worktreeMap).toBeInstanceOf(Map);
    expect(typeof result.current.enableInRepoSettings).toBe("function");
    expect(typeof result.current.disableInRepoSettings).toBe("function");
    expect(typeof result.current.flush).toBe("function");
  });

  it("filters invalid env var keys on save", async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ isOpen, tick }: { isOpen: boolean; tick: number }) =>
        useProjectSettingsForm({ projectId: "proj-1", isOpen }),
      { initialProps: { isOpen: false, tick: 0 } }
    );
    rerender({ isOpen: true, tick: 1 });
    mockSettings.value = { ...baseSettings, environmentVariables: {} };
    rerender({ isOpen: true, tick: 2 });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    act(() => {
      result.current.setEnvironmentVariables([
        { id: "1", key: "VALID_KEY", value: "good" },
        { id: "2", key: "123invalid", value: "bad" },
        { id: "3", key: "", value: "empty" },
      ]);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(mockSaveSettings).toHaveBeenCalled();
    const savedSettings = mockSaveSettings.mock.calls[0][0];
    expect(savedSettings.environmentVariables).toEqual({ VALID_KEY: "good" });
    vi.useRealTimers();
  });
});
