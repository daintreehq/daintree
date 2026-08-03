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

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    fetchAndRestore: vi.fn().mockResolvedValue(undefined),
    restoreFetchedState: vi.fn().mockResolvedValue(undefined),
    initializeBackendTier: vi.fn(),
    get: vi.fn().mockReturnValue(null),
    setGPUHardwareAvailable: vi.fn(),
    setTargetSize: vi.fn(),
    notifyScrollbackRestoreListeners: vi.fn(),
    notifyRestoreSettledWaiters: vi.fn(),
  },
}));

vi.mock("@/lib/notify", () => ({ notify: vi.fn().mockReturnValue("notification-id") }));

const { hydrateAppState } = await import("../stateHydration");

const terminalConfig = { scrollbackLines: 1000, performanceMode: false };
const agentSettings = { agents: {} };

const gitProject = {
  id: "project-1",
  path: "/project",
  name: "project-1",
  lastOpened: 0,
};

/** The host's answer for a workspace it has classified as having a repository. */
function hostReports(worktrees: unknown[], gitBacked: boolean | null = null) {
  return { worktrees, gitBacked };
}

async function hydrateWith(payload: {
  project: unknown;
  workspaceId?: string;
  activeWorktreeId?: string;
}): Promise<{ setActiveWorktree: ReturnType<typeof vi.fn> }> {
  appClientMock.hydrate.mockResolvedValue({
    appState: { terminals: [], activeWorktreeId: payload.activeWorktreeId },
    terminalConfig,
    project: payload.project,
    workspaceId: payload.workspaceId,
    agentSettings,
  });

  const setActiveWorktree = vi.fn();
  await hydrateAppState({
    addPanel: vi.fn().mockResolvedValue("panel-id"),
    setActiveWorktree,
    loadRecipes: vi.fn().mockResolvedValue(undefined),
    openDiagnosticsDock: vi.fn(),
  });
  return { setActiveWorktree };
}

