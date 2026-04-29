// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const appClientMock = {
  hydrate: vi.fn(),
};

const terminalClientMock = {
  getForProject: vi.fn(),
  reconnect: vi.fn(),
  getSerializedStates: vi.fn(),
};

const worktreeClientMock = {
  getAll: vi.fn(),
};

const projectClientMock = {
  getTabGroups: vi.fn(),
  getTerminalSizes: vi.fn(),
  getDraftInputs: vi.fn(),
  setDraftInputs: vi.fn(),
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

const initializeMock = vi.fn().mockResolvedValue(undefined);
const loadOverridesMock = vi.fn().mockResolvedValue(undefined);
const fetchAndRestoreMock = vi.fn().mockResolvedValue(undefined);
const restoreFetchedStateMock = vi.fn().mockResolvedValue(undefined);
const getManagedTerminalMock = vi.fn().mockReturnValue(null);
const isTerminalWarmInProjectSwitchCacheMock = vi.fn().mockReturnValue(false);

vi.mock("@/clients", () => ({
  appClient: appClientMock,
  terminalClient: terminalClientMock,
  worktreeClient: worktreeClientMock,
  projectClient: projectClientMock,
  systemClient: { getTmpDir: vi.fn().mockResolvedValue("/tmp") },
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
  },
}));

