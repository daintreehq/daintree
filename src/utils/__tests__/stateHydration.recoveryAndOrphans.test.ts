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
  });
});
