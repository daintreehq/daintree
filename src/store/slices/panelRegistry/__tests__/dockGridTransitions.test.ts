import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilePanelData, PanelInstance, PtyPanelData, TabGroup } from "@shared/types/panel";
import { setWorktreeSelectionAccessor } from "@/store/storeAccessors";
import { agentLifecycleLedger } from "@/services/terminal/lifecycleLedger";
import { buildWorktreeIndex, NO_WORKTREE } from "../worktreeIndex";

vi.mock("@/clients", () => ({
  terminalClient: {
    resize: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
  },
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    resize: vi.fn().mockReturnValue(null),
  },
}));

vi.mock("../../../persistence/panelPersistence", () => ({
  panelPersistence: {
    setProjectIdGetter: vi.fn(),
    save: vi.fn(),
    saveTabGroups: vi.fn(),
    load: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("../../../persistence/tabGroupPersistence", () => ({
  tabGroupPersistence: {
    save: vi.fn(),
    load: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("@/store/layoutConfigStore", () => ({
  useLayoutConfigStore: {
    getState: vi.fn().mockReturnValue({
      getMaxGridCapacity: () => 6,
    }),
  },
}));

const { usePanelStore } = await import("../../../panelStore");

function setTerminals(terminals: PtyPanelData[]) {
  const panelsById = Object.fromEntries(terminals.map((t) => [t.id, t]));
  const panelIds = terminals.map((t) => t.id);
  usePanelStore.setState({
    panelsById,
    panelIds,
    panelIdsByWorktreeId: buildWorktreeIndex(panelIds, panelsById),
  });
}

function createMockTerminal(
  id: string,
  location: "grid" | "dock" | "trash" = "grid"
): PtyPanelData {
  return {
    id,
    title: `Terminal ${id}`,
    kind: "terminal" as const,
    cwd: "/test",
    cols: 80,
    rows: 24,
    worktreeId: "wt-1",
    location,
    isVisible: location === "grid",
  };
}

function createGlobalMockTerminal(
  id: string,
  location: "grid" | "dock" | "trash" = "grid"
): PtyPanelData {
  const terminal = createMockTerminal(id, location);
  return { ...terminal, worktreeId: undefined };
}

function createMockTabGroup(
  id: string,
  panelIds: string[],
  location: "grid" | "dock" = "grid"
): TabGroup {
  return {
    id,
    panelIds,
    activeTabId: panelIds[0]!,
    location,
    worktreeId: "wt-1",
  };
}

describe("dock ↔ grid transitions", () => {
  beforeEach(() => {
    usePanelStore.setState({
      panelsById: {},
      panelIds: [],
      panelIdsByWorktreeId: {},
      tabGroups: new Map(),
      trashedTerminals: new Map(),
    });
  });

  afterEach(() => {
    setWorktreeSelectionAccessor(() => ({ activeWorktreeId: null, restoreWorktreeId: null }));
    vi.restoreAllMocks();
  });

  describe("moveTerminalToDock visibility parity", () => {
    it("sets isVisible=false and derives runtimeStatus for a single ungrouped panel", () => {
      const t = createMockTerminal("t1", "grid");
      t.isVisible = true;
      t.runtimeStatus = "running";
      setTerminals([t]);

      usePanelStore.getState().moveTerminalToDock("t1");

      const updated = usePanelStore.getState().panelsById["t1"] as PtyPanelData | undefined;
      expect(updated!.location).toBe("dock");
      expect(updated!.isVisible).toBe(false);
      expect(updated!.runtimeStatus).toBe("background");
    });

    it("moves a file panel to the dock and back without PTY-only fields", () => {
      usePanelStore.setState((state) => ({
        panelsById: {
          ...state.panelsById,
          "file-1": {
            id: "file-1",
            kind: "file",
            title: "spec.md",
            location: "grid",
            isVisible: true,
            filePath: "/repo/spec.md",
          } as PanelInstance,
        },
        panelIds: [...state.panelIds, "file-1"],
      }));

      usePanelStore.getState().moveTerminalToDock("file-1");
      let updated = usePanelStore.getState().panelsById["file-1"];
      expect(updated!.location).toBe("dock");
      expect(updated!.isVisible).toBe(false);

      const moved = usePanelStore.getState().moveTerminalToGrid("file-1");
      expect(moved).toBe(true);
      updated = usePanelStore.getState().panelsById["file-1"];
      expect(updated!.location).toBe("grid");
      expect(updated!.isVisible).toBe(true);
    });
  });

  describe("moveTerminalToGrid", () => {
    it("sets isVisible=true and location=grid for a docked panel", () => {
      const t = createMockTerminal("t1", "dock");
      t.isVisible = false;
      t.runtimeStatus = "background";
      setTerminals([t]);

      const moved = usePanelStore.getState().moveTerminalToGrid("t1");

      expect(moved).toBe(true);
      const updated = usePanelStore.getState().panelsById["t1"];
      expect(updated!.location).toBe("grid");
      expect(updated!.isVisible).toBe(true);
    });

    it("is idempotent — calling twice on an already-grid panel returns false", () => {
      const t = createMockTerminal("t1", "grid");
      setTerminals([t]);

      const moved = usePanelStore.getState().moveTerminalToGrid("t1");
      expect(moved).toBe(false);
    });

    it("restores a docked panel even when a stale persisted group still says grid", () => {
      const t1 = createMockTerminal("t1", "dock");
      const t2 = createMockTerminal("t2", "grid");
      setTerminals([t1, t2]);

      const staleGroup = createMockTabGroup("g1", ["t1", "t2"], "grid");
      usePanelStore.setState({ tabGroups: new Map([["g1", staleGroup]]) });

      expect(usePanelStore.getState().getPanelGroup("t1")).toBeUndefined();

      const moved = usePanelStore.getState().moveTerminalToGrid("t1");

      expect(moved).toBe(true);
      expect(usePanelStore.getState().panelsById["t1"]!.location).toBe("grid");
      expect(usePanelStore.getState().panelsById["t1"]!.isVisible).toBe(true);
      expect(usePanelStore.getState().tabGroups.has("g1")).toBe(false);
    });

    it("removes stale dock group membership on drag-style single panel moves", () => {
      const t1 = createMockTerminal("t1", "dock");
      const t2 = createMockTerminal("t2", "dock");
      setTerminals([t1, t2]);

      const staleDockGroup = createMockTabGroup("g1", ["t1", "t2"], "dock");
      usePanelStore.setState({ tabGroups: new Map([["g1", staleDockGroup]]) });

      usePanelStore.getState().moveTerminalToPosition("t1", 0, "grid", "wt-1");

      expect(usePanelStore.getState().panelsById["t1"]!.location).toBe("grid");
      expect(
        usePanelStore
          .getState()
          .getTabGroups("dock", "wt-1")
          .map((g) => g.panelIds)
      ).toEqual([["t2"]]);
      expect(usePanelStore.getState().getPanelGroup("t1")).toBeUndefined();
      expect(usePanelStore.getState().tabGroups.has("g1")).toBe(false);
    });

    it("clears activeDockTerminalId when moving a dock tab group to grid directly", () => {
      const t1 = createMockTerminal("t1", "dock");
      const t2 = createMockTerminal("t2", "dock");
      setTerminals([t1, t2]);

      const group = createMockTabGroup("g1", ["t1", "t2"], "dock");
      usePanelStore.setState({
        tabGroups: new Map([["g1", group]]),
        activeDockTerminalId: "t2",
        focusedId: "t2",
      });

      const moved = usePanelStore.getState().moveTabGroupToLocation("g1", "grid");

      expect(moved).toBe(true);
      expect(usePanelStore.getState().activeDockTerminalId).toBeNull();
      expect(usePanelStore.getState().focusedId).toBe("t1");
      expect(usePanelStore.getState().getTabGroups("dock", "wt-1")).toHaveLength(0);
    });
  });

  describe("getTabGroups dock visibility", () => {
    it("includes global dock panels in a worktree-scoped dock", () => {
      const globalDocked = createGlobalMockTerminal("global-dock", "dock");
      const worktreeDocked = createMockTerminal("worktree-dock", "dock");
      setTerminals([globalDocked, worktreeDocked]);

      const groups = usePanelStore.getState().getTabGroups("dock", "wt-1");

      expect(groups.map((g) => g.panelIds)).toEqual([["global-dock"], ["worktree-dock"]]);
    });

    it("removes a global dock panel from dock groups after restoring it to grid", () => {
      const globalDocked = createGlobalMockTerminal("global-dock", "dock");
      setTerminals([globalDocked]);

      expect(usePanelStore.getState().getTabGroups("dock", "wt-1")).toHaveLength(1);

      const moved = usePanelStore.getState().moveTerminalToGrid("global-dock");

      expect(moved).toBe(true);
      expect(usePanelStore.getState().getTabGroups("dock", "wt-1")).toHaveLength(0);
    });

    it("filters stale grid members out when resolving panels for a dock group", () => {
      const t1 = createMockTerminal("t1", "dock");
      const t2 = createMockTerminal("t2", "grid");
      const group = createMockTabGroup("g1", ["t1", "t2"], "dock");
      setTerminals([t1, t2]);
      usePanelStore.setState({ tabGroups: new Map([["g1", group]]) });

      expect(usePanelStore.getState().getTabGroups("dock", "wt-1")[0]?.panelIds).toEqual(["t1"]);
      expect(
        usePanelStore
          .getState()
          .getTabGroupPanels("g1", "dock")
          .map((p) => p.id)
      ).toEqual(["t1"]);
    });

    it("updates visibility and runtimeStatus on drag-style dock to grid moves", () => {
      const t1 = createMockTerminal("t1", "dock");
      t1.isVisible = false;
      t1.runtimeStatus = "background";
      setTerminals([t1]);

      usePanelStore.getState().moveTerminalToPosition("t1", 0, "grid", "wt-1");

      const updated = usePanelStore.getState().panelsById["t1"] as PtyPanelData | undefined;
      expect(updated!.location).toBe("grid");
      expect(updated!.isVisible).toBe(true);
      expect(updated!.runtimeStatus).toBe("running");
      expect(usePanelStore.getState().getTabGroups("dock", "wt-1")).toHaveLength(0);
    });
  });

  describe("worktree-less panel promotion (#11290)", () => {
    const activateWorktree = (id: string) => {
      setWorktreeSelectionAccessor(() => ({ activeWorktreeId: id, restoreWorktreeId: null }));
    };

    it("assigns the active worktree and transfers the index bucket when promoting a worktree-less dock panel", () => {
      const globalDocked = createGlobalMockTerminal("global-dock", "dock");
      const globalSibling = createGlobalMockTerminal("global-2", "dock");
      const existing = createMockTerminal("wt1-existing", "grid");
      const unrelated = { ...createMockTerminal("wt2-panel", "grid"), worktreeId: "wt-2" };
      setTerminals([globalDocked, globalSibling, existing, unrelated]);
      activateWorktree("wt-1");

      const bucketsBefore = usePanelStore.getState().panelIdsByWorktreeId;
      const moved = usePanelStore.getState().moveTerminalToGrid("global-dock");

      expect(moved).toBe(true);
      const state = usePanelStore.getState();
      expect(state.panelsById["global-dock"]!.worktreeId).toBe("wt-1");
      expect(state.panelsById["global-dock"]!.location).toBe("grid");
      expect(state.panelIdsByWorktreeId["wt-1"]).toEqual(["wt1-existing", "global-dock"]);
      expect(state.panelIdsByWorktreeId[NO_WORKTREE]).toEqual(["global-2"]);
      expect(state.panelIdsByWorktreeId["wt-2"]).toBe(bucketsBefore["wt-2"]);
    });

    it("adopts the active worktree for a non-PTY file panel promoted from the dock", () => {
      usePanelStore.setState((state) => {
        const filePanel: FilePanelData = {
          id: "file-1",
          kind: "file",
          title: "spec.md",
          location: "dock",
          isVisible: false,
          filePath: "/repo/spec.md",
        };
        const panelsById = { ...state.panelsById, "file-1": filePanel };
        const panelIds = [...state.panelIds, "file-1"];
        return {
          panelsById,
          panelIds,
          panelIdsByWorktreeId: buildWorktreeIndex(panelIds, panelsById),
        };
      });
      activateWorktree("wt-1");

      const moved = usePanelStore.getState().moveTerminalToGrid("file-1");

      expect(moved).toBe(true);
      const state = usePanelStore.getState();
      expect(state.panelsById["file-1"]!.worktreeId).toBe("wt-1");
      expect(state.panelsById["file-1"]!.location).toBe("grid");
      expect(state.panelIdsByWorktreeId["wt-1"]).toEqual(["file-1"]);
      expect(state.panelIdsByWorktreeId[NO_WORKTREE]).toBeUndefined();
    });

    it("leaves a worktree-less panel unassigned when no worktree is active", () => {
      const globalDocked = createGlobalMockTerminal("global-dock", "dock");
      setTerminals([globalDocked]);
      setWorktreeSelectionAccessor(() => ({ activeWorktreeId: null, restoreWorktreeId: null }));

      const bucketsBefore = usePanelStore.getState().panelIdsByWorktreeId;
      const moved = usePanelStore.getState().moveTerminalToGrid("global-dock");

      expect(moved).toBe(true);
      const state = usePanelStore.getState();
      expect(state.panelsById["global-dock"]!.worktreeId).toBeUndefined();
      expect(state.panelsById["global-dock"]!.location).toBe("grid");
      expect(state.panelIdsByWorktreeId).toBe(bucketsBefore);
      expect(state.panelIdsByWorktreeId[NO_WORKTREE]).toEqual(["global-dock"]);
    });

    it("never replaces a real worktree attribution on promotion", () => {
      const docked = { ...createMockTerminal("t1", "dock"), worktreeId: "wt-2" };
      setTerminals([docked]);
      activateWorktree("wt-1");

      const bucketsBefore = usePanelStore.getState().panelIdsByWorktreeId;
      const moved = usePanelStore.getState().moveTerminalToGrid("t1");

      expect(moved).toBe(true);
      const state = usePanelStore.getState();
      expect(state.panelsById["t1"]!.worktreeId).toBe("wt-2");
      expect(state.panelIdsByWorktreeId).toBe(bucketsBefore);
    });

    const spyOnLedger = () => {
      vi.spyOn(agentLifecycleLedger, "currentGeneration").mockReturnValue(3);
      return vi
        .spyOn(agentLifecycleLedger, "recordWorktreeAttribution")
        .mockReturnValue({ accepted: true });
    };

    it("records explicit ledger attribution for a promoted ledger-tracked panel", () => {
      const globalDocked = createGlobalMockTerminal("global-dock", "dock");
      setTerminals([globalDocked]);
      activateWorktree("wt-1");
      const recordSpy = spyOnLedger();

      usePanelStore.getState().moveTerminalToGrid("global-dock");

      expect(recordSpy).toHaveBeenCalledWith("global-dock", 3, "wt-1", "explicit");
    });

    it("records explicit ledger attribution on a drag-style adoption", () => {
      const globalDocked = createGlobalMockTerminal("t1", "dock");
      setTerminals([globalDocked]);
      const recordSpy = spyOnLedger();

      usePanelStore.getState().moveTerminalToPosition("t1", 0, "grid", "wt-1");

      expect(recordSpy).toHaveBeenCalledWith("t1", 3, "wt-1", "explicit");
    });

    it("records no ledger attribution when promotion adopts nothing", () => {
      const globalDocked = createGlobalMockTerminal("global-dock", "dock");
      setTerminals([globalDocked]);
      setWorktreeSelectionAccessor(() => ({ activeWorktreeId: null, restoreWorktreeId: null }));
      const recordSpy = spyOnLedger();

      usePanelStore.getState().moveTerminalToGrid("global-dock");

      expect(recordSpy).not.toHaveBeenCalled();
    });

    it("assigns the active worktree to a promoted worktree-less dock group and its members", () => {
      const t1 = createGlobalMockTerminal("t1", "dock");
      const t2 = createGlobalMockTerminal("t2", "dock");
      const existing = createMockTerminal("wt1-existing", "grid");
      const unrelated = { ...createMockTerminal("wt2-panel", "grid"), worktreeId: "wt-2" };
      setTerminals([t1, t2, existing, unrelated]);
      const group: TabGroup = {
        ...createMockTabGroup("g1", ["t1", "t2"], "dock"),
        worktreeId: undefined,
      };
      usePanelStore.setState({ tabGroups: new Map([["g1", group]]) });
      activateWorktree("wt-1");
      const recordSpy = spyOnLedger();

      const bucketsBefore = usePanelStore.getState().panelIdsByWorktreeId;
      const moved = usePanelStore.getState().moveTerminalToGrid("t1");

      expect(moved).toBe(true);
      const state = usePanelStore.getState();
      expect(state.tabGroups.get("g1")!.worktreeId).toBe("wt-1");
      expect(state.tabGroups.get("g1")!.location).toBe("grid");
      for (const pid of ["t1", "t2"]) {
        expect(state.panelsById[pid]!.worktreeId).toBe("wt-1");
        expect(state.panelsById[pid]!.location).toBe("grid");
        expect(state.panelsById[pid]!.isVisible).toBe(true);
      }
      expect(state.panelIdsByWorktreeId["wt-1"]).toEqual(["wt1-existing", "t1", "t2"]);
      expect(state.panelIdsByWorktreeId[NO_WORKTREE]).toBeUndefined();
      expect(state.panelIdsByWorktreeId["wt-2"]).toBe(bucketsBefore["wt-2"]);
      expect(recordSpy.mock.calls).toEqual([
        ["t1", 3, "wt-1", "explicit"],
        ["t2", 3, "wt-1", "explicit"],
      ]);
    });

    it("re-homes a drifted member indexed under another worktree when promoting a worktree-less group", () => {
      const t1 = createGlobalMockTerminal("t1", "dock");
      const drifted = { ...createMockTerminal("t2", "dock"), worktreeId: "wt-3" };
      setTerminals([t1, drifted]);
      const group: TabGroup = {
        ...createMockTabGroup("g1", ["t1", "t2"], "dock"),
        worktreeId: undefined,
      };
      usePanelStore.setState({ tabGroups: new Map([["g1", group]]) });
      activateWorktree("wt-1");

      const moved = usePanelStore.getState().moveTabGroupToLocation("g1", "grid");

      expect(moved).toBe(true);
      const state = usePanelStore.getState();
      expect(state.panelsById["t1"]!.worktreeId).toBe("wt-1");
      expect(state.panelsById["t2"]!.worktreeId).toBe("wt-1");
      expect(state.panelIdsByWorktreeId["wt-1"]).toEqual(["t1", "t2"]);
      expect(state.panelIdsByWorktreeId["wt-3"]).toBeUndefined();
      expect(state.panelIdsByWorktreeId[NO_WORKTREE]).toBeUndefined();
    });

    it("adopts the active worktree when promoting a worktree-less dialog panel to the grid", () => {
      usePanelStore.setState((state) => {
        const dialogPanel: FilePanelData = {
          id: "dlg-1",
          kind: "file",
          title: "outside.md",
          location: "dialog",
          isVisible: false,
          filePath: "/outside/outside.md",
          excludeFromPersistence: true,
        };
        const panelsById = { ...state.panelsById, "dlg-1": dialogPanel };
        const panelIds = [...state.panelIds, "dlg-1"];
        return {
          panelsById,
          panelIds,
          panelIdsByWorktreeId: buildWorktreeIndex(panelIds, panelsById),
        };
      });
      activateWorktree("wt-1");

      const promoted = usePanelStore.getState().promoteDialogPanelToGrid("dlg-1");

      expect(promoted).toBe(true);
      const state = usePanelStore.getState();
      expect(state.panelsById["dlg-1"]!.worktreeId).toBe("wt-1");
      expect(state.panelsById["dlg-1"]!.location).toBe("grid");
      expect(state.panelIdsByWorktreeId["wt-1"]).toEqual(["dlg-1"]);
      expect(state.panelIdsByWorktreeId[NO_WORKTREE]).toBeUndefined();
    });

    it("skips trashed members when promoting a worktree-less dock group", () => {
      const t1 = createGlobalMockTerminal("t1", "dock");
      const t2 = createGlobalMockTerminal("t2", "trash");
      setTerminals([t1, t2]);
      const group: TabGroup = {
        ...createMockTabGroup("g1", ["t1", "t2"], "dock"),
        worktreeId: undefined,
      };
      usePanelStore.setState({ tabGroups: new Map([["g1", group]]) });
      activateWorktree("wt-1");
      const recordSpy = spyOnLedger();

      const moved = usePanelStore.getState().moveTabGroupToLocation("g1", "grid");

      expect(moved).toBe(true);
      const state = usePanelStore.getState();
      expect(state.panelsById["t1"]!.worktreeId).toBe("wt-1");
      expect(state.panelsById["t2"]!.worktreeId).toBeUndefined();
      expect(state.panelsById["t2"]!.location).toBe("trash");
      expect(state.panelIdsByWorktreeId["wt-1"]).toEqual(["t1"]);
      expect(state.panelIdsByWorktreeId[NO_WORKTREE]).toEqual(["t2"]);
      expect(recordSpy.mock.calls).toEqual([["t1", 3, "wt-1", "explicit"]]);
      // The group adopts while the trashed member keeps its old attribution
      // and its membership slot — the same trade moveTabGroupToWorktree makes;
      // every consumer filters trashed members out of live group reads.
      expect(state.tabGroups.get("g1")!.worktreeId).toBe("wt-1");
      expect(state.tabGroups.get("g1")!.panelIds).toEqual(["t1", "t2"]);
    });

    it("leaves a worktree-less dock group global when no worktree is active", () => {
      const t1 = createGlobalMockTerminal("t1", "dock");
      const t2 = createGlobalMockTerminal("t2", "dock");
      setTerminals([t1, t2]);
      const group: TabGroup = {
        ...createMockTabGroup("g1", ["t1", "t2"], "dock"),
        worktreeId: undefined,
      };
      usePanelStore.setState({ tabGroups: new Map([["g1", group]]) });
      setWorktreeSelectionAccessor(() => ({ activeWorktreeId: null, restoreWorktreeId: null }));

      const bucketsBefore = usePanelStore.getState().panelIdsByWorktreeId;
      const moved = usePanelStore.getState().moveTerminalToGrid("t1");

      expect(moved).toBe(true);
      const state = usePanelStore.getState();
      expect(state.tabGroups.get("g1")!.worktreeId).toBeUndefined();
      expect(state.tabGroups.get("g1")!.location).toBe("grid");
      expect(state.panelsById["t1"]!.worktreeId).toBeUndefined();
      expect(state.panelsById["t2"]!.worktreeId).toBeUndefined();
      expect(state.panelIdsByWorktreeId).toBe(bucketsBefore);
      expect(state.panelIdsByWorktreeId[NO_WORKTREE]).toEqual(["t1", "t2"]);
    });

    it("adopts the drop target worktree on a drag-style dock-to-grid move", () => {
      const existing = createMockTerminal("wt1-existing", "grid");
      const globalDocked = createGlobalMockTerminal("t1", "dock");
      const globalSibling = createGlobalMockTerminal("global-2", "dock");
      setTerminals([existing, globalDocked, globalSibling]);

      usePanelStore.getState().moveTerminalToPosition("t1", 0, "grid", "wt-1");

      const state = usePanelStore.getState();
      expect(state.panelsById["t1"]!.worktreeId).toBe("wt-1");
      expect(state.panelsById["t1"]!.location).toBe("grid");
      expect(state.panelIdsByWorktreeId["wt-1"]).toEqual(["t1", "wt1-existing"]);
      expect(state.panelIdsByWorktreeId[NO_WORKTREE]).toEqual(["global-2"]);
    });

    it("keeps a worktree-less panel global on a drag-style move with no target worktree", () => {
      const globalDocked = createGlobalMockTerminal("t1", "dock");
      setTerminals([globalDocked]);

      usePanelStore.getState().moveTerminalToPosition("t1", 0, "grid", null);

      const state = usePanelStore.getState();
      expect(state.panelsById["t1"]!.worktreeId).toBeUndefined();
      expect(state.panelsById["t1"]!.location).toBe("grid");
      expect(state.panelIdsByWorktreeId[NO_WORKTREE]).toEqual(["t1"]);
    });

    it("keeps a worktree-less panel global on a drag-style move with an omitted target worktree", () => {
      const globalDocked = createGlobalMockTerminal("t1", "dock");
      setTerminals([globalDocked]);

      usePanelStore.getState().moveTerminalToPosition("t1", 0, "grid");

      const state = usePanelStore.getState();
      expect(state.panelsById["t1"]!.worktreeId).toBeUndefined();
      expect(state.panelsById["t1"]!.location).toBe("grid");
      expect(state.panelIdsByWorktreeId[NO_WORKTREE]).toEqual(["t1"]);
    });

    it("does not adopt a worktree when a drag-style move targets the dock", () => {
      const globalGrid = createGlobalMockTerminal("t1", "grid");
      setTerminals([globalGrid]);

      usePanelStore.getState().moveTerminalToPosition("t1", 0, "dock", "wt-1");

      const state = usePanelStore.getState();
      expect(state.panelsById["t1"]!.worktreeId).toBeUndefined();
      expect(state.panelsById["t1"]!.location).toBe("dock");
      expect(state.panelIdsByWorktreeId[NO_WORKTREE]).toEqual(["t1"]);
    });
  });

  describe("hydrateTabGroups — dock location preservation", () => {
    it("preserves terminal dock location when group says grid", () => {
      // t1 was docked after the group was recorded; t2 stays in grid
      const t1 = createMockTerminal("t1", "dock");
      t1.isVisible = false;
      const t2 = createMockTerminal("t2", "grid");
      setTerminals([t1, t2]);

      // Group was persisted when both were in grid
      const group = createMockTabGroup("g1", ["t1", "t2"], "grid");
      usePanelStore.setState({ tabGroups: new Map([["g1", group]]) });

      // hydrateTabGroups expects an iterable of TabGroup values
      usePanelStore.getState().hydrateTabGroups([group]);

      const updated = usePanelStore.getState().panelsById["t1"];
      expect(updated!.location).toBe("dock");
      expect(updated!.isVisible).toBe(false);
      expect(usePanelStore.getState().getPanelGroup("t1")).toBeUndefined();
    });

    it("applies group location when terminal is already in grid", () => {
      const t1 = createMockTerminal("t1", "grid");
      const t2 = createMockTerminal("t2", "grid");
      setTerminals([t1, t2]);

      const group = createMockTabGroup("g1", ["t1", "t2"], "grid");
      usePanelStore.setState({ tabGroups: new Map([["g1", group]]) });

      usePanelStore.getState().hydrateTabGroups([group]);

      // Both terminals remain in grid — no override needed
      const updated = usePanelStore.getState().panelsById["t1"];
      expect(updated!.location).toBe("grid");
      expect(updated!.isVisible).toBe(true);
    });

    it("preserves terminal grid location when group says dock", () => {
      const t1 = createMockTerminal("t1", "grid");
      const t2 = createMockTerminal("t2", "grid");
      setTerminals([t1, t2]);

      const group = createMockTabGroup("g1", ["t1", "t2"], "dock");
      usePanelStore.setState({ tabGroups: new Map([["g1", group]]) });

      usePanelStore.getState().hydrateTabGroups([group]);

      const updated = usePanelStore.getState().panelsById["t1"];
      expect(updated!.location).toBe("grid");
      expect(updated!.isVisible).toBe(true);
      expect(usePanelStore.getState().tabGroups.has("g1")).toBe(false);
    });
  });

  describe("worktree-scoped dock ordering with global panels (#11289)", () => {
    function seedPanels(terminals: PtyPanelData[]) {
      const panelsById = Object.fromEntries(terminals.map((t) => [t.id, t]));
      const panelIds = terminals.map((t) => t.id);
      usePanelStore.setState({
        panelsById,
        panelIds,
        panelIdsByWorktreeId: buildWorktreeIndex(panelIds, panelsById),
      });
    }

    function makeWt2Terminal(id: string, location: "grid" | "dock"): PtyPanelData {
      return { ...createMockTerminal(id, location), worktreeId: "wt-2" };
    }

    function dockOrder(worktreeId: string): string[] {
      return usePanelStore
        .getState()
        .getTabGroups("dock", worktreeId)
        .flatMap((g) => g.panelIds);
    }

    it("reorders a global chip among scoped chips instead of silently no-opping", () => {
      const g1 = createGlobalMockTerminal("g1", "dock");
      const a = createMockTerminal("a", "dock");
      const b = createMockTerminal("b", "dock");
      const x = makeWt2Terminal("x", "dock");
      seedPanels([g1, a, b, x]);

      // Rendered dock for wt-1 is [g1, a, b] — drag g1 to the end.
      usePanelStore.getState().reorderTerminals(0, 2, "dock", "wt-1");

      expect(dockOrder("wt-1")).toEqual(["a", "b", "g1"]);
      expect(usePanelStore.getState().panelIds).toEqual(["a", "b", "g1", "x"]);
    });

    it("reorders a scoped chip past a global chip into the rendered slot", () => {
      const g1 = createGlobalMockTerminal("g1", "dock");
      const a = createMockTerminal("a", "dock");
      const b = createMockTerminal("b", "dock");
      const x = makeWt2Terminal("x", "dock");
      seedPanels([g1, a, b, x]);

      // Rendered dock for wt-1 is [g1, a, b] — drag "a" (index 1) to the front.
      usePanelStore.getState().reorderTerminals(1, 0, "dock", "wt-1");

      expect(dockOrder("wt-1")).toEqual(["a", "g1", "b"]);
      expect(usePanelStore.getState().panelIds).toEqual(["a", "g1", "b", "x"]);
    });

    it("rebuilds the per-worktree buckets after a global chip reorder", () => {
      const g1 = createGlobalMockTerminal("g1", "dock");
      const g2 = createGlobalMockTerminal("g2", "dock");
      const a = createMockTerminal("a", "dock");
      const x = makeWt2Terminal("x", "dock");
      seedPanels([g1, g2, a, x]);

      // Rendered dock for wt-1 is [g1, g2, a] — drag g2 to the front.
      usePanelStore.getState().reorderTerminals(1, 0, "dock", "wt-1");

      const buckets = usePanelStore.getState().panelIdsByWorktreeId;
      expect(buckets["__none__"]).toEqual(["g2", "g1"]);
      expect(buckets["wt-1"]).toEqual(["a"]);
      expect(buckets["wt-2"]).toEqual(["x"]);
    });

    it("reorders a dock that contains only global chips while a worktree is active", () => {
      // The literal issue repro: panels launched with no worktree active, then
      // a worktree is selected — the exact-match scope saw an empty list and
      // every drag silently no-opped.
      const g1 = createGlobalMockTerminal("g1", "dock");
      const g2 = createGlobalMockTerminal("g2", "dock");
      seedPanels([g1, g2]);

      usePanelStore.getState().reorderTerminals(0, 1, "dock", "wt-1");

      expect(dockOrder("wt-1")).toEqual(["g2", "g1"]);
      expect(usePanelStore.getState().panelIds).toEqual(["g2", "g1"]);
    });

    it("counts global chips when inserting a grid panel into a dock slot", () => {
      const g1 = createGlobalMockTerminal("g1", "dock");
      const a = createMockTerminal("a", "dock");
      const t = createMockTerminal("t", "grid");
      seedPanels([g1, a, t]);

      // Rendered dock for wt-1 is [g1, a]; slot 1 sits between them.
      usePanelStore.getState().moveTerminalToPosition("t", 1, "dock", "wt-1");

      expect(dockOrder("wt-1")).toEqual(["g1", "t", "a"]);
    });

    it("inserts at the dock front ahead of a leading global chip", () => {
      const g1 = createGlobalMockTerminal("g1", "dock");
      const a = createMockTerminal("a", "dock");
      const t = createMockTerminal("t", "grid");
      seedPanels([g1, a, t]);

      usePanelStore.getState().moveTerminalToPosition("t", 0, "dock", "wt-1");

      expect(dockOrder("wt-1")).toEqual(["t", "g1", "a"]);
    });

    it("keeps a global group's members in their committed position on group reorder", () => {
      // A global tab group (worktreeId undefined, global members) is what the
      // dock launcher produces with no worktree active — the realistic
      // explicit-group shape that renders in every worktree's dock.
      const g1 = createGlobalMockTerminal("g1", "dock");
      const g2 = createGlobalMockTerminal("g2", "dock");
      const c = createMockTerminal("c", "dock");
      const d = createMockTerminal("d", "dock");
      seedPanels([g1, g2, c, d]);
      const globalGroup: TabGroup = {
        id: "G",
        panelIds: ["g1", "g2"],
        activeTabId: "g1",
        location: "dock",
        worktreeId: undefined,
      };
      usePanelStore.setState({ tabGroups: new Map([["G", globalGroup]]) });

      // Groups render as [G(g1, g2), c, d] — move c after d. The global
      // group must hold position 0; the pre-fix tail eviction shoved its
      // members to the end instead.
      usePanelStore.getState().reorderTabGroups(1, 2, "dock", "wt-1");

      expect(dockOrder("wt-1")).toEqual(["g1", "g2", "d", "c"]);
      expect(usePanelStore.getState().panelIds).toEqual(["g1", "g2", "d", "c"]);
    });

    it("reorders single-chip groups across a global chip correctly", () => {
      const g1 = createGlobalMockTerminal("g1", "dock");
      const a = createMockTerminal("a", "dock");
      const b = createMockTerminal("b", "dock");
      seedPanels([g1, a, b]);

      // Virtual groups render as [g1], [a], [b] — move b to the front.
      usePanelStore.getState().reorderTabGroups(2, 0, "dock", "wt-1");

      expect(dockOrder("wt-1")).toEqual(["b", "g1", "a"]);
      expect(usePanelStore.getState().panelIds).toEqual(["b", "g1", "a"]);
    });

    it("keeps grid reorders worktree-exact — global grid panels stay out of scope", () => {
      const gg = createGlobalMockTerminal("gg", "grid");
      const a = createMockTerminal("a", "grid");
      const b = createMockTerminal("b", "grid");
      seedPanels([gg, a, b]);

      // Grid scope for wt-1 is [a, b]; swapping them must not move gg.
      usePanelStore.getState().reorderTerminals(0, 1, "grid", "wt-1");

      expect(usePanelStore.getState().panelIds).toEqual(["gg", "b", "a"]);
    });
  });

  describe("dockability write-site guards (#11375)", () => {
    // A non-dockable panel shaped like a PTY carrier — the store keys the guard
    // off `kind`, and "review" is a non-dockable built-in.
    const nonDockable = (id: string, location: "grid" | "dock" = "grid"): PtyPanelData =>
      ({ ...createMockTerminal(id, location), kind: "review" }) as unknown as PtyPanelData;

    it("moveTerminalToDock leaves a non-dockable panel in the grid (direct-move reject)", () => {
      setTerminals([nonDockable("t1", "grid")]);

      usePanelStore.getState().moveTerminalToDock("t1");

      expect(usePanelStore.getState().panelsById["t1"]?.location).toBe("grid");
    });

    it("moveTerminalToDock still docks a dockable panel", () => {
      setTerminals([createMockTerminal("t1", "grid")]);

      usePanelStore.getState().moveTerminalToDock("t1");

      expect(usePanelStore.getState().panelsById["t1"]?.location).toBe("dock");
    });

    it("moveTerminalToPosition redirects a dock target for a non-dockable kind to the grid", () => {
      setTerminals([nonDockable("t1", "grid")]);

      usePanelStore.getState().moveTerminalToPosition("t1", 0, "dock", "wt-1");

      const updated = usePanelStore.getState().panelsById["t1"];
      expect(updated?.location).toBe("grid");
      expect(updated?.isVisible).toBe(true);
    });

    it("moveTabGroupToLocation rescues a mixed group to the grid (all-or-nothing)", () => {
      const a = createMockTerminal("a", "grid");
      const b = nonDockable("b", "grid");
      setTerminals([a, b]);
      usePanelStore.setState({
        tabGroups: new Map([["g1", createMockTabGroup("g1", ["a", "b"])]]),
      });

      usePanelStore.getState().moveTabGroupToLocation("g1", "dock");

      // The whole group stays in the grid — one non-dockable member blocks the
      // dock move; the group is never split across grid and dock.
      const state = usePanelStore.getState();
      expect(state.tabGroups.get("g1")?.location).toBe("grid");
      expect(state.panelsById["a"]?.location).toBe("grid");
      expect(state.panelsById["b"]?.location).toBe("grid");
    });

    it("moveTabGroupToLocation docks an all-dockable group", () => {
      const a = createMockTerminal("a", "grid");
      const b = createMockTerminal("b", "grid");
      setTerminals([a, b]);
      usePanelStore.setState({
        tabGroups: new Map([["g1", createMockTabGroup("g1", ["a", "b"])]]),
      });

      usePanelStore.getState().moveTabGroupToLocation("g1", "dock");

      const state = usePanelStore.getState();
      expect(state.tabGroups.get("g1")?.location).toBe("dock");
      expect(state.panelsById["a"]?.location).toBe("dock");
      expect(state.panelsById["b"]?.location).toBe("dock");
    });

    it("reconcileDockMembership relocates a docked panel whose kind is no longer dockable", async () => {
      // Simulate a live dockable→non-dockable flip: the panel is already docked
      // (kind was dockable when it landed), then its kind reports non-dockable.
      setTerminals([nonDockable("t1", "dock")]);
      const { reconcileDockMembership } = await import("@/store/reconcileDockMembership");

      reconcileDockMembership();

      expect(usePanelStore.getState().panelsById["t1"]?.location).toBe("grid");
    });

    it("reconcileDockMembership leaves a dockable docked panel in place", async () => {
      setTerminals([createMockTerminal("t1", "dock")]);
      const { reconcileDockMembership } = await import("@/store/reconcileDockMembership");

      reconcileDockMembership();

      expect(usePanelStore.getState().panelsById["t1"]?.location).toBe("dock");
    });
  });
});