vi.mock("@/services/projectSwitchRendererCache", () => ({
  isTerminalWarmInProjectSwitchCache: isTerminalWarmInProjectSwitchCacheMock,
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
    scrollbackRestoreDisposable: undefined as { dispose: () => void } | undefined,
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
    isTerminalWarmInProjectSwitchCacheMock.mockReturnValue(false);
    terminalClientMock.getForProject.mockResolvedValue([]);
    terminalClientMock.reconnect.mockResolvedValue({ exists: false });
    terminalClientMock.getSerializedStates.mockRejectedValue(
      new Error("Batch serialized state endpoint unavailable")
    );
    worktreeClientMock.getAll.mockResolvedValue([]);
    projectClientMock.getTabGroups.mockResolvedValue([]);
    projectClientMock.getTerminalSizes.mockResolvedValue({});
    projectClientMock.getDraftInputs.mockResolvedValue({});
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

  it("rehydrates dev-preview panels without backend terminals", async () => {
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "dev-preview-1",
            kind: "dev-preview",
            title: "Dev Preview",
            cwd: "/project",
            location: "grid",
            command: "npm run dev",
            browserUrl: "http://localhost:5173",
            devServerStatus: "running",
            devServerUrl: "http://localhost:5173",
            devServerError: { type: "unknown", message: "Previous boot warning" },
            devServerTerminalId: "dev-preview-pty-1",
            devPreviewConsoleOpen: true,
          },
        ],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    const addPanel = vi.fn().mockResolvedValue("dev-preview-1");
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();

    await hydrateAppState({
      addPanel,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
    });

    expect(addPanel).toHaveBeenCalledTimes(1);
    expect(addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "dev-preview",
        requestedId: "dev-preview-1",
        cwd: "/project",
        devCommand: "npm run dev",
        browserUrl: "http://localhost:5173",
        devPreviewConsoleOpen: true,
      })
    );

    const addPanelArg = addPanel.mock.calls[0]![0] as Record<string, unknown>;
    expect(addPanelArg.devServerStatus).toBeUndefined();
    expect(addPanelArg.devServerUrl).toBeUndefined();
    expect(addPanelArg.devServerError).toBeUndefined();
    expect(addPanelArg.devServerTerminalId).toBeUndefined();
  });

  it("rehydrates multiple dev-preview panels in one worktree without leaking runtime state", async () => {
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "dev-preview-a",
            kind: "dev-preview",
            title: "Dev Preview A",
            cwd: "/project/worktrees/feature",
            worktreeId: "wt-feature",
            location: "grid",
            command: "npm run dev",
            browserUrl: "http://localhost:5173",
            devServerStatus: "running",
            devServerUrl: "http://localhost:5173",
            devServerError: null,
            devServerTerminalId: "dev-preview-pty-a",
            devPreviewConsoleOpen: true,
          },
          {
            id: "dev-preview-b",
            kind: "dev-preview",
            title: "Dev Preview B",
            cwd: "/project/worktrees/feature",
            worktreeId: "wt-feature",
            location: "grid",
            command: "pnpm dev",
            browserUrl: "http://localhost:5174",
            devServerStatus: "error",
            devServerUrl: null,
            devServerError: { type: "unknown", message: "Previous crash" },
            devServerTerminalId: "dev-preview-pty-b",
            devPreviewConsoleOpen: false,
          },
        ],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    const addPanel = vi.fn().mockResolvedValue("panel-id");
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();

    await hydrateAppState({
      addPanel,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
    });

    expect(addPanel).toHaveBeenCalledTimes(2);
    expect(addPanel).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        kind: "dev-preview",
        requestedId: "dev-preview-a",
        worktreeId: "wt-feature",
        devCommand: "npm run dev",
        browserUrl: "http://localhost:5173",
        devPreviewConsoleOpen: true,
      })
    );
    expect(addPanel).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        kind: "dev-preview",
        requestedId: "dev-preview-b",
        worktreeId: "wt-feature",
        devCommand: "pnpm dev",
        browserUrl: "http://localhost:5174",
        devPreviewConsoleOpen: false,
      })
    );

    const firstAddArg = addPanel.mock.calls[0]![0] as Record<string, unknown>;
    const secondAddArg = addPanel.mock.calls[1]![0] as Record<string, unknown>;

    expect(firstAddArg.devServerStatus).toBeUndefined();
    expect(firstAddArg.devServerUrl).toBeUndefined();
    expect(firstAddArg.devServerError).toBeUndefined();
    expect(firstAddArg.devServerTerminalId).toBeUndefined();

    expect(secondAddArg.devServerStatus).toBeUndefined();
    expect(secondAddArg.devServerUrl).toBeUndefined();
    expect(secondAddArg.devServerError).toBeUndefined();
    expect(secondAddArg.devServerTerminalId).toBeUndefined();
  });

  it("rehydrates non-terminal panels like browser", async () => {
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "browser-1",
            kind: "browser",
            title: "Browser",
            cwd: "/project",
            location: "grid",
            browserUrl: "http://localhost:5173",
          },
          {
            id: "browser-2",
            kind: "browser",
            title: "Docs",
            cwd: "/project",
            location: "dock",
            browserUrl: "http://localhost:4000",
          },
        ],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    const addPanel = vi.fn().mockResolvedValue("panel-id");
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();

    await hydrateAppState({
      addPanel,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
    });

    expect(addPanel).toHaveBeenCalledTimes(2);
    expect(addPanel).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        kind: "browser",
        requestedId: "browser-1",
        browserUrl: "http://localhost:5173",
      })
    );
    expect(addPanel).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        kind: "browser",
        requestedId: "browser-2",
        browserUrl: "http://localhost:4000",
      })
    );
  });

  it("rehydrates terminal panels when no backend process exists", async () => {
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "terminal-1",
            kind: "terminal",
            type: "terminal",
            title: "Terminal",
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

    const addPanel = vi.fn().mockResolvedValue("terminal-1");
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();

    await hydrateAppState({
      addPanel,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
    });

    expect(addPanel).toHaveBeenCalledTimes(1);
    expect(addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "terminal",
        requestedId: "terminal-1",
        cwd: "/project",
        location: "grid",
      })
    );
  });

  it("skips phantom agent panel during project switch when not found in backend", async () => {
    // During a live project switch (switchId defined), an agent terminal that
    // can't be reconnected should be silently dropped — not respawned as a phantom.
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "agent-1",
            kind: "terminal",
            launchAgentId: "claude",
            title: "Claude",
            cwd: "/project",
            location: "grid",
            command: "claude -p 'Old prompt'",
          },
        ],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings: {
        agents: {
          claude: {
            customFlags: "--model sonnet-4",
          },
        },
      },
    });

    const addPanel = vi.fn().mockResolvedValue("agent-1");
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();

    await hydrateAppState(
      {
        addPanel,
        setActiveWorktree,
        loadRecipes,
        openDiagnosticsDock,
      },
      "switch-abc"
    );

    // Agent terminal not found during project switch → should NOT be respawned
    expect(addPanel).not.toHaveBeenCalled();
  });

  it("respawns agent panel on cold start when reconnect returns not_found", async () => {
    // On cold app restart (no switchId), not_found means the PTY process was
    // killed on quit — the agent panel should be respawned.
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "agent-1",
            kind: "terminal",
            type: "claude",
            agentId: "claude",
            title: "Claude",
            cwd: "/project",
            location: "grid",
            command: "claude -p 'Old prompt'",
          },
        ],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings: {
        agents: {
          claude: {
            customFlags: "--model sonnet-4",
          },
        },
      },
    });

    const addPanel = vi.fn().mockResolvedValue("agent-1");

    await hydrateAppState({
      addPanel,
      setActiveWorktree: vi.fn(),
      loadRecipes: vi.fn().mockResolvedValue(undefined),
      openDiagnosticsDock: vi.fn(),
    });

    // Cold start: agent panel should be respawned
    expect(addPanel).toHaveBeenCalledTimes(1);
    expect(addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "terminal",
        requestedId: "agent-1",
      })
    );
  });

  it("reconnects via fallback when getForProject misses the terminal but reconnect finds it", async () => {
    // This test verifies the reconnect fallback path - when getForProject doesn't
    // return a terminal (e.g., due to project ID mismatch), but the terminal
    // still exists in the backend and can be reconnected via direct ID lookup.
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "agent-1",
            kind: "terminal",
            type: "claude",
            agentId: "claude",
            title: "Claude Agent",
            cwd: "/project",
            location: "grid",
            command: "claude",
          },
        ],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    // getForProject returns empty (simulating project ID mismatch)
    terminalClientMock.getForProject.mockResolvedValue([]);

    // But reconnect finds the terminal in the backend
    terminalClientMock.reconnect.mockResolvedValue({
      exists: true,
      id: "agent-1",
      projectId: "project-1",
      kind: "terminal",
      launchAgentId: "claude",
      title: "Claude Agent",
      cwd: "/project",
      worktreeId: undefined,
      agentState: "waiting",
      lastStateChange: 123456789,
      spawnedAt: 123456000,
      activityTier: "background",
      hasPty: true,
    });

    const addPanel = vi.fn().mockResolvedValue("agent-1");
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();

    await hydrateAppState({
      addPanel,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
    });

    // Should have called reconnect for the agent panel
    expect(terminalClientMock.reconnect).toHaveBeenCalledWith("agent-1");

    // Should reconnect with existingId, not respawn with requestedId
    expect(addPanel).toHaveBeenCalledTimes(1);
    expect(addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "terminal",
        launchAgentId: "claude",
        existingId: "agent-1", // reconnect path uses existingId
        agentState: "waiting",
        lastStateChange: 123456789,
      })
    );

    // Should NOT have requestedId (that's the respawn path)
    expect(addPanel).not.toHaveBeenCalledWith(
      expect.objectContaining({
        requestedId: "agent-1",
      })
    );

    // Should initialize backend tier from reconnect result
    expect(initializeBackendTierMock).toHaveBeenCalledWith("agent-1", "background");

    // Scrollback restore is deferred to background — flush to verify
    await flushPostTasks();
    expect(fetchAndRestoreMock).toHaveBeenCalledWith("agent-1");
  });

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

    expect(worktreeClientMock.getAll).toHaveBeenCalledTimes(1);
    expect(projectClientMock.getTabGroups).toHaveBeenCalledWith("project-1");
  });

  it("defers non-critical snapshot restoration to lazy scroll during project-switch", async () => {
    // Track managed terminals per ID so we can simulate scroll events
    const managedTerminals = new Map<string, ReturnType<typeof makeMockManagedTerminal>>();
    getManagedTerminalMock.mockImplementation((id: string) => {
      if (!managedTerminals.has(id)) {
        managedTerminals.set(id, makeMockManagedTerminal(id));
      }
      return managedTerminals.get(id);
    });

    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "terminal-active",
            kind: "terminal",
            title: "Active",
            cwd: "/project",
            location: "grid",
            worktreeId: "wt-active",
          },
          {
            id: "terminal-background",
            kind: "terminal",
            title: "Background",
            cwd: "/project",
            location: "grid",
            worktreeId: "wt-background",
          },
          {
            id: "terminal-dock",
            kind: "terminal",
            title: "Dock",
            cwd: "/project",
            location: "dock",
            worktreeId: "wt-background",
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
        id: "terminal-active",
        hasPty: true,
        cwd: "/project",
        kind: "terminal",
        title: "Active",
        worktreeId: "wt-active",
      },
      {
        id: "terminal-background",
        hasPty: true,
        cwd: "/project",
        kind: "terminal",
        title: "Background",
        worktreeId: "wt-background",
      },
      {
        id: "terminal-dock",
        hasPty: true,
        cwd: "/project",
        kind: "terminal",
        title: "Dock",
        worktreeId: "wt-background",
      },
    ]);

    const addPanel = vi.fn(async (options: { existingId?: string; requestedId?: string }) => {
      return options.existingId ?? options.requestedId ?? "terminal-id";
    });

    await hydrateAppState(
      {
        addPanel,
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockResolvedValue(undefined),
        openDiagnosticsDock: vi.fn(),
      },
      "switch-1",
      () => true
    );

    // Nothing restored yet — all scheduled as background or lazy
    expect(fetchAndRestoreMock).not.toHaveBeenCalled();

    // Flush background tasks — critical terminals (active + dock) get restored
    await flushPostTasks();

    expect(fetchAndRestoreMock).toHaveBeenCalledWith("terminal-active");
    expect(fetchAndRestoreMock).toHaveBeenCalledWith("terminal-dock");
    expect(fetchAndRestoreMock).not.toHaveBeenCalledWith("terminal-background");

    // Background terminal restores lazily — simulate scroll event on its host element
    const bgManaged = managedTerminals.get("terminal-background")!;
    expect(bgManaged.scrollbackRestoreState).toBe("pending");

    bgManaged.hostElement.dispatchEvent(new Event("wheel"));
    await flushPostTasks();

    expect(fetchAndRestoreMock).toHaveBeenCalledWith("terminal-background");
  });

  it("skips snapshot fetch for warm cached terminal instances during switch-back hydration", async () => {
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

    isTerminalWarmInProjectSwitchCacheMock.mockReturnValue(true);

    // Warm cached terminals already have their scrollback loaded, so
    // scheduleScrollbackRestore skips them (scrollbackRestoreState !== "none").
    getManagedTerminalMock.mockImplementation((id: string) => {
      if (id === "terminal-cached") {
        return {
          id,
          scrollbackRestoreState: "done",
          scrollbackRestoreDisposable: undefined,
          hostElement: document.createElement("div"),
          listeners: [] as Array<() => void>,
        };
      }
      return makeMockManagedTerminal(id);
    });

    const addPanel = vi.fn(async (options: { existingId?: string; requestedId?: string }) => {
      return options.existingId ?? options.requestedId ?? "terminal-id";
    });

    await hydrateAppState(
      {
        addPanel,
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockResolvedValue(undefined),
        openDiagnosticsDock: vi.fn(),
      },
      "switch-cached",
      () => true
    );

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

  it("does not block project-switch hydration on recipe loading", async () => {
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

    const hydratePromise = hydrateAppState(
      {
        addPanel: vi.fn().mockResolvedValue("terminal-id"),
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockReturnValue(pendingRecipes),
        openDiagnosticsDock: vi.fn(),
      },
      "switch-2",
      () => true
    );

    await expect(hydratePromise).resolves.toBeUndefined();
    resolveRecipes();
    await pendingRecipes;
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

    const hydratePromise = hydrateAppState(
      {
        addPanel: vi.fn().mockResolvedValue("terminal-id"),
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockReturnValue(pendingRecipes),
        openDiagnosticsDock: vi.fn(),
      },
      undefined,
      () => true
    );

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

    // Verify tab groups were fetched for the current project
    expect(projectClientMock.getTabGroups).toHaveBeenCalledWith("project-1");

    // Verify hydrateTabGroups was called with the persisted groups
    expect(hydrateTabGroups).toHaveBeenCalledTimes(1);
    expect(hydrateTabGroups).toHaveBeenCalledWith(persistedTabGroups);
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

  it("skips phantom agent with agentSessionId during project switch when not found in backend", async () => {
    // During project switch, agent with agentSessionId but no backend process
    // should be dropped — it would create a phantom panel.
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "agent-1",
            kind: "terminal",
            launchAgentId: "claude",
            title: "Claude",
            cwd: "/project",
            location: "grid",
            command: "claude --model sonnet-4",
            agentSessionId: "session-uuid-123",
          },
        ],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings: {
        agents: {
          claude: { customFlags: "--model sonnet-4" },
        },
      },
    });

    const addPanel = vi.fn().mockResolvedValue("agent-1");

    await hydrateAppState(
      {
        addPanel,
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockResolvedValue(undefined),
        openDiagnosticsDock: vi.fn(),
      },
      "switch-abc"
    );

    // Phantom agent during project switch should NOT be respawned
    expect(addPanel).not.toHaveBeenCalled();
  });

  it("skips phantom agent without agentSessionId during project switch when not found in backend", async () => {
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "agent-1",
            kind: "terminal",
            launchAgentId: "claude",
            title: "Claude",
            cwd: "/project",
            location: "grid",
            command: "claude",
          },
        ],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings: {
        agents: {
          claude: { customFlags: "--model sonnet-4" },
        },
      },
    });

    const addPanel = vi.fn().mockResolvedValue("agent-1");

    await hydrateAppState(
      {
        addPanel,
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockResolvedValue(undefined),
        openDiagnosticsDock: vi.fn(),
      },
      "switch-abc"
    );

    // Phantom agent during project switch should NOT be respawned
    expect(addPanel).not.toHaveBeenCalled();
  });

  it("respawns agent panel with agentSessionId on cold start when not found in backend", async () => {
    // On cold restart (no switchId), agent with agentSessionId should be
    // respawned — not_found means PTY was killed on quit.
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "agent-1",
            kind: "terminal",
            type: "claude",
            agentId: "claude",
            title: "Claude",
            cwd: "/project",
            location: "grid",
            command: "claude --model sonnet-4",
            agentSessionId: "session-uuid-123",
          },
        ],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings: {
        agents: {
          claude: { customFlags: "--model sonnet-4" },
        },
      },
    });

    const addPanel = vi.fn().mockResolvedValue("agent-1");

    await hydrateAppState({
      addPanel,
      setActiveWorktree: vi.fn(),
      loadRecipes: vi.fn().mockResolvedValue(undefined),
      openDiagnosticsDock: vi.fn(),
    });

    // Cold start: agent panel should be respawned
    expect(addPanel).toHaveBeenCalledTimes(1);
    expect(addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "terminal",
        requestedId: "agent-1",
      })
    );
  });

  it("preserves agentSessionId on successful reconnect to live backend", async () => {
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "agent-1",
            kind: "terminal",
            type: "claude",
            agentId: "claude",
            title: "Claude",
            cwd: "/project",
            location: "grid",
            command: "claude",
            agentSessionId: "session-uuid-456",
          },
        ],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    // Backend has the terminal running
    terminalClientMock.getForProject.mockResolvedValue([
      {
        id: "agent-1",
        hasPty: true,
        cwd: "/project",
        kind: "terminal",
        type: "claude",
        agentId: "claude",
        title: "Claude",
        agentState: "waiting",
        lastStateChange: 123456789,
      },
    ]);

    const addPanel = vi.fn().mockResolvedValue("agent-1");
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();

    await hydrateAppState({
      addPanel,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
    });

    expect(addPanel).toHaveBeenCalledTimes(1);
    const callArgs = addPanel.mock.calls[0]![0];

    // On reconnect, agentSessionId should be preserved
    expect(callArgs.existingId).toBe("agent-1");
    expect(callArgs.agentSessionId).toBe("session-uuid-456");
  });

  it("restores active worktree panels before background worktree panels", async () => {
    const callOrder: string[] = [];

    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "bg-1",
            title: "BG Terminal 1",
            cwd: "/project",
            worktreeId: "wt-bg",
            location: "grid",
            type: "terminal",
          },
          {
            id: "bg-2",
            title: "BG Terminal 2",
            cwd: "/project",
            worktreeId: "wt-bg",
            location: "grid",
            type: "terminal",
          },
          {
            id: "active-1",
            title: "Active Terminal",
            cwd: "/project",
            worktreeId: "wt-active",
            location: "grid",
            type: "terminal",
          },
          {
            id: "bg-3",
            title: "BG Terminal 3",
            cwd: "/project",
            worktreeId: "wt-bg2",
            location: "grid",
            type: "terminal",
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
        id: "bg-1",
        cwd: "/project",
        worktreeId: "wt-bg",
        title: "BG Terminal 1",
        type: "terminal",
        kind: "terminal",
      },
      {
        id: "bg-2",
        cwd: "/project",
        worktreeId: "wt-bg",
        title: "BG Terminal 2",
        type: "terminal",
        kind: "terminal",
      },
      {
        id: "active-1",
        cwd: "/project",
        worktreeId: "wt-active",
        title: "Active Terminal",
        type: "terminal",
        kind: "terminal",
      },
      {
        id: "bg-3",
        cwd: "/project",
        worktreeId: "wt-bg2",
        title: "BG Terminal 3",
        type: "terminal",
        kind: "terminal",
      },
    ]);

    const addPanel = vi.fn().mockImplementation((opts: { existingId?: string }) => {
      callOrder.push(opts.existingId ?? "unknown");
      return Promise.resolve(opts.existingId ?? "id");
    });
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();

    await hydrateAppState({
      addPanel,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
    });

    expect(addPanel).toHaveBeenCalledTimes(4);

    // Active worktree panel should be restored first
    expect(callOrder[0]).toBe("active-1");

    // Background panels should come after
    expect(callOrder.slice(1).sort()).toEqual(["bg-1", "bg-2", "bg-3"]);
  });

  it("passes restore: true on respawned terminals", async () => {
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "term-1",
            title: "Terminal 1",
            cwd: "/project",
            location: "grid",
            type: "terminal",
          },
        ],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    // No backend terminal → will attempt reconnect fallback → respawn
    terminalClientMock.getForProject.mockResolvedValue([]);

    const addPanel = vi.fn().mockResolvedValue("term-1");
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();

    await hydrateAppState({
      addPanel,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
    });

    expect(addPanel).toHaveBeenCalledTimes(1);
    const callArgs = addPanel.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArgs.restore).toBe(true);
  });

  it("does not pass restore on reconnected terminals", async () => {
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "term-1",
            title: "Terminal 1",
            cwd: "/project",
            location: "grid",
            type: "terminal",
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
        id: "term-1",
        cwd: "/project",
        title: "Terminal 1",
        type: "terminal",
        kind: "terminal",
      },
    ]);

    const addPanel = vi.fn().mockResolvedValue("term-1");
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();

    await hydrateAppState({
      addPanel,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
    });

    expect(addPanel).toHaveBeenCalledTimes(1);
    const callArgs = addPanel.mock.calls[0]![0] as Record<string, unknown>;
    // Reconnects should not have restore flag
    expect(callArgs.restore).toBeUndefined();
  });

  it("isolates failures within a batch using Promise.allSettled semantics", async () => {
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "fail-1",
            title: "Fail Terminal",
            cwd: "/project",
            worktreeId: "wt-bg",
            location: "grid",
            type: "terminal",
          },
          {
            id: "success-1",
            title: "Success Terminal",
            cwd: "/project",
            worktreeId: "wt-bg",
            location: "grid",
            type: "terminal",
          },
        ],
        activeWorktreeId: "wt-active",
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    // No backend terminals → respawn path
    terminalClientMock.getForProject.mockResolvedValue([]);

    let callCount = 0;
    const addPanel = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error("Spawn failed"));
      }
      return Promise.resolve("success-1");
    });
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();

    // Should not throw despite first panel failing
    await expect(
      hydrateAppState({
        addPanel,
        setActiveWorktree,
        loadRecipes,
        openDiagnosticsDock,
      })
    ).resolves.toBeUndefined();

    // Both should have been attempted
    expect(addPanel).toHaveBeenCalledTimes(2);
  });

  it("restores non-PTY panels before PTY panels are added", async () => {
    const callOrder: string[] = [];

    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "term-1",
            kind: "terminal",
            title: "Terminal",
            cwd: "/project",
            location: "grid",
            type: "terminal",
          },
          {
            id: "browser-1",
            kind: "browser",
            title: "Browser",
            cwd: "/project",
            location: "grid",
            browserUrl: "http://localhost:3000",
          },
          {
            id: "browser-2",
            kind: "browser",
            title: "Docs",
            cwd: "/project",
            location: "grid",
            browserUrl: "http://localhost:4000",
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
        id: "term-1",
        cwd: "/project",
        title: "Terminal",
        type: "terminal",
        kind: "terminal",
      },
    ]);

    const addPanel = vi
      .fn()
      .mockImplementation((opts: { kind?: string; requestedId?: string; existingId?: string }) => {
        callOrder.push(`${opts.kind ?? "unknown"}:${opts.requestedId ?? opts.existingId}`);
        return Promise.resolve(opts.requestedId ?? opts.existingId ?? "id");
      });
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();

    await hydrateAppState({
      addPanel,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
    });

    expect(addPanel).toHaveBeenCalledTimes(3);

    // Non-PTY panels (browser) should be restored before PTY panel (terminal)
    const terminalIdx = callOrder.findIndex((c) => c.startsWith("terminal:"));
    const browser1Idx = callOrder.indexOf("browser:browser-1");
    const browser2Idx = callOrder.indexOf("browser:browser-2");

    expect(browser1Idx).toBeLessThan(terminalIdx);
    expect(browser2Idx).toBeLessThan(terminalIdx);
  });

  it("preserves order for all-non-PTY panel workspace", async () => {
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "browser-1",
            kind: "browser",
            title: "Browser 1",
            cwd: "/project",
            location: "grid",
            browserUrl: "http://localhost:3000",
          },
          {
            id: "browser-2",
            kind: "browser",
            title: "Browser 2",
            cwd: "/project",
            location: "grid",
            browserUrl: "http://localhost:4000",
          },
          {
            id: "dev-preview-1",
            kind: "dev-preview",
            title: "Dev Preview",
            cwd: "/project",
            location: "grid",
            command: "npm run dev",
            browserUrl: "http://localhost:5173",
          },
        ],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    const addPanel = vi.fn().mockImplementation((opts: { requestedId?: string }) => {
      return Promise.resolve(opts.requestedId ?? "id");
    });
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();

    await hydrateAppState({
      addPanel,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
    });

    expect(addPanel).toHaveBeenCalledTimes(3);

    // All three non-PTY panels should be restored with correct kinds in order
    expect(addPanel.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ kind: "browser", requestedId: "browser-1" })
    );
    expect(addPanel.mock.calls[1]![0]).toEqual(
      expect.objectContaining({ kind: "browser", requestedId: "browser-2" })
    );
    expect(addPanel.mock.calls[2]![0]).toEqual(
      expect.objectContaining({ kind: "dev-preview", requestedId: "dev-preview-1" })
    );
  });

  it("restores non-PTY panels from mixed worktrees concurrently before PTY panels", async () => {
    const callOrder: string[] = [];

    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "term-active",
            kind: "terminal",
            title: "Active Terminal",
            cwd: "/project",
            worktreeId: "wt-active",
            location: "grid",
            type: "terminal",
          },
          {
            id: "browser-bg",
            kind: "browser",
            title: "BG Browser",
            cwd: "/project",
            worktreeId: "wt-bg",
            location: "grid",
            browserUrl: "http://localhost:3000",
          },
          {
            id: "browser-active",
            kind: "browser",
            title: "Active Browser",
            cwd: "/project",
            worktreeId: "wt-active",
            location: "grid",
            browserUrl: "http://localhost:4000",
          },
          {
            id: "term-bg",
            kind: "terminal",
            title: "BG Terminal",
            cwd: "/project",
            worktreeId: "wt-bg",
            location: "grid",
            type: "terminal",
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
        id: "term-active",
        cwd: "/project",
        worktreeId: "wt-active",
        title: "Active Terminal",
        type: "terminal",
        kind: "terminal",
      },
      {
        id: "term-bg",
        cwd: "/project",
        worktreeId: "wt-bg",
        title: "BG Terminal",
        type: "terminal",
        kind: "terminal",
      },
    ]);

    const addPanel = vi
      .fn()
      .mockImplementation((opts: { kind?: string; requestedId?: string; existingId?: string }) => {
        callOrder.push(`${opts.kind}:${opts.requestedId ?? opts.existingId}`);
        return Promise.resolve(opts.requestedId ?? opts.existingId ?? "id");
      });
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();

    await hydrateAppState({
      addPanel,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
    });

    expect(addPanel).toHaveBeenCalledTimes(4);

    // Both non-PTY panels (from different worktrees) should come before either PTY panel
    const browserBgIdx = callOrder.indexOf("browser:browser-bg");
    const browserActiveIdx = callOrder.indexOf("browser:browser-active");
    const firstPtyIdx = callOrder.findIndex((c) => c.startsWith("terminal:"));

    expect(browserBgIdx).toBeLessThan(firstPtyIdx);
    expect(browserActiveIdx).toBeLessThan(firstPtyIdx);
  });

  it("treats dev-preview with backend terminal as PTY-grouped", async () => {
    const callOrder: string[] = [];

    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          {
            id: "browser-1",
            kind: "browser",
            title: "Browser",
            cwd: "/project",
            location: "grid",
            browserUrl: "http://localhost:3000",
          },
          {
            id: "dev-preview-1",
            kind: "dev-preview",
            title: "Dev Preview",
            cwd: "/project",
            location: "grid",
            command: "npm run dev",
            browserUrl: "http://localhost:5173",
          },
        ],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    // dev-preview-1 has a live backend terminal — should be treated as PTY
    terminalClientMock.getForProject.mockResolvedValue([
      {
        id: "dev-preview-1",
        cwd: "/project",
        title: "Dev Preview",
        type: "dev-preview",
        kind: "dev-preview",
      },
    ]);

    const addPanel = vi
      .fn()
      .mockImplementation((opts: { kind?: string; requestedId?: string; existingId?: string }) => {
        callOrder.push(opts.kind ?? "unknown");
        return Promise.resolve(opts.requestedId ?? opts.existingId ?? "id");
      });
    const setActiveWorktree = vi.fn();
    const loadRecipes = vi.fn().mockResolvedValue(undefined);
    const openDiagnosticsDock = vi.fn();

    await hydrateAppState({
      addPanel,
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
    });

    expect(addPanel).toHaveBeenCalledTimes(2);

    // Browser (non-PTY, no backend) should come before dev-preview (has backend terminal)
    const browserIdx = callOrder.indexOf("browser");
    const devPreviewIdx = callOrder.indexOf("dev-preview");

    expect(browserIdx).toBeLessThan(devPreviewIdx);
  });

  it("calls setGPUHardwareAvailable(false) when gpuWebGLHardware is false", async () => {
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
      gpuWebGLHardware: false,
    });

    await hydrateAppState({
      addPanel: vi.fn().mockResolvedValue("terminal-id"),
      setActiveWorktree: vi.fn(),
      loadRecipes: vi.fn().mockResolvedValue(undefined),
      openDiagnosticsDock: vi.fn(),
    });

    expect(setGPUHardwareAvailableMock).toHaveBeenCalledTimes(1);
    expect(setGPUHardwareAvailableMock).toHaveBeenCalledWith(false);
  });

  it("calls setGPUHardwareAvailable(true) when gpuWebGLHardware is true", async () => {
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
      gpuWebGLHardware: true,
    });

    await hydrateAppState({
      addPanel: vi.fn().mockResolvedValue("terminal-id"),
      setActiveWorktree: vi.fn(),
      loadRecipes: vi.fn().mockResolvedValue(undefined),
      openDiagnosticsDock: vi.fn(),
    });

    expect(setGPUHardwareAvailableMock).toHaveBeenCalledTimes(1);
    expect(setGPUHardwareAvailableMock).toHaveBeenCalledWith(true);
  });

  it("defaults to setGPUHardwareAvailable(true) when gpuWebGLHardware is absent", async () => {
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
    });

    await hydrateAppState({
      addPanel: vi.fn().mockResolvedValue("terminal-id"),
      setActiveWorktree: vi.fn(),
      loadRecipes: vi.fn().mockResolvedValue(undefined),
      openDiagnosticsDock: vi.fn(),
    });

    expect(setGPUHardwareAvailableMock).toHaveBeenCalledTimes(1);
    expect(setGPUHardwareAvailableMock).toHaveBeenCalledWith(true);
  });

  describe("settings recovery notifications", () => {
    it("shows warning toast when settings restored from backup", async () => {
      appClientMock.hydrate.mockResolvedValue({
        appState: { terminals: [], sidebarWidth: 350 },
        terminalConfig,
        project,
        agentSettings,
        settingsRecovery: {
          kind: "restored-from-backup",
          quarantinedPath: "/path/to/config.json.corrupted.123",
        },
      });

      await hydrateAppState({
        addPanel: vi.fn().mockResolvedValue("terminal-id"),
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockResolvedValue(undefined),
        openDiagnosticsDock: vi.fn(),
      });

      expect(notifyMock).toHaveBeenCalledTimes(1);
      expect(notifyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "warning",
          title: "Settings restored from backup",
          priority: "high",
          duration: 8000,
        })
      );
      expect(notifyMock.mock.calls[0]![0].message).toContain("restored from a backup");
      expect(notifyMock.mock.calls[0]![0].message).toContain("/path/to/config.json.corrupted.123");
    });

    it("shows persistent warning toast when settings reset to defaults", async () => {
      appClientMock.hydrate.mockResolvedValue({
        appState: { terminals: [], sidebarWidth: 350 },
        terminalConfig,
        project,
        agentSettings,
        settingsRecovery: {
          kind: "reset-to-defaults",
          quarantinedPath: "/path/to/config.json.corrupted.456",
        },
      });

      await hydrateAppState({
        addPanel: vi.fn().mockResolvedValue("terminal-id"),
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockResolvedValue(undefined),
        openDiagnosticsDock: vi.fn(),
      });

      expect(notifyMock).toHaveBeenCalledTimes(1);
      expect(notifyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "warning",
          title: "Settings reset to defaults",
          priority: "high",
          duration: 0,
        })
      );
      expect(notifyMock.mock.calls[0]![0].message).toContain("reset to defaults");
      expect(notifyMock.mock.calls[0]![0].message).toContain("/path/to/config.json.corrupted.456");
    });

    it("does not show notification on normal startup", async () => {
      appClientMock.hydrate.mockResolvedValue({
        appState: { terminals: [], sidebarWidth: 350 },
        terminalConfig,
        project,
        agentSettings,
      });

      await hydrateAppState({
        addPanel: vi.fn().mockResolvedValue("terminal-id"),
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockResolvedValue(undefined),
        openDiagnosticsDock: vi.fn(),
      });

      expect(notifyMock).not.toHaveBeenCalled();
    });

    it("omits path note when quarantinedPath is absent", async () => {
      appClientMock.hydrate.mockResolvedValue({
        appState: { terminals: [], sidebarWidth: 350 },
        terminalConfig,
        project,
        agentSettings,
        settingsRecovery: { kind: "reset-to-defaults" },
      });

      await hydrateAppState({
        addPanel: vi.fn().mockResolvedValue("terminal-id"),
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockResolvedValue(undefined),
        openDiagnosticsDock: vi.fn(),
      });

      expect(notifyMock).toHaveBeenCalledTimes(1);
      expect(notifyMock.mock.calls[0]![0].message).not.toContain("preserved at");
    });
  });

  describe("project state recovery notifications", () => {
    it("shows persistent warning toast when project state was quarantined", async () => {
      appClientMock.hydrate.mockResolvedValue({
        appState: { terminals: [], sidebarWidth: 350 },
        terminalConfig,
        project,
        agentSettings,
        projectStateRecovery: {
          quarantinedPath: "/path/to/state.json.corrupted",
        },
      });

      await hydrateAppState({
        addPanel: vi.fn().mockResolvedValue("terminal-id"),
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockResolvedValue(undefined),
        openDiagnosticsDock: vi.fn(),
      });

      expect(notifyMock).toHaveBeenCalledTimes(1);
      expect(notifyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "warning",
          title: "Project state corrupted",
          priority: "high",
          duration: 0,
        })
      );
      expect(notifyMock.mock.calls[0]![0].message).toContain("/path/to/state.json.corrupted");
      expect(notifyMock.mock.calls[0]![0].message).toContain("has been reset");
    });

    it("does not show notification when projectStateRecovery is null", async () => {
      appClientMock.hydrate.mockResolvedValue({
        appState: { terminals: [], sidebarWidth: 350 },
        terminalConfig,
        project,
        agentSettings,
        projectStateRecovery: null,
      });

      await hydrateAppState({
        addPanel: vi.fn().mockResolvedValue("terminal-id"),
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockResolvedValue(undefined),
        openDiagnosticsDock: vi.fn(),
      });

      expect(notifyMock).not.toHaveBeenCalled();
    });

    it("does not show notification when projectStateRecovery is omitted", async () => {
      appClientMock.hydrate.mockResolvedValue({
        appState: { terminals: [], sidebarWidth: 350 },
        terminalConfig,
        project,
        agentSettings,
      });

      await hydrateAppState({
        addPanel: vi.fn().mockResolvedValue("terminal-id"),
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockResolvedValue(undefined),
        openDiagnosticsDock: vi.fn(),
      });

      expect(notifyMock).not.toHaveBeenCalled();
    });

    it("shows both settings and project state notifications when both recoveries occur", async () => {
      appClientMock.hydrate.mockResolvedValue({
        appState: { terminals: [], sidebarWidth: 350 },
        terminalConfig,
        project,
        agentSettings,
        settingsRecovery: {
          kind: "reset-to-defaults",
          quarantinedPath: "/path/to/config.json.corrupted",
        },
        projectStateRecovery: {
          quarantinedPath: "/path/to/state.json.corrupted",
        },
      });

      await hydrateAppState({
        addPanel: vi.fn().mockResolvedValue("terminal-id"),
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockResolvedValue(undefined),
        openDiagnosticsDock: vi.fn(),
      });

      expect(notifyMock).toHaveBeenCalledTimes(2);
      const titles = notifyMock.mock.calls.map((call) => call[0].title);
      expect(titles).toContain("Settings reset to defaults");
      expect(titles).toContain("Project state corrupted");
    });
  });

  describe("orphan filter for default terminals", () => {
    it("filters out default-N orphan when no saved panels exist (brand-new project)", async () => {
      appClientMock.hydrate.mockResolvedValue({
        appState: {
          terminals: [],
          sidebarWidth: 350,
        },
        terminalConfig,
        project,
        agentSettings,
      });

      terminalClientMock.getForProject.mockResolvedValue([
        {
          id: "default-1",
          hasPty: true,
          cwd: "/home/user",
          kind: "terminal",
          title: "Terminal",
        },
      ]);

      const addPanel = vi.fn().mockResolvedValue("default-1");

      await hydrateAppState({
        addPanel,
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockResolvedValue(undefined),
        openDiagnosticsDock: vi.fn(),
      });

      expect(addPanel).not.toHaveBeenCalled();
    });

    it("allows non-default orphans through when no saved panels exist", async () => {
      appClientMock.hydrate.mockResolvedValue({
        appState: {
          terminals: [],
          sidebarWidth: 350,
        },
        terminalConfig,
        project,
        agentSettings,
      });

      terminalClientMock.getForProject.mockResolvedValue([
        {
          id: "orphan-term-1",
          hasPty: true,
          cwd: "/project",
          kind: "terminal",
          title: "Orphan",
        },
      ]);

      const addPanel = vi.fn().mockResolvedValue("orphan-term-1");

      await hydrateAppState({
        addPanel,
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockResolvedValue(undefined),
        openDiagnosticsDock: vi.fn(),
      });

      expect(addPanel).toHaveBeenCalledTimes(1);
      expect(addPanel).toHaveBeenCalledWith(
        expect.objectContaining({ existingId: "orphan-term-1" })
      );
    });

    it("allows default-N orphan through when saved panels exist (restart scenario)", async () => {
      appClientMock.hydrate.mockResolvedValue({
        appState: {
          terminals: [
            {
              id: "terminal-1",
              kind: "terminal",
              title: "Saved Terminal",
              cwd: "/project",
              location: "grid",
              type: "terminal",
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
          title: "Saved Terminal",
        },
        {
          id: "default-1",
          hasPty: true,
          cwd: "/home/user",
          kind: "terminal",
          title: "Default",
        },
      ]);

      const addPanel = vi
        .fn()
        .mockImplementation((opts: { existingId?: string; requestedId?: string }) =>
          Promise.resolve(opts.existingId ?? opts.requestedId ?? "id")
        );

      await hydrateAppState({
        addPanel,
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockResolvedValue(undefined),
        openDiagnosticsDock: vi.fn(),
      });

      // terminal-1 is restored from saved state, default-1 passes through as orphan
      expect(addPanel).toHaveBeenCalledTimes(2);
      expect(addPanel).toHaveBeenCalledWith(expect.objectContaining({ existingId: "default-1" }));
    });
  });

  describe("phantom agent terminal prevention", () => {
    it("drops dead orphan backend terminals (hasPty: false)", async () => {
      appClientMock.hydrate.mockResolvedValue({
        appState: {
          terminals: [],
          sidebarWidth: 350,
        },
        terminalConfig,
        project,
        agentSettings,
      });

      terminalClientMock.getForProject.mockResolvedValue([
        {
          id: "dead-agent-1",
          hasPty: false,
          cwd: "/project",
          kind: "terminal",
          type: "claude",
          agentId: "claude",
          title: "Claude",
        },
      ]);

      const addPanel = vi.fn().mockResolvedValue("dead-agent-1");

      await hydrateAppState({
        addPanel,
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockResolvedValue(undefined),
        openDiagnosticsDock: vi.fn(),
      });

      expect(addPanel).not.toHaveBeenCalled();
    });

    it("drops dead non-agent orphan backend terminals (hasPty: false)", async () => {
      appClientMock.hydrate.mockResolvedValue({
        appState: {
          terminals: [],
          sidebarWidth: 350,
        },
        terminalConfig,
        project,
        agentSettings,
      });

      terminalClientMock.getForProject.mockResolvedValue([
        {
          id: "dead-term-1",
          hasPty: false,
          cwd: "/project",
          kind: "terminal",
          title: "Terminal",
        },
      ]);

      const addPanel = vi.fn().mockResolvedValue("dead-term-1");

      await hydrateAppState({
        addPanel,
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockResolvedValue(undefined),
        openDiagnosticsDock: vi.fn(),
      });

      expect(addPanel).not.toHaveBeenCalled();
    });

    it("keeps live orphan backend terminals (hasPty: true)", async () => {
      appClientMock.hydrate.mockResolvedValue({
        appState: {
          terminals: [],
          sidebarWidth: 350,
        },
        terminalConfig,
        project,
        agentSettings,
      });

      terminalClientMock.getForProject.mockResolvedValue([
        {
          id: "live-agent-1",
          hasPty: true,
          cwd: "/project",
          kind: "terminal",
          type: "claude",
          agentId: "claude",
          title: "Claude",
        },
      ]);

      const addPanel = vi.fn().mockResolvedValue("live-agent-1");

      await hydrateAppState({
        addPanel,
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockResolvedValue(undefined),
        openDiagnosticsDock: vi.fn(),
      });

      expect(addPanel).toHaveBeenCalledTimes(1);
      expect(addPanel).toHaveBeenCalledWith(
        expect.objectContaining({ existingId: "live-agent-1" })
      );
    });

    it("keeps orphan with hasPty: undefined (treat as alive)", async () => {
      appClientMock.hydrate.mockResolvedValue({
        appState: {
          terminals: [],
          sidebarWidth: 350,
        },
        terminalConfig,
        project,
        agentSettings,
      });

      terminalClientMock.getForProject.mockResolvedValue([
        {
          id: "orphan-1",
          cwd: "/project",
          kind: "terminal",
          title: "Terminal",
          // hasPty is undefined — should be treated as alive
        },
      ]);

      const addPanel = vi.fn().mockResolvedValue("orphan-1");

      await hydrateAppState({
        addPanel,
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockResolvedValue(undefined),
        openDiagnosticsDock: vi.fn(),
      });

      expect(addPanel).toHaveBeenCalledTimes(1);
      expect(addPanel).toHaveBeenCalledWith(expect.objectContaining({ existingId: "orphan-1" }));
    });

    it("skips matched dead agent backend terminal and prevents orphan leak", async () => {
      appClientMock.hydrate.mockResolvedValue({
        appState: {
          terminals: [
            {
              id: "agent-1",
              kind: "terminal",
              launchAgentId: "claude",
              title: "Claude",
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
          id: "agent-1",
          hasPty: false,
          cwd: "/project",
          kind: "terminal",
          launchAgentId: "claude",
          title: "Claude",
        },
      ]);

      const addPanel = vi.fn().mockResolvedValue("agent-1");

      await hydrateAppState({
        addPanel,
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockResolvedValue(undefined),
        openDiagnosticsDock: vi.fn(),
      });

      // Dead agent backend match should be skipped AND not appear as orphan
      expect(addPanel).not.toHaveBeenCalled();
    });

    it("keeps matched dead non-agent backend terminal (shows exit state)", async () => {
      appClientMock.hydrate.mockResolvedValue({
        appState: {
          terminals: [
            {
              id: "term-1",
              kind: "terminal",
              type: "terminal",
              title: "Terminal",
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
          id: "term-1",
          hasPty: false,
          cwd: "/project",
          kind: "terminal",
          title: "Terminal",
        },
      ]);

      const addPanel = vi.fn().mockResolvedValue("term-1");

      await hydrateAppState({
        addPanel,
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockResolvedValue(undefined),
        openDiagnosticsDock: vi.fn(),
      });

      // Non-agent dead backend terminal still restores (exit state is useful)
      expect(addPanel).toHaveBeenCalledTimes(1);
    });

    it("still respawns agent on reconnect timeout (network issue)", async () => {
      appClientMock.hydrate.mockResolvedValue({
        appState: {
          terminals: [
            {
              id: "agent-1",
              kind: "terminal",
              type: "claude",
              agentId: "claude",
              title: "Claude",
              cwd: "/project",
              location: "grid",
              command: "claude",
            },
          ],
          sidebarWidth: 350,
        },
        terminalConfig,
        project,
        agentSettings: {
          agents: {
            claude: { customFlags: "--model sonnet-4" },
          },
        },
      });

      // getForProject returns empty
      terminalClientMock.getForProject.mockResolvedValue([]);
      // reconnect times out
      terminalClientMock.reconnect.mockImplementation(
        () =>
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Reconnection timeout")), 10)
          )
      );

      const addPanel = vi.fn().mockResolvedValue("agent-1");

      await hydrateAppState({
        addPanel,
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockResolvedValue(undefined),
        openDiagnosticsDock: vi.fn(),
      });

      // Agent should still respawn on timeout (could be a temporary network issue)
      expect(addPanel).toHaveBeenCalledTimes(1);
      expect(addPanel).toHaveBeenCalledWith(expect.objectContaining({ kind: "terminal" }));
    });

    it("still respawns non-agent terminal when not found in backend", async () => {
      appClientMock.hydrate.mockResolvedValue({
        appState: {
          terminals: [
            {
              id: "term-1",
              kind: "terminal",
              type: "terminal",
              title: "Terminal",
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

      terminalClientMock.getForProject.mockResolvedValue([]);

      const addPanel = vi.fn().mockResolvedValue("term-1");

      await hydrateAppState({
        addPanel,
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockResolvedValue(undefined),
        openDiagnosticsDock: vi.fn(),
      });

      // Non-agent terminals should still respawn when not found
      expect(addPanel).toHaveBeenCalledTimes(1);
      expect(addPanel).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "terminal", requestedId: "term-1" })
      );
    });

    it("skips older agent snapshot with type but no kind during project switch when not found", async () => {
      appClientMock.hydrate.mockResolvedValue({
        appState: {
          terminals: [
            {
              id: "agent-old",
              launchAgentId: "claude",
              title: "Claude",
              cwd: "/project",
              location: "grid",
              command: "claude",
            },
          ],
          sidebarWidth: 350,
        },
        terminalConfig,
        project,
        agentSettings,
      });

      terminalClientMock.getForProject.mockResolvedValue([]);

      const addPanel = vi.fn().mockResolvedValue("agent-old");

      await hydrateAppState(
        {
          addPanel,
          setActiveWorktree: vi.fn(),
          loadRecipes: vi.fn().mockResolvedValue(undefined),
          openDiagnosticsDock: vi.fn(),
        },
        "switch-abc"
      );

      // Older agent snapshots (type: "claude" but no kind) should be skipped during project switch
      expect(addPanel).not.toHaveBeenCalled();
    });
  });

  describe("live agent identity replayable across view rebuild", () => {
    // View eviction / window rebuild drops the renderer V8 context and store, so
    // the main process is the sole source of truth for live agent identity.
    // These cases lock down the contract that the four identity dimensions —
    // launch intent (agentId), live detected identity (detectedAgentId /
    // detectedProcessId), capability mode (capabilityAgentId), and current state
    // (agentState, everDetectedAgent) — survive the hydration pipeline verbatim
    // and reach addPanel without invention or loss.

    function makeBackendAgentEntry(overrides: Record<string, unknown> = {}) {
      return {
        id: "agent-1",
        hasPty: true,
        cwd: "/project",
        kind: "terminal",
        launchAgentId: "claude",
        title: "Claude",
        agentState: "working",
        lastStateChange: 123456789,
        everDetectedAgent: true,
        detectedAgentId: "claude",
        detectedProcessId: "claude-12345",
        ...overrides,
      };
    }

    function makeSavedAgentPanel(overrides: Record<string, unknown> = {}) {
      return {
        id: "agent-1",
        kind: "terminal",
        launchAgentId: "claude",
        title: "Claude",
        cwd: "/project",
        location: "grid",
        command: "claude",
        ...overrides,
      };
    }

    it("carries full identity payload (agentId + detected + capability + state) through getForProject into addPanel", async () => {
      appClientMock.hydrate.mockResolvedValue({
        appState: {
          terminals: [makeSavedAgentPanel()],
          sidebarWidth: 350,
        },
        terminalConfig,
        project,
        agentSettings,
      });

      terminalClientMock.getForProject.mockResolvedValue([makeBackendAgentEntry()]);

      const addPanel = vi.fn(async (opts: Record<string, unknown>) => {
        return (
          (opts.existingId as string | undefined) ??
          (opts.requestedId as string | undefined) ??
          "id"
        );
      });

      await hydrateAppState({
        addPanel,
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockResolvedValue(undefined),
        openDiagnosticsDock: vi.fn(),
      });

      expect(addPanel).toHaveBeenCalledTimes(1);
      expect(addPanel).toHaveBeenCalledWith(
        expect.objectContaining({
          existingId: "agent-1",
          launchAgentId: "claude",
          agentState: "working",
          everDetectedAgent: true,
          detectedAgentId: "claude",
          detectedProcessId: "claude-12345",
        })
      );
      // Reconnect path, not respawn
      expect(addPanel).not.toHaveBeenCalledWith(
        expect.objectContaining({ requestedId: "agent-1" })
      );
    });

    it("preserves observed-shell live identity (detectedAgentId with no launch intent) without inventing agentId or capabilityAgentId", async () => {
      // User launched a plain shell (no launch intent); detection later kicked
      // in via OSC title or process scan. everDetectedAgent flipped sticky-true,
      // detectedAgentId resolved to "claude", but capabilityAgentId stays
      // undefined because it was sealed at spawn from the absent agentId.
      appClientMock.hydrate.mockResolvedValue({
        appState: {
          terminals: [
            makeSavedAgentPanel({
              id: "shell-1",
              kind: "terminal",
              launchAgentId: undefined,
              title: "zsh",
              command: undefined,
            }),
          ],
          sidebarWidth: 350,
        },
        terminalConfig,
        project,
        agentSettings,
      });

      terminalClientMock.getForProject.mockResolvedValue([
        makeBackendAgentEntry({
          id: "shell-1",
          launchAgentId: undefined,
          title: "zsh",
          everDetectedAgent: true,
          detectedAgentId: "claude",
          detectedProcessId: "claude-98765",
        }),
      ]);

      const addPanel = vi.fn(async (opts: Record<string, unknown>) => {
        return (
          (opts.existingId as string | undefined) ??
          (opts.requestedId as string | undefined) ??
          "id"
        );
      });

      await hydrateAppState({
        addPanel,
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockResolvedValue(undefined),
        openDiagnosticsDock: vi.fn(),
      });

      expect(addPanel).toHaveBeenCalledTimes(1);
      const callArgs = addPanel.mock.calls[0]![0];
      // Detected identity flows through as-is
      expect(callArgs.everDetectedAgent).toBe(true);
      expect(callArgs.detectedAgentId).toBe("claude");
      expect(callArgs.detectedProcessId).toBe("claude-98765");
      // Launch intent must not be invented from detection
      expect(callArgs.launchAgentId).toBeUndefined();
      expect(callArgs.existingId).toBe("shell-1");
    });

    it("drops dead agent backends (hasPty:false) even when identity fields are populated", async () => {
      // Guards the test above from becoming vacuously green: if hasPty were
      // silently missing, the dead-agent filter in stateHydration/index.ts
      // would suppress the addPanel call and hide a real regression.
      appClientMock.hydrate.mockResolvedValue({
        appState: {
          terminals: [makeSavedAgentPanel()],
          sidebarWidth: 350,
        },
        terminalConfig,
        project,
        agentSettings,
      });

      terminalClientMock.getForProject.mockResolvedValue([
        makeBackendAgentEntry({ hasPty: false }),
      ]);

      const addPanel = vi.fn(async (opts: Record<string, unknown>) => {
        return (
          (opts.existingId as string | undefined) ??
          (opts.requestedId as string | undefined) ??
          "id"
        );
      });

      await hydrateAppState({
        addPanel,
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockResolvedValue(undefined),
        openDiagnosticsDock: vi.fn(),
      });

      expect(addPanel).not.toHaveBeenCalled();
    });

    it("carries full identity payload through the TERMINAL_RECONNECT fallback path", async () => {
      // Simulates the window-rebuild / eviction-recovery race where
      // getForProject returns empty (project ID mismatch or stale snapshot)
      // but the backend terminal is still live. The fallback resolves via
      // terminalClient.reconnect and must carry identity fields verbatim.
      appClientMock.hydrate.mockResolvedValue({
        appState: {
          terminals: [makeSavedAgentPanel()],
          sidebarWidth: 350,
        },
        terminalConfig,
        project,
        agentSettings,
      });

      terminalClientMock.getForProject.mockResolvedValue([]);
      terminalClientMock.reconnect.mockResolvedValue({
        exists: true,
        id: "agent-1",
        projectId: "project-1",
        kind: "terminal",
        launchAgentId: "claude",
        title: "Claude",
        cwd: "/project",
        worktreeId: undefined,
        agentState: "waiting",
        lastStateChange: 123456789,
        spawnedAt: 123456000,
        activityTier: "background",
        hasPty: true,
        everDetectedAgent: true,
        detectedAgentId: "claude",
        detectedProcessId: "claude-12345",
      });

      const addPanel = vi.fn(async (opts: Record<string, unknown>) => {
        return (
          (opts.existingId as string | undefined) ??
          (opts.requestedId as string | undefined) ??
          "id"
        );
      });

      await hydrateAppState({
        addPanel,
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockResolvedValue(undefined),
        openDiagnosticsDock: vi.fn(),
      });

      expect(terminalClientMock.reconnect).toHaveBeenCalledWith("agent-1");
      expect(addPanel).toHaveBeenCalledTimes(1);
      expect(addPanel).toHaveBeenCalledWith(
        expect.objectContaining({
          existingId: "agent-1",
          launchAgentId: "claude",
          agentState: "waiting",
          everDetectedAgent: true,
          detectedAgentId: "claude",
          detectedProcessId: "claude-12345",
        })
      );
      // Must go through reconnect, not respawn
      expect(addPanel).not.toHaveBeenCalledWith(
        expect.objectContaining({ requestedId: "agent-1" })
      );
    });

    it("carries full identity payload through the orphaned-backend path (backend terminal not in saved state)", async () => {
      // Third propagation route: a live backend terminal that hydrate() does
      // not know about (saved state stripped, new window discovers it from
      // getForProject). Routes through buildArgsForOrphanedTerminal instead
      // of the primary or reconnect builders. Must carry the four identity
      // dimensions just like the other two paths.
      appClientMock.hydrate.mockResolvedValue({
        appState: {
          // At least one saved panel so the orphan filter does not treat the
          // orphan as a cross-project "default-" bootstrap leftover.
          terminals: [
            {
              id: "other-1",
              kind: "terminal",
              type: "terminal",
              title: "Other Terminal",
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
          id: "other-1",
          hasPty: true,
          cwd: "/project",
          kind: "terminal",
          type: "terminal",
          title: "Other Terminal",
        },
        makeBackendAgentEntry({ id: "orphan-agent-1" }),
      ]);

      const addPanel = vi.fn(async (opts: Record<string, unknown>) => {
        return (
          (opts.existingId as string | undefined) ??
          (opts.requestedId as string | undefined) ??
          "id"
        );
      });

      await hydrateAppState({
        addPanel,
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockResolvedValue(undefined),
        openDiagnosticsDock: vi.fn(),
      });

      // One addPanel for the matched saved terminal, one for the orphan
      expect(addPanel).toHaveBeenCalledTimes(2);
      expect(addPanel).toHaveBeenCalledWith(
        expect.objectContaining({
          existingId: "orphan-agent-1",
          launchAgentId: "claude",
          agentState: "working",
          everDetectedAgent: true,
          detectedAgentId: "claude",
          detectedProcessId: "claude-12345",
        })
      );
    });

    it("does not invent detected identity on reconnect fallback when the backend reports none", async () => {
      // Cold-launched agent whose detection has not yet fired (or fired and
      // then reset). The renderer must not fabricate a detectedAgentId or
      // flip everDetectedAgent based on the launch intent alone.
      appClientMock.hydrate.mockResolvedValue({
        appState: {
          terminals: [makeSavedAgentPanel()],
          sidebarWidth: 350,
        },
        terminalConfig,
        project,
        agentSettings,
      });

      terminalClientMock.getForProject.mockResolvedValue([]);
      terminalClientMock.reconnect.mockResolvedValue({
        exists: true,
        id: "agent-1",
        projectId: "project-1",
        kind: "terminal",
        launchAgentId: "claude",
        title: "Claude",
        cwd: "/project",
        worktreeId: undefined,
        agentState: "idle",
        lastStateChange: 123456789,
        spawnedAt: 123456000,
        activityTier: "background",
        hasPty: true,
        // No live detection yet — everDetectedAgent / detectedAgentId /
        // detectedProcessId omitted.
      });

      const addPanel = vi.fn(async (opts: Record<string, unknown>) => {
        return (
          (opts.existingId as string | undefined) ??
          (opts.requestedId as string | undefined) ??
          "id"
        );
      });

      await hydrateAppState({
        addPanel,
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockResolvedValue(undefined),
        openDiagnosticsDock: vi.fn(),
      });

      expect(addPanel).toHaveBeenCalledTimes(1);
      const callArgs = addPanel.mock.calls[0]![0];
      expect(callArgs.existingId).toBe("agent-1");
      expect(callArgs.launchAgentId).toBe("claude");
      expect(callArgs.agentState).toBe("idle");
      // No invention: absent detection stays absent
      expect(callArgs.everDetectedAgent).toBeUndefined();
      expect(callArgs.detectedAgentId).toBeUndefined();
      expect(callArgs.detectedProcessId).toBeUndefined();
    });
  });

  describe("prefetchedHydrateResult", () => {
    const fullProject = {
      id: "project-1",
      path: "/project",
      name: "project-1",
      emoji: "🌳",
      lastOpened: Date.now(),
    };

    it("skips appClient.hydrate() when prefetched result is provided", async () => {
      const prefetched = {
        appState: { terminals: [], sidebarWidth: 350 },
        terminalConfig,
        project: fullProject,
        agentSettings,
        gpuWebGLHardware: true,
        gpuHardwareAccelerationDisabled: false,
        safeMode: false,
        settingsRecovery: null,
      } as unknown as import("@shared/types/ipc/app").HydrateResult;

      await hydrateAppState(
        {
          addPanel: vi.fn().mockResolvedValue("terminal-id"),
          setActiveWorktree: vi.fn(),
          loadRecipes: vi.fn().mockResolvedValue(undefined),
          openDiagnosticsDock: vi.fn(),
        },
        "switch-1",
        () => true,
        prefetched
      );

      expect(appClientMock.hydrate).not.toHaveBeenCalled();
    });

    it("calls appClient.hydrate() when no prefetched result is provided", async () => {
      appClientMock.hydrate.mockResolvedValue({
        appState: { terminals: [], sidebarWidth: 350 },
        terminalConfig,
        project,
        agentSettings,
        gpuWebGLHardware: true,
        gpuHardwareAccelerationDisabled: false,
        safeMode: false,
        settingsRecovery: null,
      });

      await hydrateAppState(
        {
          addPanel: vi.fn().mockResolvedValue("terminal-id"),
          setActiveWorktree: vi.fn(),
          loadRecipes: vi.fn().mockResolvedValue(undefined),
          openDiagnosticsDock: vi.fn(),
        },
        "switch-1",
        () => true
      );

      expect(appClientMock.hydrate).toHaveBeenCalledTimes(1);
    });
  });

  describe("hydration batching (#5196)", () => {
    it("pairs beginHydrationBatch and flushHydrationBatch for each non-empty restore phase", async () => {
      // Three panel kinds exercise three phases simultaneously: browser (non-PTY),
      // a saved terminal without a backend process (background PTY respawn), and
      // an orphan backend terminal not in the saved list.
      appClientMock.hydrate.mockResolvedValue({
        appState: {
          terminals: [
            {
              id: "browser-1",
              kind: "browser",
              title: "Browser",
              cwd: "/project",
              location: "grid",
            },
            {
              id: "terminal-1",
              kind: "terminal",
              type: "terminal",
              title: "Terminal",
              cwd: "/project",
              location: "grid",
              worktreeId: "wt-other",
            },
          ],
          activeWorktreeId: "wt-active",
        },
        terminalConfig,
        project,
        agentSettings,
      });

      terminalClientMock.getForProject.mockResolvedValue([
        { id: "orphan-1", kind: "terminal", type: "terminal", cwd: "/project", hasPty: true },
      ]);
      terminalClientMock.reconnect.mockResolvedValue({ exists: false });

      const beginHydrationBatch = vi.fn(() => Symbol("batch"));
      const flushHydrationBatch = vi.fn();

      await hydrateAppState({
        addPanel: vi.fn().mockResolvedValue("panel-id"),
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockResolvedValue(undefined),
        openDiagnosticsDock: vi.fn(),
        beginHydrationBatch,
        flushHydrationBatch,
      });

      // Every begin must be matched by a flush with the same token.
      expect(flushHydrationBatch).toHaveBeenCalledTimes(beginHydrationBatch.mock.calls.length);
      const tokens = beginHydrationBatch.mock.results.map((r) => r.value);
      tokens.forEach((token, i) => {
        expect(flushHydrationBatch.mock.calls[i]?.[0]).toBe(token);
      });

      // Non-PTY + background-PTY + orphan phases each fire at least one begin/flush.
      expect(beginHydrationBatch.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it("falls through to legacy per-panel commits when batch hooks are omitted", async () => {
      // Regression guard: existing callers (and tests) that don't pass begin/flush
      // must still hydrate correctly. This is the same shape as the first test in
      // this suite, but without any batch hooks in the options object.
      appClientMock.hydrate.mockResolvedValue({
        appState: {
          terminals: [
            {
              id: "browser-1",
              kind: "browser",
              title: "Browser",
              cwd: "/project",
              location: "grid",
            },
          ],
        },
        terminalConfig,
        project,
        agentSettings,
      });

      const addPanel = vi.fn().mockResolvedValue("browser-1");
      await hydrateAppState({
        addPanel,
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockResolvedValue(undefined),
        openDiagnosticsDock: vi.fn(),
      });

      expect(addPanel).toHaveBeenCalledTimes(1);
    });

    it("flushes the batch even if a panel addition throws mid-phase", async () => {
      appClientMock.hydrate.mockResolvedValue({
        appState: {
          terminals: [
            {
              id: "browser-1",
              kind: "browser",
              title: "Browser",
              cwd: "/project",
              location: "grid",
            },
          ],
        },
        terminalConfig,
        project,
        agentSettings,
      });

      const beginHydrationBatch = vi.fn(() => Symbol("batch"));
      const flushHydrationBatch = vi.fn();

      // If `addPanel` rejects, hydration swallows the error (logWarn). The batch
      // still needs to flush so the store isn't left stuck with a dangling batch.
      const addPanel = vi.fn().mockRejectedValue(new Error("boom"));

      await hydrateAppState({
        addPanel,
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockResolvedValue(undefined),
        openDiagnosticsDock: vi.fn(),
        beginHydrationBatch,
        flushHydrationBatch,
      });

      expect(beginHydrationBatch).toHaveBeenCalled();
      expect(flushHydrationBatch).toHaveBeenCalledTimes(beginHydrationBatch.mock.calls.length);
    });
  });
});
