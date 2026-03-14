// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const {
  hydrateAppStateMock,
  isElectronAvailableMock,
  projectClientOnSwitchMock,
  finishProjectSwitchMock,
  finalizeProjectSwitchRendererCacheMock,
  wakeMock,
  getMock,
  panelKindUsesTerminalUiMock,
  isTerminalWarmInProjectSwitchCacheMock,
  terminalState,
  worktreeSelectionState,
} = vi.hoisted(() => ({
  hydrateAppStateMock: vi.fn(),
  isElectronAvailableMock: vi.fn(() => true),
  projectClientOnSwitchMock: vi.fn(),
  finishProjectSwitchMock: vi.fn(),
  finalizeProjectSwitchRendererCacheMock: vi.fn(),
  wakeMock: vi.fn(),
  getMock: vi.fn(),
  panelKindUsesTerminalUiMock: vi.fn(),
  isTerminalWarmInProjectSwitchCacheMock: vi.fn(),
  terminalState: {
    terminals: [] as Array<{
      id: string;
      kind?: string;
      worktreeId?: string;
    }>,
    activeDockTerminalId: null as string | null,
  },
  worktreeSelectionState: {
    activeWorktreeId: null as string | null,
  },
}));

vi.mock("../../../utils/stateHydration", () => ({
  hydrateAppState: hydrateAppStateMock,
}));

vi.mock("../../useElectron", () => ({
  isElectronAvailable: isElectronAvailableMock,
}));

vi.mock("@/clients", () => ({
  projectClient: {
    onSwitch: projectClientOnSwitchMock,
  },
}));

vi.mock("@/store", () => ({
  useProjectStore: {
    getState: () => ({
      finishProjectSwitch: finishProjectSwitchMock,
    }),
  },
  useTerminalStore: {
    getState: () => terminalState,
  },
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: {
    getState: () => worktreeSelectionState,
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    wake: wakeMock,
    get: getMock,
  },
}));

vi.mock("@shared/config/panelKindRegistry", () => ({
  panelKindUsesTerminalUi: panelKindUsesTerminalUiMock,
}));

vi.mock("@/services/projectSwitchRendererCache", () => ({
  finalizeProjectSwitchRendererCache: finalizeProjectSwitchRendererCacheMock,
  isTerminalWarmInProjectSwitchCache: isTerminalWarmInProjectSwitchCacheMock,
}));

import { useProjectSwitchRehydration } from "../useProjectSwitchRehydration";

