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
    type: "terminal",
    title: `Terminal ${id}`,
    cwd: "/test",
    cols: 80,
    rows: 24,
    worktreeId: "wt-1",
    location,
    isVisible: location === "grid",
  };
}

function createMockTabGroup(
  id: string,
  panelIds: string[],
  location: "grid" | "dock" = "grid"
): TabGroup {
  return {
    id,
    panelIds,
    activeTabId: panelIds[0],
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
      expect(updated.location).toBe("dock");
      expect(updated.isVisible).toBe(false);
      expect(updated.runtimeStatus).toBe("background");
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
      expect(updated.location).toBe("grid");
      expect(updated.isVisible).toBe(true);
    });

    it("is idempotent — calling twice on an already-grid panel returns false", () => {
      const t = createMockTerminal("t1", "grid");
      setTerminals([t]);

      const moved = usePanelStore.getState().moveTerminalToGrid("t1");
      expect(moved).toBe(false);
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
      expect(updated.location).toBe("dock");
      expect(updated.isVisible).toBe(false);
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
      expect(updated.location).toBe("grid");
      expect(updated.isVisible).toBe(true);
    });

    it("allows group to move terminal to dock (both agree on dock)", () => {
      const t1 = createMockTerminal("t1", "grid");
      const t2 = createMockTerminal("t2", "grid");
      setTerminals([t1, t2]);

      const group = createMockTabGroup("g1", ["t1", "t2"], "dock");
      usePanelStore.setState({ tabGroups: new Map([["g1", group]]) });

      usePanelStore.getState().hydrateTabGroups([group]);

      const updated = usePanelStore.getState().panelsById["t1"];
      expect(updated.location).toBe("dock");
      expect(updated.isVisible).toBe(false);
    });
  });
});
