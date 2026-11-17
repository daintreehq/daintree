// @vitest-environment jsdom
//
// A project moved while its view is open (#17184): the live rebase runs against
// the REAL panel and worktree-selection stores, then the view switches
// worktrees and leaves the project. Nothing it persists or restores may still
// name the old root.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { appSetStateMock, projectSwitchMock } = vi.hoisted(() => ({
  appSetStateMock: vi.fn().mockResolvedValue(undefined),
  projectSwitchMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/clients", () => ({
  appClient: { setState: appSetStateMock },
  terminalClient: { kill: vi.fn().mockResolvedValue(undefined) },
  projectClient: {
    getAll: vi.fn().mockResolvedValue([]),
    getCurrent: vi.fn().mockResolvedValue(null),
    switch: projectSwitchMock,
    onSwitch: vi.fn(() => () => {}),
    onWorktreeLoadStatus: vi.fn(() => () => {}),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    setTerminalSizes: vi.fn().mockResolvedValue(undefined),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
    getTerminals: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => {
  const terminalInstanceService = {
    get: vi.fn(() => null),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    wake: vi.fn(() => true),
    wakeForFocus: vi.fn(),
    destroy: vi.fn(),
  };
  return { createTerminalPaintPlane: () => terminalInstanceService };
});

vi.mock("@/services/terminal/worktreeRevealCoordinator", () => ({
  replaceWorktreeRevealObligations: vi.fn(),
  clearWorktreeRevealObligations: vi.fn(),
}));

vi.mock("../resetStores", () => ({
  resetAllStoresForProjectSwitch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/services/projectSwitchRendererCache", () => ({
  prepareProjectSwitchRendererCache: vi.fn().mockReturnValue(null),
  cancelPreparedProjectSwitchRendererCache: vi.fn(),
}));

vi.mock("@/lib/notify", () => ({ notify: vi.fn(() => "mock-notification-id") }));