describe("hydrateAppState active-worktree selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalClientMock.getForProject.mockResolvedValue([]);
    terminalClientMock.reconnect.mockResolvedValue({ exists: false });
    terminalClientMock.reconnectBulk.mockResolvedValue({});
    terminalClientMock.getSerializedStates.mockRejectedValue(new Error("unavailable"));
    worktreeClientMock.getAllWithStatus.mockResolvedValue(hostReports([]));
    projectClientMock.getTabGroups.mockResolvedValue([]);
    projectClientMock.getTerminalSizes.mockResolvedValue({});
    projectClientMock.getDraftInputs.mockResolvedValue({});
    projectClientMock.getInRepoPresets.mockResolvedValue({});
  });

  // A scratch owns a workspace but no project row, and `activeWorktreeId` is one
  // app-global value: adopting the last git-backed project's worktree here leaves
  // the grid rendering a bucket nothing can land in, and every worktree-resolving
  // action refusing with "Worktree not found".
  it("leaves the selection unset in a scratch workspace", async () => {
    const { setActiveWorktree } = await hydrateWith({
      project: null,
      workspaceId: "scratch-uuid",
      activeWorktreeId: "/other/project/worktree",
    });
    expect(setActiveWorktree).not.toHaveBeenCalled();
  });

  // The worktree list is authoritative for a project and irrelevant here: a
  // workspace that cannot have worktrees must ignore one even when it arrives
  // populated (a stale or cross-workspace answer).
  it("leaves the selection unset in a scratch workspace even when a worktree list arrives", async () => {
    worktreeClientMock.getAllWithStatus.mockResolvedValue(
      hostReports([{ id: "wt-foreign", name: "main", isMainWorktree: true }], true)
    );
    const { setActiveWorktree } = await hydrateWith({
      project: null,
      workspaceId: "scratch-uuid",
      activeWorktreeId: "wt-foreign",
    });
    expect(setActiveWorktree).not.toHaveBeenCalled();
  });

  it("leaves the selection unset in a project opened without git", async () => {
    const { setActiveWorktree } = await hydrateWith({
      project: { ...gitProject, gitBacked: false },
      workspaceId: gitProject.id,
      activeWorktreeId: "/other/project/worktree",
    });
    expect(setActiveWorktree).not.toHaveBeenCalled();
  });

  // #11234: for a git-backed project an empty list means "the host hasn't
  // reported yet", so the saved selection is kept rather than dropped.
  it("keeps the saved selection in a git-backed project whose worktree list is still unknown", async () => {
    const { setActiveWorktree } = await hydrateWith({
      project: gitProject,
      workspaceId: gitProject.id,
      activeWorktreeId: "wt-saved",
    });
    expect(setActiveWorktree).toHaveBeenCalledExactlyOnceWith("wt-saved");
  });

  // A rejected `worktree:get-all-with-status` resolves to the `null` sentinel,
  // which is the other spelling of "unknown" — same outcome as the empty list
  // above. The host never answered, so it never said "no repository" either.
  it("keeps the saved selection when the worktree fetch fails outright", async () => {
    worktreeClientMock.getAllWithStatus.mockRejectedValue(new Error("host unavailable"));
    const { setActiveWorktree } = await hydrateWith({
      project: gitProject,
      workspaceId: gitProject.id,
      activeWorktreeId: "wt-saved",
    });
    expect(setActiveWorktree).toHaveBeenCalledExactlyOnceWith("wt-saved");
  });

  it("restores the saved selection when it is present in a known worktree list", async () => {
    worktreeClientMock.getAllWithStatus.mockResolvedValue(
      hostReports(
        [
          { id: "wt-main", name: "main", isMainWorktree: true },
          { id: "wt-feature", name: "feature", isMainWorktree: false },
        ],
        true
      )
    );
    const { setActiveWorktree } = await hydrateWith({
      project: gitProject,
      workspaceId: gitProject.id,
      activeWorktreeId: "wt-feature",
    });
    expect(setActiveWorktree).toHaveBeenCalledExactlyOnceWith("wt-feature");
  });

  it("falls back to the main worktree when the saved selection is gone", async () => {
    worktreeClientMock.getAllWithStatus.mockResolvedValue(
      hostReports(
        [
          { id: "wt-feature", name: "feature", isMainWorktree: false },
          { id: "wt-main", name: "main", isMainWorktree: true },
        ],
        true
      )
    );
    const { setActiveWorktree } = await hydrateWith({
      project: gitProject,
      workspaceId: gitProject.id,
      activeWorktreeId: "wt-deleted",
    });
    expect(setActiveWorktree).toHaveBeenCalledExactlyOnceWith("wt-main");
  });

  // #11650. The row's discriminator cannot tell these two apart — both carry no
  // `gitBacked` field, which `isGitBackedProject` reads as git-backed — so the
  // pair only diverges on what the host reports. Asserting them together is the
  // point: the fix must split them, and must not do it by making the unknown
  // case conservative (that would resurrect #11234).
  describe("a project row with no gitBacked discriminator", () => {
    it("keeps the saved selection while the host has not classified the folder", async () => {
      worktreeClientMock.getAllWithStatus.mockResolvedValue(hostReports([], null));
      const { setActiveWorktree } = await hydrateWith({
        project: gitProject,
        workspaceId: gitProject.id,
        activeWorktreeId: "wt-foreign",
      });
      expect(setActiveWorktree).toHaveBeenCalledExactlyOnceWith("wt-foreign");
    });

    it("ignores the saved selection once the host reports no repository", async () => {
      worktreeClientMock.getAllWithStatus.mockResolvedValue(hostReports([], false));
      const { setActiveWorktree } = await hydrateWith({
        project: gitProject,
        workspaceId: gitProject.id,
        activeWorktreeId: "wt-foreign",
      });
      expect(setActiveWorktree).not.toHaveBeenCalled();
    });
  });
});
