// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const {
  projectClientMock,
  terminalState,
  worktreeSelectionState,
  terminalPersistenceMock,
  resetAllStoresForProjectSwitchMock,
  forceReinitializeWorktreeDataStoreMock,
  prePopulateWorktreeSnapshotMock,
  snapshotProjectWorktreesMock,
  loadProjectSettingsMock,
  snapshotProjectSettingsMock,
  prePopulateProjectSettingsMock,
  flushTerminalPersistenceMock,
  terminalToSnapshotMock,
  prepareProjectSwitchRendererCacheMock,
  cancelPreparedProjectSwitchRendererCacheMock,
  notifyMock,
  getTerminalInstanceMock,
  destroyTerminalInstanceMock,
} = vi.hoisted(() => ({
  projectClientMock: {
    getAll: vi.fn(),
    getCurrent: vi.fn(),
    add: vi.fn(),
    remove: vi.fn(),
    update: vi.fn(),
    switch: vi.fn(),
    reopen: vi.fn(),
    openDialog: vi.fn(),
    onSwitch: vi.fn(() => () => {}),
    getSettings: vi.fn(),
    saveSettings: vi.fn(),
    detectRunners: vi.fn(),
    close: vi.fn(),
    getStats: vi.fn(),
    setTerminals: vi.fn(),
    setTerminalSizes: vi.fn(),
  },
  terminalState: {
    terminals: [] as Array<{
      id: string;
      kind?: string;
      cwd?: string;
      location?: "grid" | "dock" | "trash";
      worktreeId?: string;
    }>,
  },
  worktreeSelectionState: {
    activeWorktreeId: "wt-active" as string | null,
  },
  terminalPersistenceMock: {
    whenIdle: vi.fn(),
    setProjectIdGetter: vi.fn(),
  },
  resetAllStoresForProjectSwitchMock: vi.fn().mockResolvedValue(undefined),
  forceReinitializeWorktreeDataStoreMock: vi.fn(),
  prePopulateWorktreeSnapshotMock: vi.fn(),
  snapshotProjectWorktreesMock: vi.fn(),
  loadProjectSettingsMock: vi.fn().mockResolvedValue(undefined),
  snapshotProjectSettingsMock: vi.fn(),
  prePopulateProjectSettingsMock: vi.fn(),
  flushTerminalPersistenceMock: vi.fn(),
  terminalToSnapshotMock: vi.fn(
    (terminal: { id: string; cwd?: string; location?: string; worktreeId?: string }) => ({
      id: terminal.id,
      cwd: terminal.cwd ?? "",
      location: terminal.location ?? "grid",
      worktreeId: terminal.worktreeId,
    })
  ),
  prepareProjectSwitchRendererCacheMock: vi.fn(),
  cancelPreparedProjectSwitchRendererCacheMock: vi.fn(),
  notifyMock: vi.fn(),
  getTerminalInstanceMock: vi.fn(),
  destroyTerminalInstanceMock: vi.fn(),
}));

vi.mock("@/clients", () => ({
  projectClient: projectClientMock,
}));

vi.mock("../resetStores", () => ({
  resetAllStoresForProjectSwitch: resetAllStoresForProjectSwitchMock,
}));

vi.mock("../worktreeDataStore", () => ({
  forceReinitializeWorktreeDataStore: forceReinitializeWorktreeDataStoreMock,
  prePopulateWorktreeSnapshot: prePopulateWorktreeSnapshotMock,
  snapshotProjectWorktrees: snapshotProjectWorktreesMock,
}));

vi.mock("../worktreeStore", () => ({
  useWorktreeSelectionStore: {
    getState: () => worktreeSelectionState,
  },
}));

vi.mock("../terminalStore", () => ({
  useTerminalStore: {
    getState: () => terminalState,
  },
}));

vi.mock("../projectSettingsStore", () => ({
  useProjectSettingsStore: {
    getState: () => ({
      reset: vi.fn(),
      loadSettings: loadProjectSettingsMock,
    }),
  },
  snapshotProjectSettings: snapshotProjectSettingsMock,
  prePopulateProjectSettings: prePopulateProjectSettingsMock,
}));

