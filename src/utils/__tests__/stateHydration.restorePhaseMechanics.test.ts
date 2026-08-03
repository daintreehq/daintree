// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const appClientMock = {
  hydrate: vi.fn(),
};

const getTmpDirMock = vi.fn().mockResolvedValue("/tmp");

const terminalClientMock = {
  getForProject: vi.fn(),
  reconnect: vi.fn(),
  reconnectBulk: vi.fn(),
  getSerializedStates: vi.fn(),
};

const worktreeClientMock = {
  getAll: vi.fn(),
  getAllWithStatus: vi.fn(),
};

const projectClientMock = {
  getTabGroups: vi.fn(),
  getTerminalSizes: vi.fn(),
  getDraftInputs: vi.fn(),
  setDraftInputs: vi.fn(),
  getInRepoPresets: vi.fn(),
};

const terminalConfigClientMock = {
  setScrollback: vi.fn(),
};

const layoutConfigState = {
  setLayoutConfig: vi.fn(),
};

const scrollbackState = {
  setScrollbackLines: vi.fn(),
};

const performanceState = {
  setPerformanceMode: vi.fn(),
};

const terminalInputState = {
  setHybridInputEnabled: vi.fn(),
  setHybridInputAutoFocus: vi.fn(),
};

const setSpawnErrorMock = vi.fn();
const terminalStoreState = {
  setSpawnError: setSpawnErrorMock,
};
const projectStoreSetStateMock = vi.fn();

const initializeMock = vi.fn().mockResolvedValue(undefined);
const loadOverridesMock = vi.fn().mockResolvedValue(undefined);
const fetchAndRestoreMock = vi.fn().mockResolvedValue(undefined);
const restoreFetchedStateMock = vi.fn().mockResolvedValue(undefined);
const getManagedTerminalMock = vi.fn().mockReturnValue(null);

vi.mock("@/clients", () => ({
  appClient: appClientMock,
  terminalClient: terminalClientMock,
  worktreeClient: worktreeClientMock,
  projectClient: projectClientMock,
  systemClient: { getTmpDir: getTmpDirMock },
}));

vi.mock("@/clients/terminalConfigClient", () => ({
  terminalConfigClient: terminalConfigClientMock,
}));

vi.mock("@/store", () => ({
  useLayoutConfigStore: {
    getState: () => layoutConfigState,
  },
  useScrollbackStore: {
    getState: () => scrollbackState,
  },
  usePerformanceModeStore: {
    getState: () => performanceState,
  },
  useTerminalInputStore: {
    getState: () => terminalInputState,
  },
  usePanelStore: {
    getState: () => terminalStoreState,
  },
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: {
    setState: projectStoreSetStateMock,
  },
}));

vi.mock("@/store/userAgentRegistryStore", () => ({
  useUserAgentRegistryStore: {
    getState: () => ({
      initialize: initializeMock,
    }),
  },
}));

vi.mock("@/services/KeybindingService", () => ({
  keybindingService: {
    loadOverrides: loadOverridesMock,
  },
}));

const initializeBackendTierMock = vi.fn();
const setGPUHardwareAvailableMock = vi.fn();
const setTargetSizeMock = vi.fn();

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    fetchAndRestore: fetchAndRestoreMock,
    restoreFetchedState: restoreFetchedStateMock,
    initializeBackendTier: initializeBackendTierMock,
    get: getManagedTerminalMock,
    setGPUHardwareAvailable: setGPUHardwareAvailableMock,
    setTargetSize: setTargetSizeMock,
    notifyScrollbackRestoreListeners: vi.fn(),
    notifyRestoreSettledWaiters: vi.fn(),
  },
}));

const notifyMock = vi.fn().mockReturnValue("notification-id");
vi.mock("@/lib/notify", () => ({
  notify: (...args: unknown[]) => notifyMock(...args),
}));

const { hydrateAppState } = await import("../stateHydration");

function makeMockManagedTerminal(id: string) {
  const hostElement = document.createElement("div");
  return {
    id,
    scrollbackRestoreState: "none" as "none" | "pending" | "in-progress" | "done",
    hostElement,
    listeners: [] as Array<() => void>,
  };
}

