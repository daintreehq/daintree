// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PtyPanelData, TabGroup } from "@shared/types/panel";
import { TerminalRefreshTier } from "@/types";
import { setWorktreeSelectionAccessor } from "@/store/storeAccessors";
import { load as loadTerminalService } from "@/services/terminal/terminalInstanceServiceAccessor";
import { buildWorktreeIndex } from "../worktreeIndex";

vi.mock("@/clients", () => ({
  terminalClient: {
    resize: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    trash: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
    updateWorktreeId: vi.fn(),
  },
  agentSettingsClient: { get: vi.fn().mockResolvedValue(null) },
}));

vi.mock("@/services/TerminalInstanceService", () => {
  const terminalInstanceService = {
    cleanup: vi.fn(),
    destroy: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    resize: vi.fn().mockReturnValue(null),
  };
  return { createTerminalPaintPlane: () => terminalInstanceService };
});

vi.mock("../../../persistence/panelPersistence", () => ({
  panelPersistence: {
    setProjectIdGetter: vi.fn(),
    save: vi.fn(),
    saveTabGroups: vi.fn(),
    load: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("../../../persistence/tabGroupPersistence", () => ({
  tabGroupPersistence: { save: vi.fn(), load: vi.fn().mockReturnValue([]) },
}));

const { usePanelStore } = await import("../../../panelStore");
const service = (await import("@/services/TerminalInstanceService")).createTerminalPaintPlane();

function term(
  id: string,
  worktreeId: string,
  location: "grid" | "dock" | "trash" = "grid"
): PtyPanelData {
  return {
    id,
    title: id,
    kind: "terminal",
    cwd: "/test",
    cols: 80,
    rows: 24,
    worktreeId,
    location,
    isVisible: location === "grid",
  };
}

function seed(terminals: PtyPanelData[], groups: TabGroup[] = []) {
  const panelsById = Object.fromEntries(terminals.map((t) => [t.id, t]));
  const panelIds = terminals.map((t) => t.id);
  usePanelStore.setState({
    panelsById,
    panelIds,
    panelIdsByWorktreeId: buildWorktreeIndex(panelIds, panelsById),
    tabGroups: new Map(groups.map((g) => [g.id, g])),
    trashedTerminals: new Map(),
    backgroundedTerminals: new Map(),
  });
}

const tiersFor = (id: string) =>
  vi
    .mocked(service.applyRendererPolicy)
    .mock.calls.filter(([callId]) => callId === id)
    .map(([, tier]) => tier);

beforeAll(async () => {
  await loadTerminalService();
});

describe("refresh tier on trash, restore and move", () => {
  beforeEach(() => {
    usePanelStore.getState().reset();
    vi.clearAllMocks();
    setWorktreeSelectionAccessor(() => ({ activeWorktreeId: "wt-a", restoreWorktreeId: null }));
  });

  afterEach(() => {
    setWorktreeSelectionAccessor(() => ({ activeWorktreeId: null, restoreWorktreeId: null }));
  });

  it("demotes a trashed terminal instead of promoting it", () => {
    seed([term("t1", "wt-a")]);
    usePanelStore.getState().trashPanel("t1");
    expect(tiersFor("t1")).toEqual([TerminalRefreshTier.BACKGROUND]);
  });

  it("demotes every member of a trashed tab group", () => {
    seed(
      [term("t1", "wt-a"), term("t2", "wt-a")],
      [
        {
          id: "g1",
          location: "grid",
          worktreeId: "wt-a",
          activeTabId: "t1",
          panelIds: ["t1", "t2"],
        },
      ]
    );
    usePanelStore.getState().trashPanelGroup("t1");
    expect(tiersFor("t1")).toEqual([TerminalRefreshTier.BACKGROUND]);
    expect(tiersFor("t2")).toEqual([TerminalRefreshTier.BACKGROUND]);
  });

  it("demotes a terminal the host reports as trashed", () => {
    seed([term("t1", "wt-a", "trash")]);
    usePanelStore.getState().markAsTrashed("t1", Date.now() + 60_000, "grid");
    expect(tiersFor("t1")).toEqual([TerminalRefreshTier.BACKGROUND]);
  });

  it("ignores a stale trash acknowledgement for a terminal that is back on the grid", () => {
    seed([term("t1", "wt-a", "grid")]);
    usePanelStore.getState().markAsTrashed("t1", Date.now() + 60_000, "grid");
    expect(tiersFor("t1")).toEqual([]);
  });

  it("promotes a restored terminal in the active worktree", () => {
    seed([term("t1", "wt-a", "trash")]);
    usePanelStore.setState({
      trashedTerminals: new Map([
        ["t1", { id: "t1", expiresAt: Date.now() + 60_000, originalLocation: "grid" as const }],
      ]),
    });
    usePanelStore.getState().restoreTerminal("t1");
    expect(tiersFor("t1")).toEqual([TerminalRefreshTier.VISIBLE]);
  });

  it("keeps a terminal restored into an inactive worktree in BACKGROUND", () => {
    seed([term("t1", "wt-b", "trash")]);
    usePanelStore.setState({
      trashedTerminals: new Map([
        ["t1", { id: "t1", expiresAt: Date.now() + 60_000, originalLocation: "grid" as const }],
      ]),
    });
    usePanelStore.getState().restoreTerminal("t1");
    expect(tiersFor("t1")).toEqual([TerminalRefreshTier.BACKGROUND]);
  });

  it("reads the restore destination, not the trashed worktree, when restoring into the active one", () => {
    seed([term("t1", "wt-b", "trash")]);
    usePanelStore.setState({
      trashedTerminals: new Map([
        ["t1", { id: "t1", expiresAt: Date.now() + 60_000, originalLocation: "grid" as const }],
      ]),
    });
    usePanelStore.getState().restoreTerminal("t1", "wt-a");
    expect(tiersFor("t1")).toEqual([TerminalRefreshTier.VISIBLE]);
  });

  it("promotes only the active tab of a restored trashed group", () => {
    const meta = {
      panelIds: ["t1", "t2"],
      activeTabId: "t2",
      location: "grid" as const,
      worktreeId: "wt-a",
    };
    seed([term("t1", "wt-a", "trash"), term("t2", "wt-a", "trash")]);
    usePanelStore.setState({
      trashedTerminals: new Map(
        ["t1", "t2"].map((id) => [
          id,
          {
            id,
            expiresAt: Date.now() + 60_000,
            originalLocation: "grid" as const,
            groupRestoreId: "gr1",
            groupMetadata: meta,
          },
        ])
      ),
    });
    usePanelStore.getState().restoreTrashedGroup("gr1");
    expect(tiersFor("t2")).toEqual([TerminalRefreshTier.VISIBLE]);
    expect(tiersFor("t1")).toEqual([TerminalRefreshTier.BACKGROUND]);
  });

  it("keeps a restored trashed group in BACKGROUND when its worktree is inactive", () => {
    const meta = {
      panelIds: ["t1", "t2"],
      activeTabId: "t1",
      location: "grid" as const,
      worktreeId: "wt-b",
    };
    seed([term("t1", "wt-b", "trash"), term("t2", "wt-b", "trash")]);
    usePanelStore.setState({
      trashedTerminals: new Map(
        ["t1", "t2"].map((id) => [
          id,
          {
            id,
            expiresAt: Date.now() + 60_000,
            originalLocation: "grid" as const,
            groupRestoreId: "gr1",
            groupMetadata: meta,
          },
        ])
      ),
    });
    usePanelStore.getState().restoreTrashedGroup("gr1");
    expect(tiersFor("t1")).toEqual([TerminalRefreshTier.BACKGROUND]);
    expect(tiersFor("t2")).toEqual([TerminalRefreshTier.BACKGROUND]);
  });

  it("promotes a terminal the host reports as restored into the active worktree only", () => {
    seed([term("t1", "wt-a", "trash"), term("t2", "wt-b", "trash")]);
    usePanelStore.setState({
      trashedTerminals: new Map(
        ["t1", "t2"].map((id) => [
          id,
          { id, expiresAt: Date.now() + 60_000, originalLocation: "grid" as const },
        ])
      ),
    });
    usePanelStore.getState().markAsRestored("t1");
    usePanelStore.getState().markAsRestored("t2");
    expect(tiersFor("t1")).toEqual([TerminalRefreshTier.VISIBLE]);
    expect(tiersFor("t2")).toEqual([TerminalRefreshTier.BACKGROUND]);
  });

  it("promotes only the active tab when a docked group moves to the grid", () => {
    seed(
      [term("t1", "wt-a", "dock"), term("t2", "wt-a", "dock")],
      [
        {
          id: "g1",
          location: "dock",
          worktreeId: "wt-a",
          activeTabId: "t2",
          panelIds: ["t1", "t2"],
        },
      ]
    );
    usePanelStore.getState().moveTabGroupToLocation("g1", "grid");
    expect(tiersFor("t2")).toEqual([TerminalRefreshTier.VISIBLE]);
    expect(tiersFor("t1")).toEqual([TerminalRefreshTier.BACKGROUND]);
  });

  it("promotes only the active tab when a tab group moves to the active worktree", () => {
    seed(
      [term("t1", "wt-b"), term("t2", "wt-b")],
      [
        {
          id: "g1",
          location: "grid",
          worktreeId: "wt-b",
          activeTabId: "t1",
          panelIds: ["t1", "t2"],
        },
      ]
    );
    usePanelStore.getState().moveTabGroupToWorktree("g1", "wt-a");
    expect(tiersFor("t1")).toEqual([TerminalRefreshTier.VISIBLE]);
    expect(tiersFor("t2")).toEqual([TerminalRefreshTier.BACKGROUND]);
  });

  it("keeps a whole tab group in BACKGROUND when it moves to an inactive worktree", () => {
    seed(
      [term("t1", "wt-a"), term("t2", "wt-a")],
      [
        {
          id: "g1",
          location: "grid",
          worktreeId: "wt-a",
          activeTabId: "t1",
          panelIds: ["t1", "t2"],
        },
      ]
    );
    usePanelStore.getState().moveTabGroupToWorktree("g1", "wt-b");
    expect(tiersFor("t1")).toEqual([TerminalRefreshTier.BACKGROUND]);
    expect(tiersFor("t2")).toEqual([TerminalRefreshTier.BACKGROUND]);
  });
});