describe("useProjectSwitchRehydration", () => {
  let onSwitchHandler:
    | ((payload: { switchId: string; project: { id: string; name: string } }) => void)
    | null = null;

  const callbacks = {
    addTerminal: vi.fn(),
    setActiveWorktree: vi.fn(),
    loadRecipes: vi.fn(),
    openDiagnosticsDock: vi.fn(),
    setFocusMode: vi.fn(),
    setReconnectError: vi.fn(),
    hydrateTabGroups: vi.fn(),
    hydrateMru: vi.fn(),
    hydrateActionMru: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    onSwitchHandler = null;
    projectClientOnSwitchMock.mockImplementation((callback) => {
      onSwitchHandler = callback;
      return () => {
        onSwitchHandler = null;
      };
    });
    panelKindUsesTerminalUiMock.mockImplementation((kind?: string) => kind !== "browser");
    isTerminalWarmInProjectSwitchCacheMock.mockReturnValue(false);
    getMock.mockReturnValue(null);
    terminalState.terminals = [];
    terminalState.activeDockTerminalId = null;
    worktreeSelectionState.activeWorktreeId = null;
  });

  it("ignores stale earlier hydration completions after a newer switch wins", async () => {
    const firstHydration = deferred<void>();
    hydrateAppStateMock.mockImplementation((_callbacks: unknown, switchId: string | undefined) =>
      switchId === "switch-1" ? firstHydration.promise : Promise.resolve()
    );

    terminalState.terminals = [
      { id: "grid-active", kind: "terminal", worktreeId: "wt-active" },
      { id: "grid-other", kind: "terminal", worktreeId: "wt-other" },
    ];
    worktreeSelectionState.activeWorktreeId = "wt-active";

    renderHook(() => useProjectSwitchRehydration(callbacks));

    onSwitchHandler?.({
      switchId: "switch-1",
      project: { id: "project-b", name: "Project B" },
    });
    await Promise.resolve();

    onSwitchHandler?.({
      switchId: "switch-2",
      project: { id: "project-c", name: "Project C" },
    });

    await vi.waitFor(() => {
      expect(finalizeProjectSwitchRendererCacheMock).toHaveBeenCalledWith("project-c");
    });

    const wakeCountAfterCurrentSwitch = wakeMock.mock.calls.length;
    firstHydration.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(finalizeProjectSwitchRendererCacheMock).toHaveBeenCalledTimes(1);
    expect(finalizeProjectSwitchRendererCacheMock).not.toHaveBeenCalledWith("project-b");
    expect(finishProjectSwitchMock).toHaveBeenCalledTimes(1);
    expect(wakeMock).toHaveBeenCalledTimes(wakeCountAfterCurrentSwitch);
  });

  it("wakes only terminal-ui panels in the active worktree plus the active dock terminal", async () => {
    hydrateAppStateMock.mockResolvedValue(undefined);
    panelKindUsesTerminalUiMock.mockImplementation((kind?: string) => kind !== "browser");

    terminalState.terminals = [
      { id: "grid-active", kind: "terminal", worktreeId: "wt-active" },
      { id: "grid-other", kind: "terminal", worktreeId: "wt-other" },
      { id: "dock-active", kind: "terminal", worktreeId: "wt-other" },
      { id: "dock-in-active-worktree", kind: "terminal", worktreeId: "wt-active" },
      { id: "browser-active", kind: "browser", worktreeId: "wt-active" },
    ];
    terminalState.activeDockTerminalId = "dock-active";
    worktreeSelectionState.activeWorktreeId = "wt-active";

    renderHook(() => useProjectSwitchRehydration(callbacks));

    onSwitchHandler?.({
      switchId: "switch-3",
      project: { id: "project-d", name: "Project D" },
    });

    await vi.waitFor(() => {
      expect(finishProjectSwitchMock).toHaveBeenCalledTimes(1);
    });

    expect(wakeMock.mock.calls).toEqual([
      ["grid-active"],
      ["dock-active"],
      ["dock-in-active-worktree"],
    ]);
    expect(finalizeProjectSwitchRendererCacheMock).toHaveBeenCalledWith("project-d");
  });

  it("skips wake for terminals that are warm in the project switch cache with a live instance", async () => {
    hydrateAppStateMock.mockResolvedValue(undefined);

    terminalState.terminals = [
      { id: "warm-terminal", kind: "terminal", worktreeId: "wt-active" },
      { id: "cold-terminal", kind: "terminal", worktreeId: "wt-active" },
    ];
    terminalState.activeDockTerminalId = null;
    worktreeSelectionState.activeWorktreeId = "wt-active";

    isTerminalWarmInProjectSwitchCacheMock.mockImplementation(
      (_projectId: string, terminalId: string) => terminalId === "warm-terminal"
    );
    getMock.mockImplementation((id: string) => (id === "warm-terminal" ? { terminal: {} } : null));

    renderHook(() => useProjectSwitchRehydration(callbacks));

    onSwitchHandler?.({
      switchId: "switch-warm",
      project: { id: "project-warm", name: "Project Warm" },
    });

    await vi.waitFor(() => {
      expect(finishProjectSwitchMock).toHaveBeenCalledTimes(1);
    });

    expect(wakeMock).toHaveBeenCalledTimes(1);
    expect(wakeMock).toHaveBeenCalledWith("cold-terminal");
    expect(wakeMock).not.toHaveBeenCalledWith("warm-terminal");
    expect(isTerminalWarmInProjectSwitchCacheMock).toHaveBeenCalledWith(
      "project-warm",
      "warm-terminal"
    );
    expect(isTerminalWarmInProjectSwitchCacheMock).toHaveBeenCalledWith(
      "project-warm",
      "cold-terminal"
    );
    expect(finalizeProjectSwitchRendererCacheMock).toHaveBeenCalledWith("project-warm");
  });

  it("wakes a cache-warm terminal when the xterm instance is no longer alive", async () => {
    hydrateAppStateMock.mockResolvedValue(undefined);

    terminalState.terminals = [{ id: "stale-terminal", kind: "terminal", worktreeId: "wt-active" }];
    terminalState.activeDockTerminalId = null;
    worktreeSelectionState.activeWorktreeId = "wt-active";

    isTerminalWarmInProjectSwitchCacheMock.mockReturnValue(true);
    getMock.mockReturnValue(null);

    renderHook(() => useProjectSwitchRehydration(callbacks));

    onSwitchHandler?.({
      switchId: "switch-stale",
      project: { id: "project-stale", name: "Project Stale" },
    });

    await vi.waitFor(() => {
      expect(finishProjectSwitchMock).toHaveBeenCalledTimes(1);
    });

    expect(wakeMock).toHaveBeenCalledTimes(1);
    expect(wakeMock).toHaveBeenCalledWith("stale-terminal");
    expect(isTerminalWarmInProjectSwitchCacheMock).toHaveBeenCalledWith(
      "project-stale",
      "stale-terminal"
    );
    expect(getMock).toHaveBeenCalledWith("stale-terminal");
  });

  it("skips malformed project-switched events without hydrating or finalizing", async () => {
    renderHook(() => useProjectSwitchRehydration(callbacks));

    window.dispatchEvent(
      new CustomEvent("project-switched", {
        detail: { switchId: "", projectId: "" },
      })
    );
    await Promise.resolve();

    expect(hydrateAppStateMock).not.toHaveBeenCalled();
    expect(finalizeProjectSwitchRendererCacheMock).not.toHaveBeenCalled();
    expect(finishProjectSwitchMock).not.toHaveBeenCalled();
  });
});
