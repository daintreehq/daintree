// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSettings } from "@/types";

const {
  mockSettings,
  mockSaveSettings,
  mockUpdateProject,
  mockEnableInRepoSettings,
  mockDisableInRepoSettings,
  mockProjects,
  mockIsLoading,
  mockRefresh,
} = vi.hoisted(() => ({
  mockSettings: { value: null as ProjectSettings | null },
  mockSaveSettings: vi.fn().mockResolvedValue(undefined),
  mockRefresh: vi.fn().mockResolvedValue(undefined),
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
  mockIsLoading: { value: false },
}));

vi.mock("@/hooks/useProjectSettings", () => ({
  useProjectSettings: () => ({
    settings: mockSettings.value,
    saveSettings: mockSaveSettings,
    isLoading: mockIsLoading.value,
    error: null,
    refresh: mockRefresh,
  }),
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector?: (state: Record<string, unknown>) => unknown) => {
    const state = {
      projects: mockProjects.value,
      updateProject: mockUpdateProject,
      enableInRepoSettings: mockEnableInRepoSettings,
      disableInRepoSettings: mockDisableInRepoSettings,
    };
    return selector ? selector(state) : state;
  },
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
  forgeRemote: "origin",
};

function resetMocks() {
  mockSettings.value = null;
  mockIsLoading.value = false;
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
    ({ isOpen, projectId }: FormProps) => useProjectSettingsForm({ projectId, isOpen }),
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
    expect(result.current.forgeRemote).toBe("origin");
    expect(result.current.runCommands).toHaveLength(1);
    expect(result.current.environmentVariables).toHaveLength(1);
    expect(result.current.environmentVariables[0]!.key).toBe("NODE_ENV");
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
      ({ isOpen }: { isOpen: boolean; tick: number }) =>
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
      ({ isOpen }: { isOpen: boolean; tick: number }) =>
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
      ({ isOpen }: { isOpen: boolean; tick: number }) =>
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
      ({ isOpen }: { isOpen: boolean; tick: number }) =>
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
      ({ isOpen }: { isOpen: boolean; tick: number }) =>
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
      ({ isOpen }: { isOpen: boolean; tick: number }) =>
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
    expect(typeof result.current.refreshProjectSettings).toBe("function");
  });

  it("stays uninitialized while loading with no settings yet (backs the Doherty loader)", async () => {
    mockIsLoading.value = true;
    mockSettings.value = null;
    const { result, rerender } = renderHook(
      ({ isOpen, projectId }: FormProps) => useProjectSettingsForm({ projectId, isOpen }),
      { initialProps: { isOpen: false, tick: 0, projectId: "proj-1" } }
    );
    rerender({ isOpen: true, tick: 1, projectId: "proj-1" });

    expect(result.current.projectIsLoading).toBe(true);
    expect(result.current.projectIsInitialized).toBe(false);
    expect(mockSaveSettings).not.toHaveBeenCalled();
  });

  it("exposes refreshProjectSettings that delegates to useProjectSettings.refresh", async () => {
    const { result } = renderOpenForm("proj-1");
    await waitFor(() => {
      expect(result.current.projectIsInitialized).toBe(true);
    });

    expect(mockRefresh).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.refreshProjectSettings();
    });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("initializes correctly when settings are already loaded at dialog open", async () => {
    mockSettings.value = baseSettings;
    const { result, rerender } = renderHook(
      ({ isOpen, projectId }: FormProps) => useProjectSettingsForm({ projectId, isOpen }),
      { initialProps: { isOpen: false, tick: 0, projectId: "proj-1" } }
    );
    expect(result.current.projectIsInitialized).toBe(false);

    rerender({ isOpen: true, tick: 1, projectId: "proj-1" });

    await waitFor(() => {
      expect(result.current.projectIsInitialized).toBe(true);
    });
    expect(result.current.projectName).toBe("Test Project");
    expect(result.current.devServerCommand).toBe("npm run dev");
  });

  it("rehydrates when projectId changes while dialog stays open", async () => {
    mockProjects.value = [
      { id: "proj-1", name: "Test Project", emoji: "🌲", color: undefined, path: "/test" },
      { id: "proj-2", name: "Other Project", emoji: "🚀", color: "#ff0000", path: "/other" },
    ];
    const otherSettings: ProjectSettings = {
      ...baseSettings,
      devServerCommand: "yarn dev",
      branchPrefixMode: "none",
    };

    const { result, rerender } = renderOpenForm("proj-1");
    await waitFor(() => {
      expect(result.current.projectIsInitialized).toBe(true);
    });
    expect(result.current.projectName).toBe("Test Project");

    // Simulate the loading gap: settings are stale while useProjectSettings refetches
    mockIsLoading.value = true;
    rerender({ isOpen: true, tick: 3, projectId: "proj-2" });

    // Form should be uninitialized while loading new project's settings
    await waitFor(() => {
      expect(result.current.projectIsInitialized).toBe(false);
    });

    // New settings arrive
    mockIsLoading.value = false;
    mockSettings.value = otherSettings;
    rerender({ isOpen: true, tick: 4, projectId: "proj-2" });

    await waitFor(() => {
      expect(result.current.projectName).toBe("Other Project");
    });
    expect(result.current.projectEmoji).toBe("🚀");
    expect(result.current.projectColor).toBe("#ff0000");
    expect(result.current.devServerCommand).toBe("yarn dev");
  });

  it("cancels pending debounce on close without firing save", async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ isOpen, projectId }: FormProps) => useProjectSettingsForm({ projectId, isOpen }),
      { initialProps: { isOpen: false, tick: 0, projectId: "proj-1" } }
    );
    rerender({ isOpen: true, tick: 1, projectId: "proj-1" });
    mockSettings.value = baseSettings;
    rerender({ isOpen: true, tick: 2, projectId: "proj-1" });
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(result.current.projectIsInitialized).toBe(true);

    act(() => {
      result.current.setProjectName("Unsaved Name");
    });
    // Debounce is now pending (500ms). Close the dialog before it fires.
    rerender({ isOpen: false, tick: 3, projectId: "proj-1" });
    vi.clearAllMocks();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(mockSaveSettings).not.toHaveBeenCalled();
    expect(mockUpdateProject).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("still saves unrelated scalar field when worktreePathPattern is invalid", async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ isOpen }: { isOpen: boolean; tick: number }) =>
        useProjectSettingsForm({ projectId: "proj-1", isOpen }),
      { initialProps: { isOpen: false, tick: 0 } }
    );
    rerender({ isOpen: true, tick: 1 });
    mockSettings.value = { ...baseSettings, worktreePathPattern: "{parent-dir}/{branch-slug}" };
    rerender({ isOpen: true, tick: 2 });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    act(() => {
      result.current.setWorktreePathPattern("no-branch-slug-token-here");
      result.current.setBranchPrefixMode("none");
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(mockSaveSettings).toHaveBeenCalled();
    const savedSettings = mockSaveSettings.mock.calls[0]![0];
    expect(savedSettings.branchPrefixMode).toBeUndefined();
    expect(savedSettings.worktreePathPattern).toBe("{parent-dir}/{branch-slug}");
    expect(result.current.projectAutoSaveError).toBeNull();
    vi.useRealTimers();
  });

  it("still saves unrelated collection field when worktreePathPattern is invalid", async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ isOpen }: { isOpen: boolean; tick: number }) =>
        useProjectSettingsForm({ projectId: "proj-1", isOpen }),
      { initialProps: { isOpen: false, tick: 0 } }
    );
    rerender({ isOpen: true, tick: 1 });
    mockSettings.value = { ...baseSettings, worktreePathPattern: "{parent-dir}/{branch-slug}" };
    rerender({ isOpen: true, tick: 2 });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    act(() => {
      result.current.setWorktreePathPattern("no-branch-slug-token-here");
      result.current.setRunCommands([{ id: "rc-2", name: "Build", command: "npm run build" }]);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(mockSaveSettings).toHaveBeenCalled();
    const savedSettings = mockSaveSettings.mock.calls[0]![0];
    expect(savedSettings.runCommands).toEqual([
      { id: "rc-2", name: "Build", command: "npm run build" },
    ]);
    expect(savedSettings.worktreePathPattern).toBe("{parent-dir}/{branch-slug}");
    expect(result.current.projectAutoSaveError).toBeNull();
    vi.useRealTimers();
  });

  it("saves the corrected pattern after the user fixes an invalid worktreePathPattern", async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ isOpen }: { isOpen: boolean; tick: number }) =>
        useProjectSettingsForm({ projectId: "proj-1", isOpen }),
      { initialProps: { isOpen: false, tick: 0 } }
    );
    rerender({ isOpen: true, tick: 1 });
    mockSettings.value = { ...baseSettings, worktreePathPattern: "{parent-dir}/{branch-slug}" };
    rerender({ isOpen: true, tick: 2 });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    act(() => {
      result.current.setWorktreePathPattern("no-branch-slug-token-here");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    act(() => {
      result.current.setWorktreePathPattern("{base-folder}-trees/{branch-slug}");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    const lastCall = mockSaveSettings.mock.calls.at(-1)?.[0];
    expect(lastCall?.worktreePathPattern).toBe("{base-folder}-trees/{branch-slug}");
    expect(result.current.projectAutoSaveError).toBeNull();
    vi.useRealTimers();
  });

  it("leaves terminal fields undefined when project has no terminalSettings", async () => {
    const { result, rerender } = renderHook(
      ({ isOpen, projectId }: FormProps) => useProjectSettingsForm({ projectId, isOpen }),
      { initialProps: { isOpen: false, tick: 0, projectId: "proj-1" } }
    );
    rerender({ isOpen: true, tick: 1, projectId: "proj-1" });
    const { terminalSettings: _unused, ...settingsWithoutTerminal } = baseSettings;
    void _unused;
    mockSettings.value = settingsWithoutTerminal as ProjectSettings;
    rerender({ isOpen: true, tick: 2, projectId: "proj-1" });
    await waitFor(() => {
      expect(result.current.projectIsInitialized).toBe(true);
    });
    expect(result.current.terminalShell).toBeUndefined();
    expect(result.current.terminalShellArgs).toBeUndefined();
    expect(result.current.terminalDefaultCwd).toBeUndefined();
    expect(result.current.terminalScrollback).toBeUndefined();
  });

  it("omits terminalSettings from the saved payload when all four terminal fields are undefined", async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ isOpen }: { isOpen: boolean; tick: number }) =>
        useProjectSettingsForm({ projectId: "proj-1", isOpen }),
      { initialProps: { isOpen: false, tick: 0 } }
    );
    rerender({ isOpen: true, tick: 1 });
    mockSettings.value = baseSettings;
    rerender({ isOpen: true, tick: 2 });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // Reset both terminal fields that baseSettings had set, then trigger save
    act(() => {
      result.current.setTerminalShell(undefined);
      result.current.setTerminalShellArgs(undefined);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(mockSaveSettings).toHaveBeenCalled();
    const lastCall = mockSaveSettings.mock.calls.at(-1)![0];
    expect(lastCall.terminalSettings).toBeUndefined();
    vi.useRealTimers();
  });

  it("preserves valid saved scrollbackLines when user enters an invalid value", async () => {
    vi.useFakeTimers();
    const settingsWithScrollback: ProjectSettings = {
      ...baseSettings,
      terminalSettings: { scrollbackLines: 2000 },
    };
    const { result, rerender } = renderHook(
      ({ isOpen }: { isOpen: boolean; tick: number }) =>
        useProjectSettingsForm({ projectId: "proj-1", isOpen }),
      { initialProps: { isOpen: false, tick: 0 } }
    );
    rerender({ isOpen: true, tick: 1 });
    mockSettings.value = settingsWithScrollback;
    rerender({ isOpen: true, tick: 2 });
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(result.current.terminalScrollback).toBe("2000");

    // Type an out-of-range value (below SCROLLBACK_MIN=100). The UI shows an
    // error; the autosave must NOT silently wipe the existing saved value.
    act(() => {
      result.current.setTerminalScrollback("50");
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    // Either no save fired (snapshot didn't change) or any save still has the
    // valid prior value, never the invalid one.
    for (const call of mockSaveSettings.mock.calls) {
      const saved = call[0];
      if (saved.terminalSettings?.scrollbackLines !== undefined) {
        expect(saved.terminalSettings.scrollbackLines).toBe(2000);
      }
    }
    vi.useRealTimers();
  });

  it("partial reset preserves the other terminal fields in the saved payload", async () => {
    vi.useFakeTimers();
    const fullTerminalSettings: ProjectSettings = {
      ...baseSettings,
      terminalSettings: {
        shell: "/bin/bash",
        shellArgs: ["-l"],
        defaultWorkingDirectory: "/tmp",
        scrollbackLines: 1500,
      },
    };
    const { result, rerender } = renderHook(
      ({ isOpen }: { isOpen: boolean; tick: number }) =>
        useProjectSettingsForm({ projectId: "proj-1", isOpen }),
      { initialProps: { isOpen: false, tick: 0 } }
    );
    rerender({ isOpen: true, tick: 1 });
    mockSettings.value = fullTerminalSettings;
    rerender({ isOpen: true, tick: 2 });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // Reset only the shell — the other three should survive.
    act(() => {
      result.current.setTerminalShell(undefined);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(mockSaveSettings).toHaveBeenCalled();
    const lastCall = mockSaveSettings.mock.calls.at(-1)![0];
    expect(lastCall.terminalSettings).toBeDefined();
    expect(lastCall.terminalSettings.shell).toBeUndefined();
    expect(lastCall.terminalSettings.shellArgs).toEqual(["-l"]);
    expect(lastCall.terminalSettings.defaultWorkingDirectory).toBe("/tmp");
    expect(lastCall.terminalSettings.scrollbackLines).toBe(1500);
    vi.useRealTimers();
  });

  it("filters invalid env var keys on save", async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ isOpen }: { isOpen: boolean; tick: number }) =>
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
    const savedSettings = mockSaveSettings.mock.calls[0]![0];
    expect(savedSettings.environmentVariables).toEqual({ VALID_KEY: "good" });
    vi.useRealTimers();
  });
});
