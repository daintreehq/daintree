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

      await hydrateAppState({
        addPanel: vi.fn().mockResolvedValue("terminal-id"),
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockResolvedValue(undefined),
        openDiagnosticsDock: vi.fn(),
      });

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

    it("uses systemTmpDir from the prefetched payload and skips the getTmpDir IPC call", async () => {
      await hydrateAppState({
        ...baseOptions(),
        prefetchedHydrateResult: {
          appState: { terminals: [] },
          terminalConfig,
          project,
          agentSettings,
          gpuWebGLHardware: true,
          systemTmpDir: "/payload-tmp",
        } as unknown as import("@shared/types/ipc/app").HydrateResult,
      });

      expect(getTmpDirMock).not.toHaveBeenCalled();
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
