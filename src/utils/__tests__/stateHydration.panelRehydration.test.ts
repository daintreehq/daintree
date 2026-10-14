// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useCanopyStore } from "@/store/canopyStore";

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
    addInstanceDestroyedListener: vi.fn(() => () => {}),
    notifyRestoreSettledWaiters: vi.fn(),
  },
}));

const notifyMock = vi.fn().mockReturnValue("notification-id");
vi.mock("@/lib/notify", () => ({
  notify: (...args: unknown[]) => notifyMock(...args),
}));

const { hydrateAppState } = await import("../stateHydration");
const { panelPersistence } = await import("@/store/persistence/panelPersistence");

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

  it("seeds the project store current project from the hydrate payload", async () => {
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [],
      },
      terminalConfig,
      project,
      agentSettings,
      gpuWebGLHardware: true,
    });

    await hydrateAppState({
      addPanel: vi.fn().mockResolvedValue("panel-1"),
      setActiveWorktree: vi.fn(),
      loadRecipes: vi.fn().mockResolvedValue(undefined),
      openDiagnosticsDock: vi.fn(),
    });

    const updater = projectStoreSetStateMock.mock.calls[0]?.[0] as
      | ((state: {
          projects: (typeof project)[];
          currentProject: typeof project | null;
          isBootstrapped: boolean;
        }) => {
          projects: (typeof project)[];
          currentProject: typeof project | null;
          isBootstrapped: boolean;
        })
      | undefined;

    expect(updater).toBeTypeOf("function");
    expect(updater?.({ projects: [], currentProject: null, isBootstrapped: false })).toEqual({
      projects: [project],
      currentProject: project,
      // The payload carried no `projects` list (older main process), so the
      // bootstrap flag stays down and the Toolbar's IPC fallback still fires.
      isBootstrapped: false,
    });
  });

  it("prefetches reconnect probes in one bulk IPC for saved PTY panels missing from the backend (#10390)", async () => {
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [
          { id: "term-1", kind: "terminal", title: "T1", cwd: "/project", location: "grid" },
          {
            id: "browser-1",
            kind: "browser",
            title: "Browser",
            cwd: "/project",
            location: "grid",
            browserUrl: "http://localhost:5173",
          },
        ],
        sidebarWidth: 350,
      },
      terminalConfig,
      project,
      agentSettings,
      gpuWebGLHardware: true,
    });
    terminalClientMock.reconnectBulk.mockResolvedValue({
      "term-1": { exists: false },
    });

    await hydrateAppState({
      addPanel: vi.fn().mockResolvedValue("term-1"),
      setActiveWorktree: vi.fn(),
      loadRecipes: vi.fn().mockResolvedValue(undefined),
      openDiagnosticsDock: vi.fn(),
    });

    // Only the PTY-kind panel missing from the backend is probed; the
    // non-PTY browser panel is excluded from the bulk payload.
    expect(terminalClientMock.reconnectBulk).toHaveBeenCalledTimes(1);
    expect(terminalClientMock.reconnectBulk).toHaveBeenCalledWith(["term-1"]);
    // The prefetched result satisfies the probe — no per-panel reconnect IPC.
    expect(terminalClientMock.reconnect).not.toHaveBeenCalled();
  });

  it("seeds the full project list and bootstrap flag when the payload carries projects (#10390)", async () => {
    const otherProject = { id: "project-2", path: "/other" };
    appClientMock.hydrate.mockResolvedValue({
      appState: {
        terminals: [],
      },
      terminalConfig,
      project,
      projects: [project, otherProject],
      agentSettings,
      gpuWebGLHardware: true,
    });

    await hydrateAppState({
      addPanel: vi.fn().mockResolvedValue("panel-1"),
      setActiveWorktree: vi.fn(),
      loadRecipes: vi.fn().mockResolvedValue(undefined),
      openDiagnosticsDock: vi.fn(),
    });

    const updater = projectStoreSetStateMock.mock.calls[0]?.[0] as (state: {
      projects: (typeof project)[];
      currentProject: typeof project | null;
      isBootstrapped: boolean;
    }) => {
      projects: (typeof project)[];
      currentProject: typeof project | null;
      isBootstrapped: boolean;
    };

    expect(updater({ projects: [], currentProject: null, isBootstrapped: false })).toEqual({
      projects: [project, otherProject],
      currentProject: project,
      isBootstrapped: true,
    });
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

  it("restores saved panels and primes persistence when getForProject rejects (#9928)", async () => {
    // Regression: a rejected backend-terminal query must not skip session restore.
    // Previously the rejection was re-thrown into the outer catch, leaving the panel
    // store empty so the first post-boot save wiped the saved session. The fetch
    // failure should degrade to an empty backend map and let saved panels respawn.
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

    terminalClientMock.getForProject.mockRejectedValue(new Error("terminal query failed"));

    // panelPersistence is a real singleton whose previous-snapshot cache survives
    // across tests; clear project-1 so primeProject actually seeds (it early-returns
    // when an entry already exists) and the assertion below reflects this run.
    panelPersistence.clearProjectSnapshotCache("project-1");

    const addPanel = vi.fn().mockResolvedValue("agent-1");

    await hydrateAppState({
      addPanel,
      setActiveWorktree: vi.fn(),
      loadRecipes: vi.fn().mockResolvedValue(undefined),
      openDiagnosticsDock: vi.fn(),
    });

    // Persistence cache is primed with the saved panels before any save can fire,
    // so the first post-boot save compares against the real snapshot, not an empty
    // one — this is what stops the destructive overwrite (#9928).
    const primedSnapshots = panelPersistence.getPreviousSnapshotMap("project-1");
    expect(primedSnapshots?.has("agent-1")).toBe(true);

    // Saved panel is respawned from disk (empty backend map → respawn path).
    expect(addPanel).toHaveBeenCalledTimes(1);
    expect(addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "terminal",
        requestedId: "agent-1",
      })
    );
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

      await hydrateAppState({
        addPanel: vi.fn().mockResolvedValue("terminal-id"),
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockResolvedValue(undefined),
        openDiagnosticsDock: vi.fn(),
        prefetchedHydrateResult: prefetched,
      });

      expect(appClientMock.hydrate).not.toHaveBeenCalled();
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

  describe("per-project layout payload folding", () => {
    const baseOptions = () => ({
      addPanel: vi.fn().mockResolvedValue("panel-1"),
      setActiveWorktree: vi.fn(),
      loadRecipes: vi.fn().mockResolvedValue(undefined),
      openDiagnosticsDock: vi.fn(),
    });

    it("uses tabGroups/terminalSizes/draftInputs from the hydrate payload and skips the standalone IPC calls", async () => {
      const payloadTabGroups = [
        {
          id: "group-payload",
          location: "grid",
          activeTabId: "terminal-1",
          panelIds: ["terminal-1"],
        },
      ];
      appClientMock.hydrate.mockResolvedValue({
        appState: { terminals: [], sidebarWidth: 350 },
        terminalConfig,
        project,
        agentSettings,
        gpuWebGLHardware: true,
        tabGroups: payloadTabGroups,
        terminalSizes: { "terminal-1": { cols: 100, rows: 30 } },
        draftInputs: { "terminal-1": "payload draft" },
      });

      const hydrateTabGroups = vi.fn();
      await hydrateAppState({ ...baseOptions(), hydrateTabGroups });

      expect(projectClientMock.getTabGroups).not.toHaveBeenCalled();
      expect(projectClientMock.getTerminalSizes).not.toHaveBeenCalled();
      expect(projectClientMock.getDraftInputs).not.toHaveBeenCalled();
      expect(hydrateTabGroups).toHaveBeenCalledWith(payloadTabGroups);

      const { useTerminalInputStore } = await import("@/store/terminalInputStore");
      expect(useTerminalInputStore.getState().draftInputs.get("project-1:terminal-1")).toBe(
        "payload draft"
      );
    });

    it("falls back to the standalone IPC calls when the payload fields are absent", async () => {
      appClientMock.hydrate.mockResolvedValue({
        appState: { terminals: [], sidebarWidth: 350 },
        terminalConfig,
        project,
        agentSettings,
        gpuWebGLHardware: true,
        // tabGroups/terminalSizes/draftInputs intentionally omitted (older
        // main process, or the safe-boot {ok:false} payload).
      });

      const hydrateTabGroups = vi.fn();
      await hydrateAppState({ ...baseOptions(), hydrateTabGroups });

      expect(projectClientMock.getTabGroups).toHaveBeenCalledWith("project-1");
      expect(projectClientMock.getTerminalSizes).toHaveBeenCalledWith("project-1");
      expect(projectClientMock.getDraftInputs).toHaveBeenCalledWith("project-1");
    });

    it("treats empty payload fields as authoritative (no IPC fallback, stale groups cleared)", async () => {
      appClientMock.hydrate.mockResolvedValue({
        appState: { terminals: [], sidebarWidth: 350 },
        terminalConfig,
        project,
        agentSettings,
        gpuWebGLHardware: true,
        tabGroups: [],
        terminalSizes: {},
        draftInputs: {},
      });

      const hydrateTabGroups = vi.fn();
      await hydrateAppState({ ...baseOptions(), hydrateTabGroups });

      expect(projectClientMock.getTabGroups).not.toHaveBeenCalled();
      expect(projectClientMock.getTerminalSizes).not.toHaveBeenCalled();
      expect(projectClientMock.getDraftInputs).not.toHaveBeenCalled();
      // Empty array still clears stale groups (mirrors the IPC path).
      expect(hydrateTabGroups).toHaveBeenCalledWith([]);
    });

    it("uses projectPresets from the hydrate payload and skips the standalone IPC call", async () => {
      appClientMock.hydrate.mockResolvedValue({
        appState: { terminals: [], sidebarWidth: 350 },
        terminalConfig,
        project,
        agentSettings,
        gpuWebGLHardware: true,
        projectPresets: { claude: [{ id: "team-preset", name: "Team" }] },
      });

      await hydrateAppState(baseOptions());

      expect(projectClientMock.getInRepoPresets).not.toHaveBeenCalled();
    });

    it("falls back to the standalone getInRepoPresets call when projectPresets is absent", async () => {
      appClientMock.hydrate.mockResolvedValue({
        appState: { terminals: [], sidebarWidth: 350 },
        terminalConfig,
        project,
        agentSettings,
        gpuWebGLHardware: true,
        // projectPresets intentionally omitted (older main process, or the
        // safe-boot {ok:false} payload).
      });

      await hydrateAppState(baseOptions());

      expect(projectClientMock.getInRepoPresets).toHaveBeenCalledWith("project-1");
    });

    it("treats an empty projectPresets payload as authoritative (no IPC fallback)", async () => {
      appClientMock.hydrate.mockResolvedValue({
        appState: { terminals: [], sidebarWidth: 350 },
        terminalConfig,
        project,
        agentSettings,
        gpuWebGLHardware: true,
        projectPresets: {},
      });

      await hydrateAppState(baseOptions());

      expect(projectClientMock.getInRepoPresets).not.toHaveBeenCalled();
    });
  });

  describe("scratch workspaces (#11484)", () => {
    const SCRATCH_ID = "b3d1f2a4-5c6e-4a8b-9d0f-1e2a3b4c5d6e";

    const scratchOptions = () => ({
      addPanel: vi.fn().mockResolvedValue("panel-1"),
      setActiveWorktree: vi.fn(),
      loadRecipes: vi.fn().mockResolvedValue(undefined),
      openDiagnosticsDock: vi.fn(),
    });

    it("reconnects live terminals and restores layout for a workspace with no project", async () => {
      // A scratch view hydrates with `project: null` — before the fix that
      // skipped the backend terminal query entirely, so still-running PTYs
      // stayed orphaned in the pty-host with nothing referencing them.
      appClientMock.hydrate.mockResolvedValue({
        appState: { terminals: [], sidebarWidth: 350 },
        terminalConfig,
        project: null,
        workspaceId: SCRATCH_ID,
        agentSettings,
        gpuWebGLHardware: true,
      });

      await hydrateAppState({ ...scratchOptions(), hydrateTabGroups: vi.fn() });

      expect(terminalClientMock.getForProject).toHaveBeenCalledWith(SCRATCH_ID);
      expect(projectClientMock.getTabGroups).toHaveBeenCalledWith(SCRATCH_ID);
      expect(projectClientMock.getTerminalSizes).toHaveBeenCalledWith(SCRATCH_ID);
      expect(projectClientMock.getDraftInputs).toHaveBeenCalledWith(SCRATCH_ID);
    });

    it("keeps repository-only work gated on a real project", async () => {
      // Scratch folders are not git repos, so in-repo presets and recipes must
      // not be fetched for them even though layout restore now is.
      const options = scratchOptions();
      appClientMock.hydrate.mockResolvedValue({
        appState: { terminals: [], sidebarWidth: 350 },
        terminalConfig,
        project: null,
        workspaceId: SCRATCH_ID,
        agentSettings,
        gpuWebGLHardware: true,
      });

      await hydrateAppState({ ...options, hydrateTabGroups: vi.fn() });

      expect(projectClientMock.getInRepoPresets).not.toHaveBeenCalled();
      expect(options.loadRecipes).not.toHaveBeenCalled();
    });

    it("still does nothing when the view owns no workspace at all", async () => {
      const options = scratchOptions();
      appClientMock.hydrate.mockResolvedValue({
        appState: { terminals: [], sidebarWidth: 350 },
        terminalConfig,
        project: null,
        workspaceId: null,
        agentSettings,
        gpuWebGLHardware: true,
      });

      await hydrateAppState({ ...options, hydrateTabGroups: vi.fn() });

      expect(terminalClientMock.getForProject).not.toHaveBeenCalled();
      expect(projectClientMock.getTabGroups).not.toHaveBeenCalled();
    });

    it("falls back to the project id when an older main process omits workspaceId", async () => {
      appClientMock.hydrate.mockResolvedValue({
        appState: { terminals: [], sidebarWidth: 350 },
        terminalConfig,
        project,
        agentSettings,
        gpuWebGLHardware: true,
      });

      await hydrateAppState({ ...scratchOptions(), hydrateTabGroups: vi.fn() });

      expect(terminalClientMock.getForProject).toHaveBeenCalledWith(project.id);
    });
  });

  describe("system temp dir folding", () => {
    const baseOptions = () => ({
      addPanel: vi.fn().mockResolvedValue("panel-1"),
      setActiveWorktree: vi.fn(),
      loadRecipes: vi.fn().mockResolvedValue(undefined),
      openDiagnosticsDock: vi.fn(),
    });

    it("takes Canopy's mode from the payload, so a hidden Canopy's button never paints", async () => {
      useCanopyStore.setState({ mode: "unset", snapshot: null });
      await hydrateAppState({
        ...baseOptions(),
        prefetchedHydrateResult: {
          appState: { terminals: [] },
          terminalConfig,
          project,
          agentSettings,
          gpuWebGLHardware: true,
          canopyMode: "hidden",
        } as unknown as import("@shared/types/ipc/app").HydrateResult,
      });

      expect(useCanopyStore.getState().mode).toBe("hidden");
      useCanopyStore.setState({ mode: "unset" });
    });

    it("uses systemTmpDir from the appClient.hydrate() payload and skips the getTmpDir IPC call", async () => {
      appClientMock.hydrate.mockResolvedValue({
        appState: { terminals: [] },
        terminalConfig,
        project,
        agentSettings,
        gpuWebGLHardware: true,
        systemTmpDir: "/hydrate-tmp",
      });

      await hydrateAppState(baseOptions());

      expect(getTmpDirMock).not.toHaveBeenCalled();
    });

    it("falls back to the getTmpDir IPC call when systemTmpDir is absent", async () => {
      appClientMock.hydrate.mockResolvedValue({
        appState: { terminals: [] },
        terminalConfig,
        project,
        agentSettings,
        gpuWebGLHardware: true,
        // systemTmpDir intentionally omitted (older main process / safe-boot payload)
      });

      await hydrateAppState(baseOptions());

      expect(getTmpDirMock).toHaveBeenCalledTimes(1);
    });

    it("seeds the host platform from the payload's host fields", async () => {
      const hostPlatform = await import("@/hooks/useHostPlatform");
      hostPlatform._resetHostPlatformForTests();
      try {
        appClientMock.hydrate.mockResolvedValue({
          appState: { terminals: [] },
          terminalConfig,
          project,
          agentSettings,
          gpuWebGLHardware: true,
          systemTmpDir: "/client-tmp",
          hostPlatform: "linux",
          hostHomeDir: "/home/greg",
          hostTmpDir: "/host-tmp",
        });
        await hydrateAppState(baseOptions());

        expect(hostPlatform.getHostPlatformInfo()).toMatchObject({
          platform: "linux",
          homeDir: "/home/greg",
          tmpDir: "/host-tmp",
          hostName: null,
        });
        expect(getTmpDirMock).not.toHaveBeenCalled();
      } finally {
        hostPlatform._resetHostPlatformForTests();
      }
    });

    it("never takes this machine's systemTmpDir for a remote view", async () => {
      const hostPlatform = await import("@/hooks/useHostPlatform");
      hostPlatform._resetHostPlatformForTests();
      window.__DAINTREE_HOST_ID__ = { id: "build-box" };
      try {
        appClientMock.hydrate.mockResolvedValue({
          appState: { terminals: [] },
          terminalConfig,
          project,
          agentSettings,
          gpuWebGLHardware: true,
          systemTmpDir: "/client-tmp",
        });

        await hydrateAppState(baseOptions());

        expect(getTmpDirMock).toHaveBeenCalledTimes(1);
      } finally {
        delete window.__DAINTREE_HOST_ID__;
        hostPlatform._resetHostPlatformForTests();
      }
    });

    it("degrades without throwing when the getTmpDir fallback rejects", async () => {
      appClientMock.hydrate.mockResolvedValue({
        appState: { terminals: [] },
        terminalConfig,
        project,
        agentSettings,
        gpuWebGLHardware: true,
      });
      getTmpDirMock.mockRejectedValueOnce(new Error("tmp dir unavailable"));

      await expect(hydrateAppState(baseOptions())).resolves.not.toThrow();
    });
  });
});
