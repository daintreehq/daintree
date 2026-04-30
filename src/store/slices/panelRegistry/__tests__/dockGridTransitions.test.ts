import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalInstance } from "../../panelRegistrySlice";
import type { TabGroup } from "@shared/types/panel";

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

function setTerminals(terminals: TerminalInstance[]) {
  usePanelStore.setState({
    panelsById: Object.fromEntries(terminals.map((t) => [t.id, t])),
    panelIds: terminals.map((t) => t.id),
  });
}

function createMockTerminal(
  id: string,
  location: "grid" | "dock" | "trash" = "grid"
): TerminalInstance {
  return {
    id,
    title: `Terminal ${id}`,
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
): TerminalInstance {
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
      tabGroups: new Map(),
      trashedTerminals: new Map(),
    });
  });

  describe("moveTerminalToDock visibility parity", () => {
    it("sets isVisible=false and derives runtimeStatus for a single ungrouped panel", () => {
      const t = createMockTerminal("t1", "grid");
      t.isVisible = true;
      t.runtimeStatus = "running";
      setTerminals([t]);

      usePanelStore.getState().moveTerminalToDock("t1");

      const updated = usePanelStore.getState().panelsById["t1"];
      expect(updated!.location).toBe("dock");
      expect(updated!.isVisible).toBe(false);
      expect(updated!.runtimeStatus).toBe("background");
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

      const updated = usePanelStore.getState().panelsById["t1"];
      expect(updated!.location).toBe("grid");
      expect(updated!.isVisible).toBe(true);
      expect(updated!.runtimeStatus).toBe("running");
      expect(usePanelStore.getState().getTabGroups("dock", "wt-1")).toHaveLength(0);
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
});
