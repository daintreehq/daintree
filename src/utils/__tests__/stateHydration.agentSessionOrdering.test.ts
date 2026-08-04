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
});
