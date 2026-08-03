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
});