vi.mock("../notificationStore", () => ({
  useNotificationStore: {
    getState: () => ({
      addNotification: vi.fn(),
    }),
  },
}));

vi.mock("../slices", () => ({
  flushTerminalPersistence: flushTerminalPersistenceMock,
}));

vi.mock("../persistence/terminalPersistence", () => ({
  terminalPersistence: terminalPersistenceMock,
  terminalToSnapshot: terminalToSnapshotMock,
}));

vi.mock("@/utils/errorContext", () => ({
  logErrorWithContext: vi.fn(),
}));

vi.mock("@/services/projectSwitchRendererCache", () => ({
  prepareProjectSwitchRendererCache: prepareProjectSwitchRendererCacheMock,
  cancelPreparedProjectSwitchRendererCache: cancelPreparedProjectSwitchRendererCacheMock,
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    get: getTerminalInstanceMock,
    destroy: destroyTerminalInstanceMock,
  },
}));

vi.mock("@/lib/notify", () => ({
  notify: notifyMock,
}));

const { useProjectStore, SWITCH_SAFETY_TIMEOUT_MS } = await import("../projectStore");

describe("projectStore switching races", () => {
  const projectA = {
    id: "project-a",
    name: "Project A",
    path: "/project-a",
    emoji: "folder",
    lastOpened: Date.now() - 2_000,
  };
  const projectB = {
    id: "project-b",
    name: "Project B",
    path: "/project-b",
    emoji: "folder",
    lastOpened: Date.now() - 1_000,
  };
  const projectC = {
    id: "project-c",
    name: "Project C",
    path: "/project-c",
    emoji: "folder",
    lastOpened: Date.now(),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    useProjectStore.setState({
      projects: [projectA, projectB, projectC],
      currentProject: projectA,
      isLoading: false,
      isSwitching: false,
      switchingToProjectName: null,
      error: null,
    });

    terminalState.terminals = [];
    worktreeSelectionState.activeWorktreeId = "wt-active";

    terminalPersistenceMock.whenIdle.mockResolvedValue(undefined);
    projectClientMock.setTerminals.mockResolvedValue(undefined);
    projectClientMock.setTerminalSizes.mockResolvedValue(undefined);
    projectClientMock.getAll.mockResolvedValue([projectA, projectB, projectC]);
    prepareProjectSwitchRendererCacheMock.mockReturnValue({
      preserveTerminalIds: new Set<string>(),
      evictTerminalIds: [],
    });
    getTerminalInstanceMock.mockReturnValue(null);
  });

  it("passes only live persisted terminals into switch preservation and eviction flow", async () => {
    const preserveTerminalIds = new Set(["term-active", "term-dock"]);
    prepareProjectSwitchRendererCacheMock.mockReturnValue({
      preserveTerminalIds,
      evictTerminalIds: ["term-evict-a", "term-evict-b"],
    });

    terminalState.terminals = [
      {
        id: "term-active",
        kind: "terminal",
        cwd: "/project-a",
        location: "grid",
        worktreeId: "wt-active",
      },
      {
        id: "term-other",
        kind: "terminal",
        cwd: "/project-a/feature",
        location: "grid",
        worktreeId: "wt-other",
      },
      {
        id: "term-dock",
        kind: "terminal",
        cwd: "/project-a",
        location: "dock",
      },
      {
        id: "term-trash",
        kind: "terminal",
        cwd: "/project-a",
        location: "trash",
        worktreeId: "wt-active",
      },
      {
        id: "smoke-test-terminal-1",
        kind: "terminal",
        cwd: "/project-a",
        location: "grid",
        worktreeId: "wt-active",
      },
    ];

    getTerminalInstanceMock.mockImplementation((terminalId: string) => {
      if (terminalId === "term-active") {
        return { latestCols: 120, latestRows: 40 };
      }
      if (terminalId === "term-dock") {
        return { latestCols: 90, latestRows: 20 };
      }
      return null;
    });

    projectClientMock.switch.mockResolvedValue(projectB);

    await useProjectStore.getState().switchProject("project-b");
    await vi.waitFor(() => {
      expect(destroyTerminalInstanceMock).toHaveBeenCalledTimes(2);
    });

    expect(terminalToSnapshotMock).toHaveBeenCalledTimes(3);
    expect(projectClientMock.setTerminals).toHaveBeenCalledWith("project-a", [
      {
        id: "term-active",
        cwd: "/project-a",
        location: "grid",
        worktreeId: "wt-active",
      },
      {
        id: "term-other",
        cwd: "/project-a/feature",
        location: "grid",
        worktreeId: "wt-other",
      },
      {
        id: "term-dock",
        cwd: "/project-a",
        location: "dock",
        worktreeId: undefined,
      },
    ]);
    expect(projectClientMock.setTerminalSizes).toHaveBeenCalledWith("project-a", {
      "term-active": { cols: 120, rows: 40 },
      "term-dock": { cols: 90, rows: 20 },
    });
    expect(prepareProjectSwitchRendererCacheMock).toHaveBeenCalledWith({
      outgoingProjectId: "project-a",
      targetProjectId: "project-b",
      outgoingActiveWorktreeId: "wt-active",
      outgoingTerminals: [
        { id: "term-active", worktreeId: "wt-active" },
        { id: "term-other", worktreeId: "wt-other" },
        { id: "term-dock", worktreeId: undefined },
      ],
    });
    expect(resetAllStoresForProjectSwitchMock).toHaveBeenCalledWith({
      preserveTerminalIds,
      outgoingProjectId: "project-a",
      skipTerminalStateReset: true,
    });
    expect(destroyTerminalInstanceMock.mock.calls).toEqual([["term-evict-a"], ["term-evict-b"]]);
  });

  it("ignores a stale failed switch after a newer switch succeeds", async () => {
    const switchToB = deferred<typeof projectB>();
    const switchToC = deferred<typeof projectC>();

    projectClientMock.switch
      .mockImplementationOnce(() => switchToB.promise)
      .mockImplementationOnce(() => switchToC.promise);

    await useProjectStore.getState().switchProject("project-b");
    await useProjectStore.getState().switchProject("project-c");

    switchToC.resolve(projectC);
    await Promise.resolve();
    await Promise.resolve();

    switchToB.reject(new Error("project-b exploded late"));
    await Promise.resolve();
    await Promise.resolve();

    expect(useProjectStore.getState().currentProject?.id).toBe("project-c");
    expect(useProjectStore.getState().error).toBeNull();
    expect(forceReinitializeWorktreeDataStoreMock).toHaveBeenCalledTimes(1);
    expect(forceReinitializeWorktreeDataStoreMock).toHaveBeenCalledWith("project-c");
    expect(notifyMock).not.toHaveBeenCalled();
    expect(cancelPreparedProjectSwitchRendererCacheMock).not.toHaveBeenCalled();
  });

  it("rolls back to the previous project when the latest switch fails", async () => {
    projectClientMock.switch.mockRejectedValue(new Error("switch failed"));

    await useProjectStore.getState().switchProject("project-b");
    await vi.waitFor(() => {
      expect(useProjectStore.getState().error).toBe("switch failed");
    });

    expect(useProjectStore.getState().currentProject?.id).toBe("project-a");
    expect(cancelPreparedProjectSwitchRendererCacheMock).toHaveBeenCalledWith("project-a");
    expect(prePopulateWorktreeSnapshotMock).toHaveBeenNthCalledWith(1, "project-b", "/project-b");
    expect(prePopulateWorktreeSnapshotMock).toHaveBeenNthCalledWith(2, "project-a", "/project-a");
    expect(prePopulateProjectSettingsMock).toHaveBeenNthCalledWith(1, "project-b");
    expect(prePopulateProjectSettingsMock).toHaveBeenNthCalledWith(2, "project-a");
    expect(forceReinitializeWorktreeDataStoreMock).toHaveBeenCalledWith("project-a");
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Failed to switch project",
        message: "switch failed",
      })
    );
  });
});