const OLD = "/vol/projects/proj";
const NEW = "/vol/projects/proj-renamed";
const LINKED = "/vol/wts/feature";
// `NEW` starts with `OLD`, so a leak is OLD followed by a path boundary.
const OLD_ROOT_REF = /\/vol\/projects\/proj(?=$|["/\\])/;

const projectA = { id: "project-a", name: "A", path: NEW, emoji: "folder", lastOpened: 1 };
const projectB = { id: "project-b", name: "B", path: "/vol/b", emoji: "folder", lastOpened: 1 };

function terminal(id: string, worktreeId: string) {
  return {
    id,
    kind: "terminal" as const,
    title: id,
    worktreeId,
    cwd: worktreeId,
    cols: 80,
    rows: 24,
    location: "grid" as const,
  };
}

function mruWrites(): string[][] {
  return appSetStateMock.mock.calls
    .map(([payload]) => payload as { mruList?: string[] })
    .filter((payload) => Array.isArray(payload.mruList))
    .map((payload) => payload.mruList!);
}

async function drain(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// A fresh module graph per test: the MRU and host-owned write bookkeeping are
// module state, and an acknowledged list from one test would dedupe the next.
let usePanelStore: (typeof import("../panelStore"))["usePanelStore"];
let useWorktreeSelectionStore: (typeof import("../worktreeStore"))["useWorktreeSelectionStore"];
let useProjectStore: (typeof import("../projectStore"))["useProjectStore"];
let rebaseProjectViewRuntimePaths: (typeof import("../rebaseProjectViewRuntimePaths"))["rebaseProjectViewRuntimePaths"];
let persistMruList: (typeof import("../worktreeStore"))["persistMruList"];
let suppressMruRecording: (typeof import("../worktreeStore"))["suppressMruRecording"];
let hostOwnedWrites: typeof import("../persistence/hostOwnedWrites");
let panelPersistence: (typeof import("../persistence/panelPersistence"))["panelPersistence"];

/** The worktree feed after the move: it lists the main worktree at the new root. */
const feedIds = new Set([NEW, LINKED]);

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();

  ({ usePanelStore } = await import("../panelStore"));
  ({ useWorktreeSelectionStore, persistMruList, suppressMruRecording } =
    await import("../worktreeStore"));
  ({ useProjectStore } = await import("../projectStore"));
  ({ rebaseProjectViewRuntimePaths } = await import("../rebaseProjectViewRuntimePaths"));
  hostOwnedWrites = await import("../persistence/hostOwnedWrites");
  ({ panelPersistence } = await import("../persistence/panelPersistence"));
  const accessors = await import("../storeAccessors");
  await (await import("@/services/terminal/terminalInstanceServiceAccessor")).load();

  accessors.setPanelStoreAccessor(() => {
    const s = usePanelStore.getState();
    return { panelsById: s.panelsById, panelIds: s.panelIds, tabGroups: s.tabGroups };
  });
  accessors.setWorktreeSelectionAccessor(() => {
    const s = useWorktreeSelectionStore.getState();
    return {
      activeWorktreeId: s.activeWorktreeId,
      restoreWorktreeId: s.restoreWorktreeId,
      deletedWorktreeIds: new Set(s.deletedWorktrees.keys()),
    };
  });
  accessors.setWorktreeIdSetAccessor(() => feedIds);

  usePanelStore.setState({
    panelsById: { main1: terminal("main1", OLD), linked1: terminal("linked1", LINKED) },
    panelIds: ["main1", "linked1"],
    panelIdsByWorktreeId: { [OLD]: ["main1"], [LINKED]: ["linked1"] },
    mruList: [`worktree:${OLD}`],
  });
  useProjectStore.setState({ projects: [projectA, projectB], currentProject: projectA });
});

afterEach(async () => {
  hostOwnedWrites._resetHostOwnedWritesForTesting();
  await drain();
  panelPersistence.cancel();
  await usePanelStore.getState().reset();
});

describe("live project relocation (#17184)", () => {
  async function switchAwayAfterMove() {
    rebaseProjectViewRuntimePaths(OLD, NEW);
    await useProjectStore.getState().switchProject(projectB.id);
    await drain();
    expect(projectSwitchMock).toHaveBeenCalledTimes(1);
    return projectSwitchMock.mock.calls[0]![1];
  }

  it("keeps the durable worktree selection when switching away from the moved project", async () => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: OLD, restoreWorktreeId: OLD });

    const outgoing = await switchAwayAfterMove();

    expect(outgoing.activeWorktreeId).toBe(NEW);
    const byId = new Map(
      (outgoing.terminals as { id: string; worktreeId?: string }[]).map((t) => [t.id, t])
    );
    expect(byId.get("main1")?.worktreeId).toBe(NEW);
    expect(byId.get("linked1")?.worktreeId).toBe(LINKED);
    expect(JSON.stringify(outgoing.terminals)).not.toMatch(OLD_ROOT_REF);
  });

  it("sends the durable selection, not an incidentally active one, after the move", async () => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: LINKED, restoreWorktreeId: OLD });

    const outgoing = await switchAwayAfterMove();

    expect(outgoing.activeWorktreeId).toBe(NEW);
  });

  it("restores the moved worktree's focus and maximize after a round-trip, recording only new-root MRU", async () => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: OLD, restoreWorktreeId: OLD });
    useWorktreeSelectionStore.getState().trackTerminalFocus(OLD, "main1");
    usePanelStore.setState({
      focusedId: "main1",
      maximizedId: "main1",
      maximizeTarget: { type: "panel", id: "main1" },
      preMaximizeLayout: { gridCols: 2, gridItemCount: 2, worktreeId: OLD },
    });

    rebaseProjectViewRuntimePaths(OLD, NEW);
    await drain();
    expect(mruWrites()).toEqual([[`worktree:${NEW}`]]);

    useWorktreeSelectionStore.getState().selectWorktree(LINKED);
    await drain();
    expect(usePanelStore.getState().mruList).toEqual([`worktree:${LINKED}`, `worktree:${NEW}`]);
    expect(mruWrites().at(-1)).toEqual([`worktree:${LINKED}`, `worktree:${NEW}`]);

    usePanelStore.setState({ focusedId: "linked1" });
    useWorktreeSelectionStore.getState().selectWorktree(NEW);
    await drain();

    const panels = usePanelStore.getState();
    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe(NEW);
    expect(panels.focusedId).toBe("main1");
    expect(panels.maximizedId).toBe("main1");
    expect(panels.preMaximizeLayout).toEqual({ gridCols: 2, gridItemCount: 2, worktreeId: NEW });
    expect(panels.mruList).toEqual([`worktree:${NEW}`, `worktree:${LINKED}`]);
    expect(mruWrites()).toEqual([
      [`worktree:${NEW}`],
      [`worktree:${LINKED}`, `worktree:${NEW}`],
      [`worktree:${NEW}`, `worktree:${LINKED}`],
    ]);
    for (const list of mruWrites()) expect(JSON.stringify(list)).not.toMatch(OLD_ROOT_REF);
  });

  it("restores a parked maximize and last focus for a worktree that was inactive during the move", () => {
    useWorktreeSelectionStore.setState({
      activeWorktreeId: LINKED,
      restoreWorktreeId: LINKED,
      maximizeByWorktree: new Map([
        [
          OLD,
          {
            maximizedId: "main1",
            maximizeTarget: { type: "panel", id: "main1" },
            preMaximizeLayout: { gridCols: 3, gridItemCount: 4, worktreeId: OLD },
          },
        ],
      ]),
    });
    useWorktreeSelectionStore.getState().trackTerminalFocus(OLD, "main1");
    usePanelStore.setState({ focusedId: "linked1" });

    rebaseProjectViewRuntimePaths(OLD, NEW);
    useWorktreeSelectionStore.getState().selectWorktree(NEW);

    const panels = usePanelStore.getState();
    expect(panels.focusedId).toBe("main1");
    expect(panels.maximizedId).toBe("main1");
    expect(panels.maximizeTarget).toEqual({ type: "panel", id: "main1" });
    expect(panels.preMaximizeLayout).toEqual({ gridCols: 3, gridItemCount: 4, worktreeId: NEW });
    expect(useWorktreeSelectionStore.getState().restoreWorktreeId).toBe(NEW);
  });

  it.each([
    ["while selections are recorded", false],
    ["while hydration suppresses MRU recording", true],
  ])(
    "supersedes an old-root MRU write held for the host link, so it never replays (%s)",
    async (_label, suppressed) => {
      hostOwnedWrites.holdHostOwnedWrites();
      void persistMruList([`worktree:${OLD}`]);
      await drain();
      expect(hostOwnedWrites.hasDeferredHostOwnedWrite("app-state:mruList")).toBe(true);

      suppressMruRecording(suppressed);
      try {
        rebaseProjectViewRuntimePaths(OLD, NEW);
      } finally {
        suppressMruRecording(false);
      }
      await drain();
      hostOwnedWrites.releaseHostOwnedWrites();
      await drain();

      expect(mruWrites()).toEqual([[`worktree:${NEW}`]]);
    }
  );
});
