import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRefreshTier } from "@/types";
import type { TerminalInstance } from "../../terminalRegistrySlice";
import type { TabGroup } from "@shared/types/domain";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";

vi.mock("@/clients", () => ({
  terminalClient: {
    resize: vi.fn(),
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

vi.mock("../../../persistence/terminalPersistence", () => ({
  terminalPersistence: {
    save: vi.fn(),
    load: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("../../../persistence/tabGroupPersistence", () => ({
  tabGroupPersistence: {
    save: vi.fn(),
    load: vi.fn().mockReturnValue([]),
  },
}));

const { useTerminalStore } = await import("../../../terminalStore");
const { terminalInstanceService } = await import("@/services/TerminalInstanceService");

function createMockTerminal(
  id: string,
  worktreeId: string | undefined,
  location: "grid" | "dock" | "trash" = "grid"
): TerminalInstance {
  return {
    id,
    type: "terminal",
    title: `Terminal ${id}`,
    cwd: "/test",
    cols: 80,
    rows: 24,
    worktreeId,
    location,
    isVisible: location === "grid",
  };
}

function createMockTabGroup(
  id: string,
  worktreeId: string | undefined,
  panelIds: string[],
  location: "grid" | "dock" = "grid"
): TabGroup {
  return {
    id,
    location,
    worktreeId,
    activeTabId: panelIds[0] ?? "",
    panelIds,
  };
}

describe("Tab Group Worktree Invariant", () => {
  beforeEach(() => {
    useTerminalStore.getState().reset();
    useTerminalStore.setState({
      terminals: [],
      tabGroups: new Map(),
      focusedId: null,
      maximizedId: null,
      commandQueue: [],
    });
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-a", focusedWorktreeId: "wt-a" });
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe("moveTerminalToWorktree with grouped panels", () => {
    it("logs warning when group move fails due to capacity", () => {
      const t1 = createMockTerminal("t1", "wt-a", "grid");
      const t2 = createMockTerminal("t2", "wt-a", "grid");
      const group = createMockTabGroup("g1", "wt-a", ["t1", "t2"], "grid");

      const targetGridTerminals = Array.from({ length: 6 }, (_, i) =>
        createMockTerminal(`target-${i}`, "wt-b", "grid")
      );

      useTerminalStore.setState({
        terminals: [t1, t2, ...targetGridTerminals],
        tabGroups: new Map([["g1", group]]),
      });

      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      useTerminalStore.getState().moveTerminalToWorktree("t1", "wt-b");

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to move group g1 to worktree wt-b")
      );

      const state = useTerminalStore.getState();
      expect(state.tabGroups.get("g1")?.worktreeId).toBe("wt-a");
      expect(state.terminals.find((t) => t.id === "t1")?.worktreeId).toBe("wt-a");

      consoleWarnSpy.mockRestore();
    });

    it("moves entire group when moving a grouped panel", () => {
      const t1 = createMockTerminal("t1", "wt-a", "grid");
      const t2 = createMockTerminal("t2", "wt-a", "grid");
      const t3 = createMockTerminal("t3", "wt-a", "grid");
      const group = createMockTabGroup("g1", "wt-a", ["t1", "t2", "t3"]);

      useTerminalStore.setState({
        terminals: [t1, t2, t3],
        tabGroups: new Map([["g1", group]]),
      });

      useTerminalStore.getState().moveTerminalToWorktree("t1", "wt-b");

      const state = useTerminalStore.getState();
      const updatedGroup = state.tabGroups.get("g1");

      expect(updatedGroup?.worktreeId).toBe("wt-b");

      const movedT1 = state.terminals.find((t) => t.id === "t1");
      const movedT2 = state.terminals.find((t) => t.id === "t2");
      const movedT3 = state.terminals.find((t) => t.id === "t3");

      expect(movedT1?.worktreeId).toBe("wt-b");
      expect(movedT2?.worktreeId).toBe("wt-b");
      expect(movedT3?.worktreeId).toBe("wt-b");
    });

    it("moves ungrouped panel individually", () => {
      const t1 = createMockTerminal("t1", "wt-a", "grid");
      const t2 = createMockTerminal("t2", "wt-a", "grid");
      const t3 = createMockTerminal("t3", "wt-a", "grid");
      const group = createMockTabGroup("g1", "wt-a", ["t2", "t3"]);

      useTerminalStore.setState({
        terminals: [t1, t2, t3],
        tabGroups: new Map([["g1", group]]),
      });

      useTerminalStore.getState().moveTerminalToWorktree("t1", "wt-b");

      const state = useTerminalStore.getState();
      const movedT1 = state.terminals.find((t) => t.id === "t1");
      const movedT2 = state.terminals.find((t) => t.id === "t2");
      const movedT3 = state.terminals.find((t) => t.id === "t3");

      expect(movedT1?.worktreeId).toBe("wt-b");
      expect(movedT2?.worktreeId).toBe("wt-a");
      expect(movedT3?.worktreeId).toBe("wt-a");

      const group1 = state.tabGroups.get("g1");
      expect(group1?.worktreeId).toBe("wt-a");
    });

    it("applies renderer policy to all panels in moved group", () => {
      const t1 = createMockTerminal("t1", "wt-a", "grid");
      const t2 = createMockTerminal("t2", "wt-a", "grid");
      const group = createMockTabGroup("g1", "wt-a", ["t1", "t2"]);

      useTerminalStore.setState({
        terminals: [t1, t2],
        tabGroups: new Map([["g1", group]]),
      });

      useTerminalStore.getState().moveTerminalToWorktree("t1", "wt-b");

      expect(terminalInstanceService.applyRendererPolicy).toHaveBeenCalledWith(
        "t1",
        TerminalRefreshTier.VISIBLE
      );
      expect(terminalInstanceService.applyRendererPolicy).toHaveBeenCalledWith(
        "t2",
        TerminalRefreshTier.VISIBLE
      );
    });
  });

  describe("moveTabGroupToWorktree", () => {
    it("rejects move when target worktree grid is at capacity", () => {
      const t1 = createMockTerminal("t1", "wt-a", "grid");
      const t2 = createMockTerminal("t2", "wt-a", "grid");
      const group = createMockTabGroup("g1", "wt-a", ["t1", "t2"], "grid");

      const targetGridTerminals = Array.from({ length: 6 }, (_, i) =>
        createMockTerminal(`target-${i}`, "wt-b", "grid")
      );

      useTerminalStore.setState({
        terminals: [t1, t2, ...targetGridTerminals],
        tabGroups: new Map([["g1", group]]),
      });

      const result = useTerminalStore.getState().moveTabGroupToWorktree("g1", "wt-b");

      expect(result).toBe(false);

      const state = useTerminalStore.getState();
      const unchangedGroup = state.tabGroups.get("g1");
      expect(unchangedGroup?.worktreeId).toBe("wt-a");

      const unchangedT1 = state.terminals.find((t) => t.id === "t1");
      const unchangedT2 = state.terminals.find((t) => t.id === "t2");
      expect(unchangedT1?.worktreeId).toBe("wt-a");
      expect(unchangedT2?.worktreeId).toBe("wt-a");

      expect(terminalInstanceService.applyRendererPolicy).not.toHaveBeenCalled();
    });

    it("moves entire group and all member panels to new worktree", () => {
      const t1 = createMockTerminal("t1", "wt-a", "grid");
      const t2 = createMockTerminal("t2", "wt-a", "grid");
      const t3 = createMockTerminal("t3", "wt-a", "grid");
      const group = createMockTabGroup("g1", "wt-a", ["t1", "t2", "t3"]);

      useTerminalStore.setState({
        terminals: [t1, t2, t3],
        tabGroups: new Map([["g1", group]]),
      });

      const result = useTerminalStore.getState().moveTabGroupToWorktree("g1", "wt-b");

      expect(result).toBe(true);

      const state = useTerminalStore.getState();
      const updatedGroup = state.tabGroups.get("g1");
      expect(updatedGroup?.worktreeId).toBe("wt-b");

      const updatedT1 = state.terminals.find((t) => t.id === "t1");
      const updatedT2 = state.terminals.find((t) => t.id === "t2");
      const updatedT3 = state.terminals.find((t) => t.id === "t3");

      expect(updatedT1?.worktreeId).toBe("wt-b");
      expect(updatedT2?.worktreeId).toBe("wt-b");
      expect(updatedT3?.worktreeId).toBe("wt-b");
    });

    it("returns true when moving to same worktree", () => {
      const t1 = createMockTerminal("t1", "wt-a", "grid");
      const group = createMockTabGroup("g1", "wt-a", ["t1"]);

      useTerminalStore.setState({
        terminals: [t1],
        tabGroups: new Map([["g1", group]]),
      });

      const result = useTerminalStore.getState().moveTabGroupToWorktree("g1", "wt-a");
      expect(result).toBe(true);
    });

    it("returns false when group not found", () => {
      const result = useTerminalStore.getState().moveTabGroupToWorktree("nonexistent", "wt-b");
      expect(result).toBe(false);
    });

    it("skips trashed panels", () => {
      const t1 = createMockTerminal("t1", "wt-a", "grid");
      const t2 = createMockTerminal("t2", "wt-a", "trash");
      const group = createMockTabGroup("g1", "wt-a", ["t1", "t2"]);

      useTerminalStore.setState({
        terminals: [t1, t2],
        tabGroups: new Map([["g1", group]]),
      });

      useTerminalStore.getState().moveTabGroupToWorktree("g1", "wt-b");

      const state = useTerminalStore.getState();
      const updatedT1 = state.terminals.find((t) => t.id === "t1");
      const updatedT2 = state.terminals.find((t) => t.id === "t2");

      expect(updatedT1?.worktreeId).toBe("wt-b");
      expect(updatedT2?.worktreeId).toBe("wt-a");
      expect(updatedT2?.location).toBe("trash");
    });
  });

  describe("addPanelToGroup - worktree enforcement", () => {
    it("allows adding panel with matching worktreeId", () => {
      const t1 = createMockTerminal("t1", "wt-a", "grid");
      const t2 = createMockTerminal("t2", "wt-a", "grid");
      const group = createMockTabGroup("g1", "wt-a", ["t1"]);

      useTerminalStore.setState({
        terminals: [t1, t2],
        tabGroups: new Map([["g1", group]]),
      });

      useTerminalStore.getState().addPanelToGroup("g1", "t2");

      const updatedGroup = useTerminalStore.getState().tabGroups.get("g1");
      expect(updatedGroup?.panelIds).toEqual(["t1", "t2"]);
    });

    it("rejects adding panel with different worktreeId", () => {
      const t1 = createMockTerminal("t1", "wt-a", "grid");
      const t2 = createMockTerminal("t2", "wt-b", "grid");
      const group = createMockTabGroup("g1", "wt-a", ["t1"]);

      useTerminalStore.setState({
        terminals: [t1, t2],
        tabGroups: new Map([["g1", group]]),
      });

      useTerminalStore.getState().addPanelToGroup("g1", "t2");

      const updatedGroup = useTerminalStore.getState().tabGroups.get("g1");
      expect(updatedGroup?.panelIds).toEqual(["t1"]);
    });

    it("allows adding panel with undefined worktreeId to global group", () => {
      const t1 = createMockTerminal("t1", undefined, "grid");
      const t2 = createMockTerminal("t2", undefined, "grid");
      const group = createMockTabGroup("g1", undefined, ["t1"]);

      useTerminalStore.setState({
        terminals: [t1, t2],
        tabGroups: new Map([["g1", group]]),
      });

      useTerminalStore.getState().addPanelToGroup("g1", "t2");

      const updatedGroup = useTerminalStore.getState().tabGroups.get("g1");
      expect(updatedGroup?.panelIds).toEqual(["t1", "t2"]);
    });

    it("rejects adding global panel to worktree-specific group", () => {
      const t1 = createMockTerminal("t1", "wt-a", "grid");
      const t2 = createMockTerminal("t2", undefined, "grid");
      const group = createMockTabGroup("g1", "wt-a", ["t1"]);

      useTerminalStore.setState({
        terminals: [t1, t2],
        tabGroups: new Map([["g1", group]]),
      });

      useTerminalStore.getState().addPanelToGroup("g1", "t2");

      const updatedGroup = useTerminalStore.getState().tabGroups.get("g1");
      expect(updatedGroup?.panelIds).toEqual(["t1"]);
    });
  });

  describe("global group support", () => {
    it("moves global group to worktree", () => {
      const t1 = createMockTerminal("t1", undefined, "grid");
      const t2 = createMockTerminal("t2", undefined, "grid");
      const group = createMockTabGroup("g1", undefined, ["t1", "t2"]);

      useTerminalStore.setState({
        terminals: [t1, t2],
        tabGroups: new Map([["g1", group]]),
      });

      const result = useTerminalStore.getState().moveTabGroupToWorktree("g1", "wt-a");
      expect(result).toBe(true);

      const state = useTerminalStore.getState();
      const updatedGroup = state.tabGroups.get("g1");
      expect(updatedGroup?.worktreeId).toBe("wt-a");

      const updatedT1 = state.terminals.find((t) => t.id === "t1");
      const updatedT2 = state.terminals.find((t) => t.id === "t2");
      expect(updatedT1?.worktreeId).toBe("wt-a");
      expect(updatedT2?.worktreeId).toBe("wt-a");
    });

    it("moves worktree group to global (undefined)", () => {
      const t1 = createMockTerminal("t1", "wt-a", "grid");
      const t2 = createMockTerminal("t2", "wt-a", "grid");
      const group = createMockTabGroup("g1", "wt-a", ["t1", "t2"]);

      useTerminalStore.setState({
        terminals: [t1, t2],
        tabGroups: new Map([["g1", group]]),
      });

      const result = useTerminalStore.getState().moveTabGroupToWorktree("g1", undefined as any);
      expect(result).toBe(true);

      const state = useTerminalStore.getState();
      const updatedGroup = state.tabGroups.get("g1");
      expect(updatedGroup?.worktreeId).toBe(undefined);

      const updatedT1 = state.terminals.find((t) => t.id === "t1");
      const updatedT2 = state.terminals.find((t) => t.id === "t2");
      expect(updatedT1?.worktreeId).toBe(undefined);
      expect(updatedT2?.worktreeId).toBe(undefined);
    });

    it("rejects adding worktree panel to global group", () => {
      const t1 = createMockTerminal("t1", undefined, "grid");
      const t2 = createMockTerminal("t2", "wt-a", "grid");
      const group = createMockTabGroup("g1", undefined, ["t1"]);

      useTerminalStore.setState({
        terminals: [t1, t2],
        tabGroups: new Map([["g1", group]]),
      });

      useTerminalStore.getState().addPanelToGroup("g1", "t2");

      const updatedGroup = useTerminalStore.getState().tabGroups.get("g1");
      expect(updatedGroup?.panelIds).toEqual(["t1"]);
    });
  });

  describe("hydrateTabGroups - worktree repair", () => {
    it("repairs worktree mismatch using majority worktreeId", () => {
      const t1 = createMockTerminal("t1", "wt-a", "grid");
      const t2 = createMockTerminal("t2", "wt-a", "grid");
      const t3 = createMockTerminal("t3", "wt-b", "grid");
      const group = createMockTabGroup("g1", "wt-b", ["t1", "t2", "t3"]);

      useTerminalStore.setState({
        terminals: [t1, t2, t3],
      });

      useTerminalStore.getState().hydrateTabGroups([group]);

      const state = useTerminalStore.getState();
      const repairedGroup = state.tabGroups.get("g1");

      expect(repairedGroup?.worktreeId).toBe("wt-a");

      const repairedT1 = state.terminals.find((t) => t.id === "t1");
      const repairedT2 = state.terminals.find((t) => t.id === "t2");
      const repairedT3 = state.terminals.find((t) => t.id === "t3");

      expect(repairedT1?.worktreeId).toBe("wt-a");
      expect(repairedT2?.worktreeId).toBe("wt-a");
      expect(repairedT3?.worktreeId).toBe("wt-a");
    });

    it("normalizes panel worktreeId to match group", () => {
      const t1 = createMockTerminal("t1", "wt-a", "grid");
      const t2 = createMockTerminal("t2", "wt-b", "grid");
      const group = createMockTabGroup("g1", "wt-a", ["t1", "t2"]);

      useTerminalStore.setState({
        terminals: [t1, t2],
      });

      useTerminalStore.getState().hydrateTabGroups([group]);

      const state = useTerminalStore.getState();
      const repairedT2 = state.terminals.find((t) => t.id === "t2");

      expect(repairedT2?.worktreeId).toBe("wt-a");
    });

    it("does not modify panels already matching group worktreeId", () => {
      const t1 = createMockTerminal("t1", "wt-a", "grid");
      const t2 = createMockTerminal("t2", "wt-a", "grid");
      const group = createMockTabGroup("g1", "wt-a", ["t1", "t2"]);

      useTerminalStore.setState({
        terminals: [t1, t2],
      });

      useTerminalStore.getState().hydrateTabGroups([group]);

      const state = useTerminalStore.getState();
      const repairedT1 = state.terminals.find((t) => t.id === "t1");
      const repairedT2 = state.terminals.find((t) => t.id === "t2");

      expect(repairedT1?.worktreeId).toBe("wt-a");
      expect(repairedT2?.worktreeId).toBe("wt-a");
    });

    it("skips trashed panels during worktree repair", () => {
      const t1 = createMockTerminal("t1", "wt-a", "grid");
      const t2 = createMockTerminal("t2", "wt-b", "trash");
      const group = createMockTabGroup("g1", "wt-a", ["t1", "t2"]);

      useTerminalStore.setState({
        terminals: [t1, t2],
      });

      useTerminalStore.getState().hydrateTabGroups([group]);

      const state = useTerminalStore.getState();
      const repairedGroup = state.tabGroups.get("g1");

      expect(repairedGroup?.panelIds).toEqual(["t1"]);

      const repairedT2 = state.terminals.find((t) => t.id === "t2");
      expect(repairedT2?.worktreeId).toBe("wt-b");
      expect(repairedT2?.location).toBe("trash");
    });
  });
});