describe("hydrateAppState", () => {
  const project = { id: "project-1", path: "/project" };
  const terminalConfig = { scrollbackLines: 1000, performanceMode: false };
  const agentSettings = { agents: {} };
  let postTaskCallbacks: Array<() => void>;

  beforeEach(() => {
    vi.clearAllMocks();
    postTaskCallbacks = [];

    vi.stubGlobal("scheduler", {
      postTask: vi.fn((cb: () => unknown) => {
        return new Promise<unknown>((resolve, reject) => {
          postTaskCallbacks.push(() => {
            try {
              resolve(cb());
            } catch (e) {
              reject(e);
            }
          });
        });
      }),
    });

    // By default, return a cached mock managed terminal for any ID (enables scrollback scheduling).
    // Caching ensures identity checks (current !== managed) pass correctly.
    const managedCache = new Map<string, ReturnType<typeof makeMockManagedTerminal>>();
    getManagedTerminalMock.mockImplementation((id: string) => {
      if (!managedCache.has(id)) {
        managedCache.set(id, makeMockManagedTerminal(id));
      }
      return managedCache.get(id);
    });
    terminalClientMock.getForProject.mockResolvedValue([]);
    terminalClientMock.reconnect.mockResolvedValue({ exists: false });
    terminalClientMock.reconnectBulk.mockResolvedValue({});
    terminalClientMock.getSerializedStates.mockRejectedValue(
      new Error("Batch serialized state endpoint unavailable")
    );
    worktreeClientMock.getAllWithStatus.mockResolvedValue({ worktrees: [], gitBacked: null });
    projectClientMock.getTabGroups.mockResolvedValue([]);
    projectClientMock.getTerminalSizes.mockResolvedValue({});
    projectClientMock.getDraftInputs.mockResolvedValue({});
    projectClientMock.getInRepoPresets.mockResolvedValue({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    postTaskCallbacks = [];
  });

  const flushPostTasks = async () => {
    const callbacks = [...postTaskCallbacks];
    postTaskCallbacks = [];
    for (const cb of callbacks) cb();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  };

  it("schedules scrollback restore as background tasks, not blocking hydration", async () => {
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "terminal-1",
            kind: "terminal",
            type: "terminal",
            title: "Terminal 1",
            cwd: "/project",
            location: "grid",
          },
          {
            id: "terminal-2",
            kind: "terminal",
            type: "terminal",
            title: "Terminal 2",
            cwd: "/project",
            location: "grid",
          },
        ],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    terminalClientMock.getForProject.mockResolvedValue([
      {
        id: "terminal-1",
        hasPty: true,
        cwd: "/project",
        kind: "terminal",
        title: "Terminal 1",
      },
      {
        id: "terminal-2",
        hasPty: true,
        cwd: "/project",
        kind: "terminal",
        title: "Terminal 2",
      },
    ]);

    const addPanel = vi.fn(async (options: { existingId?: string; requestedId?: string }) => {
      return options.existingId ?? options.requestedId ?? "terminal-id";
    });

    // Hydration completes without waiting for scrollback restore
    await hydrateAppState({
      addPanel,
      setActiveWorktree: vi.fn(),
      loadRecipes: vi.fn().mockResolvedValue(undefined),
      openDiagnosticsDock: vi.fn(),
    });

    // fetchAndRestore NOT called synchronously during hydration
    expect(fetchAndRestoreMock).not.toHaveBeenCalled();

    // Flush background scheduler tasks
    await flushPostTasks();

    // Now both terminals should have been restored
    expect(fetchAndRestoreMock).toHaveBeenCalledWith("terminal-1");
    expect(fetchAndRestoreMock).toHaveBeenCalledWith("terminal-2");
  });

  it("does not call batch getSerializedStates — uses per-terminal fetchAndRestore", async () => {
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "terminal-1",
            kind: "terminal",
            title: "Terminal 1",
            cwd: "/project",
            location: "grid",
          },
          {
            id: "terminal-2",
            kind: "terminal",
            title: "Terminal 2",
            cwd: "/project",
            location: "grid",
          },
        ],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    terminalClientMock.getForProject.mockResolvedValue([
      {
        id: "terminal-1",
        hasPty: true,
        cwd: "/project",
        kind: "terminal",
        title: "Terminal 1",
      },
      {
        id: "terminal-2",
        hasPty: true,
        cwd: "/project",
        kind: "terminal",
        title: "Terminal 2",
      },
    ]);

    const addPanel = vi.fn(async (options: { existingId?: string; requestedId?: string }) => {
      return options.existingId ?? options.requestedId ?? "terminal-id";
    });

    await hydrateAppState({
      addPanel,
      setActiveWorktree: vi.fn(),
      loadRecipes: vi.fn().mockResolvedValue(undefined),
      openDiagnosticsDock: vi.fn(),
    });

    // Batch endpoint is never called — scrollback restore uses per-terminal fetch
    expect(terminalClientMock.getSerializedStates).not.toHaveBeenCalled();
    expect(restoreFetchedStateMock).not.toHaveBeenCalled();

    // Flush background tasks to trigger per-terminal restore
    await flushPostTasks();
    expect(fetchAndRestoreMock).toHaveBeenCalledWith("terminal-1");
    expect(fetchAndRestoreMock).toHaveBeenCalledWith("terminal-2");
  });

  it("prefetches worktrees and tab groups during hydration", async () => {
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "terminal-1",
            kind: "terminal",
            title: "Terminal 1",
            cwd: "/project",
            location: "grid",
            worktreeId: "wt-active",
          },
        ],
        activeWorktreeId: "wt-active",
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    terminalClientMock.getForProject.mockResolvedValue([
      {
        id: "terminal-1",
        hasPty: true,
        cwd: "/project",
        kind: "terminal",
        title: "Terminal 1",
        worktreeId: "wt-active",
      },
    ]);

    const addPanel = vi.fn(async (options: { existingId?: string }) => {
      return options.existingId ?? "terminal-id";
    });

    await hydrateAppState({
      addPanel,
      setActiveWorktree: vi.fn(),
      loadRecipes: vi.fn().mockResolvedValue(undefined),
      openDiagnosticsDock: vi.fn(),
      hydrateTabGroups: vi.fn(),
    });

    expect(worktreeClientMock.getAllWithStatus).toHaveBeenCalledTimes(1);
    expect(projectClientMock.getTabGroups).toHaveBeenCalledWith("project-1");
  });

  it("dispatches getForProject concurrently with draft-input restore", async () => {
    // Hold draft-input resolution so we can observe the IPC ordering. Without
    // the parallelisation, getForProject would be blocked behind this await.
    let releaseDrafts: () => void = () => {};
    const draftsDeferred = new Promise<Record<string, string>>((resolve) => {
      releaseDrafts = () => resolve({});
    });
    projectClientMock.getDraftInputs.mockReturnValue(draftsDeferred);

    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [],
        activeWorktreeId: null,
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });
    terminalClientMock.getForProject.mockResolvedValue([]);

    const hydrationPromise = hydrateAppState({
      addPanel: vi.fn(),
      setActiveWorktree: vi.fn(),
      loadRecipes: vi.fn().mockResolvedValue(undefined),
      openDiagnosticsDock: vi.fn(),
    });

    // Flush microtasks so the prefetch fan-out runs. getForProject should have
    // been dispatched even though getDraftInputs is still pending.
    for (let i = 0; i < 10; i++) {
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    }

    expect(terminalClientMock.getForProject).toHaveBeenCalledWith("project-1");
    expect(projectClientMock.getDraftInputs).toHaveBeenCalledWith("project-1");

    releaseDrafts();
    await hydrationPromise;
  });

  it("skips scrollback restore for a terminal already in the 'done' state", async () => {
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "terminal-cached",
            kind: "terminal",
            title: "Cached Terminal",
            cwd: "/project",
            location: "grid",
          },
        ],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    terminalClientMock.getForProject.mockResolvedValue([
      {
        id: "terminal-cached",
        hasPty: true,
        cwd: "/project",
        kind: "terminal",
        title: "Cached Terminal",
      },
    ]);

    // A terminal whose scrollback is already loaded ("done") is skipped by
    // scheduleScrollbackRestore's gate (scrollbackRestoreState !== "none").
    getManagedTerminalMock.mockImplementation((id: string) => {
      if (id === "terminal-cached") {
        return {
          id,
          scrollbackRestoreState: "done",
          hostElement: document.createElement("div"),
          listeners: [] as Array<() => void>,
        };
      }
      return makeMockManagedTerminal(id);
    });

    const addPanel = vi.fn(async (options: { existingId?: string; requestedId?: string }) => {
      return options.existingId ?? options.requestedId ?? "terminal-id";
    });

    await hydrateAppState({
      addPanel,
      setActiveWorktree: vi.fn(),
      loadRecipes: vi.fn().mockResolvedValue(undefined),
      openDiagnosticsDock: vi.fn(),
    });

    expect(addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        existingId: "terminal-cached",
      })
    );

    // Flush background tasks — warm terminal should not be scheduled for restore
    await flushPostTasks();
    expect(fetchAndRestoreMock).not.toHaveBeenCalled();
    expect(terminalClientMock.getSerializedStates).not.toHaveBeenCalled();
  });

  it("does not block initial hydration on recipe loading", async () => {
    let resolveRecipes!: () => void;
    const pendingRecipes = new Promise<void>((resolve) => {
      resolveRecipes = resolve;
    });

    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    const hydratePromise = hydrateAppState({
      addPanel: vi.fn().mockResolvedValue("terminal-id"),
      setActiveWorktree: vi.fn(),
      loadRecipes: vi.fn().mockReturnValue(pendingRecipes),
      openDiagnosticsDock: vi.fn(),
    });

    await expect(hydratePromise).resolves.toBeUndefined();
    resolveRecipes();
    await pendingRecipes;
  });

  it("loads and hydrates persisted tab groups after terminal restore", async () => {
    // This test verifies that tab groups are loaded from project storage
    // and passed to the hydrateTabGroups callback after terminals are restored.
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "terminal-1",
            kind: "terminal",
            title: "Terminal 1",
            cwd: "/project",
            location: "grid",
          },
          {
            id: "terminal-2",
            kind: "terminal",
            title: "Terminal 2",
            cwd: "/project",
            location: "grid",
          },
        ],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    // Set up persisted tab groups
    const persistedTabGroups = [
      {
        id: "group-1",
        location: "grid",
        worktreeId: undefined,
        activeTabId: "terminal-1",
        panelIds: ["terminal-1", "terminal-2"],
      },
    ];
    projectClientMock.getTabGroups.mockResolvedValue(persistedTabGroups);

    // Echo the requested id so each panel restores under its saved id (the
    // clean cold-restart path). This keeps the saved→restored remap empty, so
    // tab groups hydrate unchanged (#10440).
    const addPanel = vi.fn(
      async (args: { requestedId?: string; existingId?: string }) =>
        args.requestedId ?? args.existingId ?? "terminal-id"
    );
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();
    const hydrateTabGroups = vi.fn();

    await hydrateAppState({
      addPanel,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
      hydrateTabGroups,
    });

    // Verify tab groups were fetched for the current project
    expect(projectClientMock.getTabGroups).toHaveBeenCalledWith("project-1");

    // Verify hydrateTabGroups was called with the persisted groups
    expect(hydrateTabGroups).toHaveBeenCalledTimes(1);
    expect(hydrateTabGroups).toHaveBeenCalledWith(persistedTabGroups);
  });

  it("remaps tab-group panel ids when a panel respawns with a generated id (#10440)", async () => {
    // A persisted PTY panel whose reconnect times out respawns under a fresh
    // generated id. The saved tab group still references the old id; without the
    // remap, hydrateTabGroups would filter it out, shrink the group to one
    // member, and discard it — permanently destroying the grouping.
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "old-panel-id",
            kind: "terminal",
            title: "Terminal 1",
            cwd: "/project",
            location: "grid",
          },
          {
            id: "stable-panel-id",
            kind: "terminal",
            title: "Terminal 2",
            cwd: "/project",
            location: "grid",
          },
        ],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    // Persisted group references the pre-restart saved ids.
    const persistedTabGroups = [
      {
        id: "group-1",
        location: "grid",
        worktreeId: undefined,
        activeTabId: "old-panel-id",
        panelIds: ["old-panel-id", "stable-panel-id"],
      },
    ];
    projectClientMock.getTabGroups.mockResolvedValue(persistedTabGroups);

    // The first panel's reconnect times out (reconnectManager surfaces the
    // 2000ms rejection as status "timeout"), so it respawns with requestedId
    // undefined and the store assigns "new-panel-id". The second misses (not
    // found) and respawns under its saved id.
    terminalClientMock.reconnect.mockImplementation(async (id: string) => {
      if (id === "old-panel-id") throw new Error("Reconnection timeout");
      return { exists: false };
    });
    const addPanel = vi.fn(async (args: { requestedId?: string; existingId?: string }) =>
      args.requestedId === undefined ? "new-panel-id" : args.requestedId
    );
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();
    const hydrateTabGroups = vi.fn();

    await hydrateAppState({
      addPanel,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
      hydrateTabGroups,
    });

    // hydrateTabGroups receives the group with the old id remapped to the new
    // runtime id (both panelIds membership and the activeTabId pointer).
    expect(hydrateTabGroups).toHaveBeenCalledTimes(1);
    expect(hydrateTabGroups).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "group-1",
        activeTabId: "new-panel-id",
        panelIds: ["new-panel-id", "stable-panel-id"],
      }),
    ]);
  });

  it("does not throw on a malformed group during remap, preserving valid groups (#10440)", async () => {
    // A malformed persisted group (panelIds not an array) must pass through the
    // remap untouched rather than throwing — otherwise the catch path would wipe
    // every group for the session. Requires the remap to be active (size > 0).
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "old-panel-id",
            kind: "terminal",
            title: "Terminal 1",
            cwd: "/project",
            location: "grid",
          },
          {
            id: "stable-panel-id",
            kind: "terminal",
            title: "Terminal 2",
            cwd: "/project",
            location: "grid",
          },
        ],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    const persistedTabGroups = [
      // Malformed — panelIds is not an array. Must survive the remap untouched.
      { id: "bad", location: "grid", worktreeId: undefined, activeTabId: "x", panelIds: null },
      {
        id: "group-1",
        location: "grid",
        worktreeId: undefined,
        activeTabId: "old-panel-id",
        panelIds: ["old-panel-id", "stable-panel-id"],
      },
    ];
    projectClientMock.getTabGroups.mockResolvedValue(persistedTabGroups);

    terminalClientMock.reconnect.mockImplementation(async (id: string) => {
      if (id === "old-panel-id") throw new Error("Reconnection timeout");
      return { exists: false };
    });
    const addPanel = vi.fn(async (args: { requestedId?: string; existingId?: string }) =>
      args.requestedId === undefined ? "new-panel-id" : args.requestedId
    );
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();
    const hydrateTabGroups = vi.fn();

    await hydrateAppState({
      addPanel,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
      hydrateTabGroups,
    });

    // The remap ran (no throw), the malformed group passed through unchanged,
    // and the valid group was remapped. The catch path (which would call with
    // [] + skipPersist) never fired.
    expect(hydrateTabGroups).toHaveBeenCalledTimes(1);
    expect(hydrateTabGroups).toHaveBeenCalledWith([
      expect.objectContaining({ id: "bad", panelIds: null }),
      expect.objectContaining({
        id: "group-1",
        activeTabId: "new-panel-id",
        panelIds: ["new-panel-id", "stable-panel-id"],
      }),
    ]);
  });

  it("clears tab groups when no persisted groups exist", async () => {
    // When there are no persisted tab groups, hydrateTabGroups should be
    // called with an empty array to clear any stale state.
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    projectClientMock.getTabGroups.mockResolvedValue([]);

    const addPanel = vi.fn().mockResolvedValue("terminal-id");
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();
    const hydrateTabGroups = vi.fn();

    await hydrateAppState({
      addPanel,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
      hydrateTabGroups,
    });

    // Should still call hydrateTabGroups with empty array to clear stale groups
    expect(hydrateTabGroups).toHaveBeenCalledWith([]);
  });

  it("clears tab groups on error fetching persisted groups", async () => {
    // When fetching tab groups fails, hydrateTabGroups should be called
    // with an empty array to prevent stale state.
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    projectClientMock.getTabGroups.mockRejectedValue(new Error("Storage error"));

    const addPanel = vi.fn().mockResolvedValue("terminal-id");
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();
    const hydrateTabGroups = vi.fn();

    await hydrateAppState({
      addPanel,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
      hydrateTabGroups,
    });

    // Should call hydrateTabGroups with empty array and skipPersist on error
    expect(hydrateTabGroups).toHaveBeenCalledWith([], { skipPersist: true });
  });
});
