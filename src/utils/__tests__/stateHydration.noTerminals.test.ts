// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

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

const layoutConfigState = { setLayoutConfig: vi.fn() };
const scrollbackState = { setScrollbackLines: vi.fn() };
const performanceState = { setPerformanceMode: vi.fn() };
const terminalInputState = {
  setHybridInputEnabled: vi.fn(),
  setHybridInputAutoFocus: vi.fn(),
};
const terminalStoreState = { setSpawnError: vi.fn() };
const projectStoreSetStateMock = vi.fn();
const loadScratchesMock = vi.fn().mockResolvedValue(undefined);

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
  useLayoutConfigStore: { getState: () => layoutConfigState },
  useScrollbackStore: { getState: () => scrollbackState },
  usePerformanceModeStore: { getState: () => performanceState },
  useTerminalInputStore: { getState: () => terminalInputState },
  usePanelStore: { getState: () => terminalStoreState },
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: { setState: projectStoreSetStateMock },
}));

vi.mock("@/store/scratchStore", () => ({
  useScratchStore: { getState: () => ({ loadScratches: loadScratchesMock }) },
}));

vi.mock("@/store/userAgentRegistryStore", () => ({
  useUserAgentRegistryStore: {
    getState: () => ({ initialize: vi.fn().mockResolvedValue(undefined) }),
  },
}));

vi.mock("@/services/KeybindingService", () => ({
  keybindingService: { loadOverrides: vi.fn().mockResolvedValue(undefined) },
}));

const createTerminalPaintPlane = vi.hoisted(() =>
  vi.fn(() => ({
    fetchAndRestore: vi.fn().mockResolvedValue(undefined),
    restoreFetchedState: vi.fn().mockResolvedValue(undefined),
    initializeBackendTier: vi.fn(),
    get: vi.fn().mockReturnValue(null),
    setGPUHardwareAvailable: vi.fn(),
    setTargetSize: vi.fn(),
    notifyScrollbackRestoreListeners: vi.fn(),
    addInstanceDestroyedListener: vi.fn(() => () => {}),
    notifyRestoreSettledWaiters: vi.fn(),
  }))
);

vi.mock("@/services/TerminalInstanceService", () => ({ createTerminalPaintPlane }));

vi.mock("@/lib/notify", () => ({ notify: vi.fn().mockReturnValue("notification-id") }));

const { hydrateAppState } = await import("../stateHydration");
const { __resetTerminalConfigSyncForTests, beginTerminalConfigRead } =
  await import("@/services/terminalConfigSync");
const { useScrollbackStore } = await import("@/store/scrollbackStore");
const { usePerformanceModeStore } = await import("@/store/performanceModeStore");
// Deliberately not primed with load(): the point is that hydration alone never
// loads the service (#14267).
const { peek: peekTerminalService } =
  await import("@/services/terminal/terminalInstanceServiceAccessor");

describe("hydrateAppState with no terminal panels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalClientMock.getForProject.mockResolvedValue([]);
    terminalClientMock.reconnect.mockResolvedValue({ exists: false });
    terminalClientMock.reconnectBulk.mockResolvedValue({});
    terminalClientMock.getSerializedStates.mockRejectedValue(new Error("unavailable"));
    worktreeClientMock.getAllWithStatus.mockResolvedValue({ worktrees: [], gitBacked: null });
    projectClientMock.getTabGroups.mockResolvedValue([]);
    projectClientMock.getTerminalSizes.mockResolvedValue({});
    projectClientMock.getDraftInputs.mockResolvedValue({});
    projectClientMock.getInRepoPresets.mockResolvedValue({});
  });

  it("leaves the terminal instance service unloaded", async () => {
    appClientMock.hydrate.mockResolvedValue({
      appState: { terminals: [] },
      terminalConfig: { scrollbackLines: 1000, performanceMode: false },
      project: { id: "project-1", path: "/project", name: "project-1", lastOpened: 0 },
      workspaceId: "project-1",
      agentSettings: { agents: {} },
    });
    const addPanel = vi.fn().mockResolvedValue("panel-id");

    await hydrateAppState({
      addPanel,
      setActiveWorktree: vi.fn(),
      loadRecipes: vi.fn().mockResolvedValue(undefined),
      openDiagnosticsDock: vi.fn(),
    });
    // Let any load hydration kicked off without awaiting settle first.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(addPanel).not.toHaveBeenCalled();
    expect(createTerminalPaintPlane).not.toHaveBeenCalled();
    expect(peekTerminalService()).toBeNull();
  });

  describe("terminal settings (#14699)", () => {
    const hydrateWith = (terminalConfig: Record<string, unknown>) => ({
      appState: { terminals: [] },
      terminalConfig,
      project: { id: "project-1", path: "/project", name: "project-1", lastOpened: 0 },
      workspaceId: "project-1",
      agentSettings: { agents: {} },
    });
    const run = () =>
      hydrateAppState({
        addPanel: vi.fn().mockResolvedValue("panel-id"),
        setActiveWorktree: vi.fn(),
        loadRecipes: vi.fn().mockResolvedValue(undefined),
        openDiagnosticsDock: vi.fn(),
      });

    beforeEach(() => {
      __resetTerminalConfigSyncForTests();
      useScrollbackStore.setState({ scrollbackLines: 1000 });
      usePerformanceModeStore.setState({ performanceMode: false });
    });

    it("takes a fresh hydrate's values without saving any back", async () => {
      // Out of range, as an old build may have saved it: shown corrected, not rewritten.
      appClientMock.hydrate.mockResolvedValue(
        hydrateWith({ scrollbackLines: 50_000, performanceMode: true })
      );

      await run();

      expect(useScrollbackStore.getState().scrollbackLines).toBeLessThan(50_000);
      expect(usePerformanceModeStore.getState().performanceMode).toBe(true);
      expect(terminalConfigClientMock.setScrollback).not.toHaveBeenCalled();
    });

    it("never puts back values a newer read replaced while the hydrate travelled", async () => {
      let answer: (value: unknown) => void = () => {};
      appClientMock.hydrate.mockReturnValue(new Promise((resolve) => (answer = resolve)));

      const done = run();
      await vi.waitFor(() => expect(appClientMock.hydrate).toHaveBeenCalled());
      beginTerminalConfigRead()({ scrollbackLines: 7000, performanceMode: false });
      answer(hydrateWith({ scrollbackLines: 2000, performanceMode: true }));
      await done;

      expect(useScrollbackStore.getState().scrollbackLines).toBe(7000);
      expect(usePerformanceModeStore.getState().performanceMode).toBe(false);
    });
  });
});