describe("projectStore safety timeout", () => {
  const projectA = {
    id: "project-a",
    name: "Project A",
    path: "/project-a",
    emoji: "folder",
    lastOpened: Date.now() - 2_000,
  };
  const projectB = {
    id: "project-b",
    name: "Project B",
    path: "/project-b",
    emoji: "folder",
    lastOpened: Date.now() - 1_000,
  };
  const projectC = {
    id: "project-c",
    name: "Project C",
    path: "/project-c",
    emoji: "folder",
    lastOpened: Date.now(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    useProjectStore.setState({
      projects: [projectA, projectB, projectC],
      currentProject: projectA,
      isLoading: false,
      isSwitching: false,
      switchingToProjectName: null,
      error: null,
    });

    terminalState.terminals = [];
    worktreeSelectionState.activeWorktreeId = "wt-active";

    terminalPersistenceMock.whenIdle.mockResolvedValue(undefined);
    projectClientMock.setTerminals.mockResolvedValue(undefined);
    projectClientMock.setTerminalSizes.mockResolvedValue(undefined);
    projectClientMock.getAll.mockResolvedValue([projectA, projectB, projectC]);
    prepareProjectSwitchRendererCacheMock.mockReturnValue({
      preserveTerminalIds: new Set<string>(),
      evictTerminalIds: [],
    });
    getTerminalInstanceMock.mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("auto-clears isSwitching after 30s when switchProject IPC never resolves", async () => {
    projectClientMock.switch.mockReturnValue(new Promise(() => {}));

    await useProjectStore.getState().switchProject("project-b");
    expect(useProjectStore.getState().isSwitching).toBe(true);

    vi.advanceTimersByTime(SWITCH_SAFETY_TIMEOUT_MS - 1);
    expect(useProjectStore.getState().isSwitching).toBe(true);

    vi.advanceTimersByTime(1);
    expect(useProjectStore.getState().isSwitching).toBe(false);
    expect(useProjectStore.getState().switchingToProjectName).toBeNull();
  });

  it("auto-clears isSwitching after 30s when reopenProject IPC never resolves", async () => {
    projectClientMock.reopen.mockReturnValue(new Promise(() => {}));

    await useProjectStore.getState().reopenProject("project-b");
    expect(useProjectStore.getState().isSwitching).toBe(true);

    vi.advanceTimersByTime(SWITCH_SAFETY_TIMEOUT_MS);
    expect(useProjectStore.getState().isSwitching).toBe(false);
    expect(useProjectStore.getState().switchingToProjectName).toBeNull();
  });

  it("does not fire timeout when finishProjectSwitch is called before 30s", async () => {
    projectClientMock.switch.mockReturnValue(new Promise(() => {}));

    await useProjectStore.getState().switchProject("project-b");
    expect(useProjectStore.getState().isSwitching).toBe(true);

    useProjectStore.getState().finishProjectSwitch();
    expect(useProjectStore.getState().isSwitching).toBe(false);

    notifyMock.mockClear();
    vi.advanceTimersByTime(SWITCH_SAFETY_TIMEOUT_MS);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("invalidates older timeout when a newer switch starts", async () => {
    projectClientMock.switch.mockReturnValue(new Promise(() => {}));

    await useProjectStore.getState().switchProject("project-b");
    vi.advanceTimersByTime(20_000);

    await useProjectStore.getState().switchProject("project-c");
    vi.advanceTimersByTime(15_000);
    expect(useProjectStore.getState().isSwitching).toBe(true);

    vi.advanceTimersByTime(15_000);
    expect(useProjectStore.getState().isSwitching).toBe(false);
  });

  it("fires a warning notification on timeout", async () => {
    projectClientMock.switch.mockReturnValue(new Promise(() => {}));

    await useProjectStore.getState().switchProject("project-b");
    vi.advanceTimersByTime(SWITCH_SAFETY_TIMEOUT_MS);

    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        title: "Project switch timed out",
      })
    );
  });
});
