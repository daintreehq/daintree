import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRefreshTier } from "@/types";
import type { PtyPanelData, TabGroup } from "@shared/types/panel";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { setWorktreeSelectionAccessor } from "@/store/storeAccessors";
import { NO_WORKTREE } from "../worktreeIndex";

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
const { terminalInstanceService } = await import("@/services/TerminalInstanceService");

function setTerminals(terminals: PtyPanelData[]) {
  usePanelStore.setState({
    panelsById: Object.fromEntries(terminals.map((t) => [t.id, t])),
    panelIds: terminals.map((t) => t.id),
  });
}

function createMockTerminal(
  id: string,
  worktreeId: string | undefined,
  location: "grid" | "dock" | "trash" = "grid"
): PtyPanelData {
  return {
    id,
    title: `Terminal ${id}`,
    kind: "terminal" as const,
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
    usePanelStore.getState().reset();
    usePanelStore.setState({
      panelsById: {},
      panelIds: [],
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
    it("moves the group even when target worktree already has many grid panels", () => {
      // Scrollable grid (#8805): cross-worktree group moves no longer fail on
      // capacity grounds — the destination grid scrolls.
      const t1 = createMockTerminal("t1", "wt-a", "grid");
      const t2 = createMockTerminal("t2", "wt-a", "grid");
      const group = createMockTabGroup("g1", "wt-a", ["t1", "t2"], "grid");

      const targetGridTerminals = Array.from({ length: 10 }, (_, i) =>
        createMockTerminal(`target-${i}`, "wt-b", "grid")
      );

      setTerminals([t1, t2, ...targetGridTerminals]);
      usePanelStore.setState({ tabGroups: new Map([["g1", group]]) });

      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      usePanelStore.getState().moveTerminalToWorktree("t1", "wt-b");

      // No capacity-warning should fire any more.
      expect(consoleWarnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("[TabGroup] Failed to move group to worktree"),
        expect.anything()
      );

      const state = usePanelStore.getState();
      expect(state.tabGroups.get("g1")?.worktreeId).toBe("wt-b");
      expect(state.panelsById["t1"]?.worktreeId).toBe("wt-b");
      expect(state.panelsById["t2"]?.worktreeId).toBe("wt-b");

      consoleWarnSpy.mockRestore();
    });

    it("moves entire group when moving a grouped panel", () => {
      const t1 = createMockTerminal("t1", "wt-a", "grid");
      const t2 = createMockTerminal("t2", "wt-a", "grid");
      const t3 = createMockTerminal("t3", "wt-a", "grid");
      const group = createMockTabGroup("g1", "wt-a", ["t1", "t2", "t3"]);

      setTerminals([t1, t2, t3]);
      usePanelStore.setState({ tabGroups: new Map([["g1", group]]) });

      usePanelStore.getState().moveTerminalToWorktree("t1", "wt-b");

      const state = usePanelStore.getState();
      const updatedGroup = state.tabGroups.get("g1");

      expect(updatedGroup?.worktreeId).toBe("wt-b");

      expect(state.panelsById["t1"]?.worktreeId).toBe("wt-b");
      expect(state.panelsById["t2"]?.worktreeId).toBe("wt-b");
      expect(state.panelsById["t3"]?.worktreeId).toBe("wt-b");
    });

    it("moves ungrouped panel individually", () => {
      const t1 = createMockTerminal("t1", "wt-a", "grid");
      const t2 = createMockTerminal("t2", "wt-a", "grid");
      const t3 = createMockTerminal("t3", "wt-a", "grid");
      const group = createMockTabGroup("g1", "wt-a", ["t2", "t3"]);

      setTerminals([t1, t2, t3]);
      usePanelStore.setState({ tabGroups: new Map([["g1", group]]) });

      usePanelStore.getState().moveTerminalToWorktree("t1", "wt-b");

      const state = usePanelStore.getState();

      expect(state.panelsById["t1"]?.worktreeId).toBe("wt-b");
      expect(state.panelsById["t2"]?.worktreeId).toBe("wt-a");
      expect(state.panelsById["t3"]?.worktreeId).toBe("wt-a");

      const group1 = state.tabGroups.get("g1");
      expect(group1?.worktreeId).toBe("wt-a");
    });

    it("applies renderer policy to all panels in moved group", () => {
      const t1 = createMockTerminal("t1", "wt-a", "grid");
      const t2 = createMockTerminal("t2", "wt-a", "grid");
      const group = createMockTabGroup("g1", "wt-a", ["t1", "t2"]);

      setTerminals([t1, t2]);
      usePanelStore.setState({ tabGroups: new Map([["g1", group]]) });

      usePanelStore.getState().moveTerminalToWorktree("t1", "wt-b");

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
    it("moves the group even when target worktree grid already has many panels", () => {
      // Scrollable grid (#8805): the legacy "fail when full" path is gone;
      // the destination scrolls vertically to absorb the moved group.
      const t1 = createMockTerminal("t1", "wt-a", "grid");
      const t2 = createMockTerminal("t2", "wt-a", "grid");
      const group = createMockTabGroup("g1", "wt-a", ["t1", "t2"], "grid");

      const targetGridTerminals = Array.from({ length: 10 }, (_, i) =>
        createMockTerminal(`target-${i}`, "wt-b", "grid")
      );

      setTerminals([t1, t2, ...targetGridTerminals]);
      usePanelStore.setState({ tabGroups: new Map([["g1", group]]) });

      const result = usePanelStore.getState().moveTabGroupToWorktree("g1", "wt-b");

      expect(result).toBe(true);

      const state = usePanelStore.getState();
      expect(state.tabGroups.get("g1")?.worktreeId).toBe("wt-b");
      expect(state.panelsById["t1"]?.worktreeId).toBe("wt-b");
      expect(state.panelsById["t2"]?.worktreeId).toBe("wt-b");

      expect(terminalInstanceService.applyRendererPolicy).toHaveBeenCalledWith(
        "t1",
        TerminalRefreshTier.VISIBLE
      );
    });

    it("moves entire group and all member panels to new worktree", () => {
      const t1 = createMockTerminal("t1", "wt-a", "grid");
      const t2 = createMockTerminal("t2", "wt-a", "grid");
      const t3 = createMockTerminal("t3", "wt-a", "grid");
      const group = createMockTabGroup("g1", "wt-a", ["t1", "t2", "t3"]);

      setTerminals([t1, t2, t3]);
      usePanelStore.setState({ tabGroups: new Map([["g1", group]]) });

      const result = usePanelStore.getState().moveTabGroupToWorktree("g1", "wt-b");

      expect(result).toBe(true);

      const state = usePanelStore.getState();
      const updatedGroup = state.tabGroups.get("g1");
      expect(updatedGroup?.worktreeId).toBe("wt-b");

      const updatedT1 = state.panelsById["t1"];
      const updatedT2 = state.panelsById["t2"];
      const updatedT3 = state.panelsById["t3"];

      expect(updatedT1?.worktreeId).toBe("wt-b");
      expect(updatedT2?.worktreeId).toBe("wt-b");
      expect(updatedT3?.worktreeId).toBe("wt-b");
    });

    it("returns true when moving to same worktree", () => {
      const t1 = createMockTerminal("t1", "wt-a", "grid");
      const group = createMockTabGroup("g1", "wt-a", ["t1"]);

      setTerminals([t1]);
      usePanelStore.setState({ tabGroups: new Map([["g1", group]]) });

      const result = usePanelStore.getState().moveTabGroupToWorktree("g1", "wt-a");
      expect(result).toBe(true);
    });

    it("returns false when group not found", () => {
      const result = usePanelStore.getState().moveTabGroupToWorktree("nonexistent", "wt-b");
      expect(result).toBe(false);
    });

    it("skips trashed panels", () => {
      const t1 = createMockTerminal("t1", "wt-a", "grid");
      const t2 = createMockTerminal("t2", "wt-a", "trash");
      const group = createMockTabGroup("g1", "wt-a", ["t1", "t2"]);

      setTerminals([t1, t2]);
      usePanelStore.setState({ tabGroups: new Map([["g1", group]]) });

      usePanelStore.getState().moveTabGroupToWorktree("g1", "wt-b");

      const state = usePanelStore.getState();
      const updatedT1 = state.panelsById["t1"];
      const updatedT2 = state.panelsById["t2"];

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

      setTerminals([t1, t2]);
      usePanelStore.setState({ tabGroups: new Map([["g1", group]]) });

      const result = usePanelStore.getState().addPanelToGroup("g1", "t2");
      expect(result).toBe(true);

      const updatedGroup = usePanelStore.getState().tabGroups.get("g1");
      expect(updatedGroup?.panelIds).toEqual(["t1", "t2"]);
    });

    it("rejects adding panel with different worktreeId", () => {
      const t1 = createMockTerminal("t1", "wt-a", "grid");
      const t2 = createMockTerminal("t2", "wt-b", "grid");
      const group = createMockTabGroup("g1", "wt-a", ["t1"]);

      setTerminals([t1, t2]);
      usePanelStore.setState({ tabGroups: new Map([["g1", group]]) });

      const result = usePanelStore.getState().addPanelToGroup("g1", "t2");
      expect(result).toBe(false);

      const updatedGroup = usePanelStore.getState().tabGroups.get("g1");
      expect(updatedGroup?.panelIds).toEqual(["t1"]);
    });

    it("allows adding panel with undefined worktreeId to global group", () => {
      const t1 = createMockTerminal("t1", undefined, "grid");
      const t2 = createMockTerminal("t2", undefined, "grid");
      const group = createMockTabGroup("g1", undefined, ["t1"]);

      setTerminals([t1, t2]);
      usePanelStore.setState({ tabGroups: new Map([["g1", group]]) });

      const result = usePanelStore.getState().addPanelToGroup("g1", "t2");
      expect(result).toBe(true);

      const updatedGroup = usePanelStore.getState().tabGroups.get("g1");
      expect(updatedGroup?.panelIds).toEqual(["t1", "t2"]);
    });

    it("rejects adding global panel to worktree-specific group", () => {
      const t1 = createMockTerminal("t1", "wt-a", "grid");
      const t2 = createMockTerminal("t2", undefined, "grid");
      const group = createMockTabGroup("g1", "wt-a", ["t1"]);

      setTerminals([t1, t2]);
      usePanelStore.setState({ tabGroups: new Map([["g1", group]]) });

      const result = usePanelStore.getState().addPanelToGroup("g1", "t2");
      expect(result).toBe(false);

      const updatedGroup = usePanelStore.getState().tabGroups.get("g1");
      expect(updatedGroup?.panelIds).toEqual(["t1"]);
    });

    it("returns false when the target group does not exist", () => {
      const t1 = createMockTerminal("t1", "wt-a", "grid");
      setTerminals([t1]);
      usePanelStore.setState({ tabGroups: new Map() });

      const result = usePanelStore.getState().addPanelToGroup("missing-group", "t1");
      expect(result).toBe(false);
    });

    it("returns false when the panel does not exist", () => {
      const t1 = createMockTerminal("t1", "wt-a", "grid");
      const group = createMockTabGroup("g1", "wt-a", ["t1"]);

      setTerminals([t1]);
      usePanelStore.setState({ tabGroups: new Map([["g1", group]]) });

      const result = usePanelStore.getState().addPanelToGroup("g1", "missing-panel");
      expect(result).toBe(false);

      const updatedGroup = usePanelStore.getState().tabGroups.get("g1");
      expect(updatedGroup?.panelIds).toEqual(["t1"]);
    });

    it("returns true when the panel is already a member (idempotent)", () => {
      const t1 = createMockTerminal("t1", "wt-a", "grid");
      const group = createMockTabGroup("g1", "wt-a", ["t1"]);

      setTerminals([t1]);
      usePanelStore.setState({ tabGroups: new Map([["g1", group]]) });

      const result = usePanelStore.getState().addPanelToGroup("g1", "t1");
      expect(result).toBe(true);

      const updatedGroup = usePanelStore.getState().tabGroups.get("g1");
      expect(updatedGroup?.panelIds).toEqual(["t1"]);
    });

    it("returns true and collapses the source group when moving the panel out of it", () => {
      // Unique-membership enforcement removes the panel from its prior group
      // first; when that leaves <=1 member the source group is deleted. The
      // post-mutation verify must still report success for the target group.
      const anchor = createMockTerminal("anchor", "wt-a", "grid");
      const mover = createMockTerminal("mover", "wt-a", "grid");
      const target = createMockTabGroup("g-target", "wt-a", ["anchor"]);
      const source = createMockTabGroup("g-source", "wt-a", ["mover", "anchor2"]);

      setTerminals([anchor, mover, createMockTerminal("anchor2", "wt-a", "grid")]);
      usePanelStore.setState({
        tabGroups: new Map([
          ["g-target", target],
          ["g-source", source],
        ]),
      });

      const result = usePanelStore.getState().addPanelToGroup("g-target", "mover");
      expect(result).toBe(true);

      const groups = usePanelStore.getState().tabGroups;
      expect(groups.get("g-target")?.panelIds).toEqual(["anchor", "mover"]);
      expect(groups.has("g-source")).toBe(false);
    });
  });

  describe("global group support", () => {
    it("moves global group to worktree", () => {
      const t1 = createMockTerminal("t1", undefined, "grid");
      const t2 = createMockTerminal("t2", undefined, "grid");
      const group = createMockTabGroup("g1", undefined, ["t1", "t2"]);

      setTerminals([t1, t2]);
      usePanelStore.setState({ tabGroups: new Map([["g1", group]]) });

      const result = usePanelStore.getState().moveTabGroupToWorktree("g1", "wt-a");
      expect(result).toBe(true);

      const state = usePanelStore.getState();
      const updatedGroup = state.tabGroups.get("g1");
      expect(updatedGroup?.worktreeId).toBe("wt-a");

      const updatedT1 = state.panelsById["t1"];
      const updatedT2 = state.panelsById["t2"];
      expect(updatedT1?.worktreeId).toBe("wt-a");
      expect(updatedT2?.worktreeId).toBe("wt-a");
    });

    it("moves worktree group to global (undefined)", () => {
      const t1 = createMockTerminal("t1", "wt-a", "grid");
      const t2 = createMockTerminal("t2", "wt-a", "grid");
      const group = createMockTabGroup("g1", "wt-a", ["t1", "t2"]);

      setTerminals([t1, t2]);
      usePanelStore.setState({ tabGroups: new Map([["g1", group]]) });

      const result = usePanelStore
        .getState()
        .moveTabGroupToWorktree("g1", undefined as unknown as string);
      expect(result).toBe(true);

      const state = usePanelStore.getState();
      const updatedGroup = state.tabGroups.get("g1");
      expect(updatedGroup?.worktreeId).toBe(undefined);

      const updatedT1 = state.panelsById["t1"];
      const updatedT2 = state.panelsById["t2"];
      expect(updatedT1?.worktreeId).toBe(undefined);
      expect(updatedT2?.worktreeId).toBe(undefined);
    });

    it("rejects adding worktree panel to global group", () => {
      const t1 = createMockTerminal("t1", undefined, "grid");
      const t2 = createMockTerminal("t2", "wt-a", "grid");
      const group = createMockTabGroup("g1", undefined, ["t1"]);

      setTerminals([t1, t2]);
      usePanelStore.setState({ tabGroups: new Map([["g1", group]]) });

      const result = usePanelStore.getState().addPanelToGroup("g1", "t2");
      expect(result).toBe(false);

      const updatedGroup = usePanelStore.getState().tabGroups.get("g1");
      expect(updatedGroup?.panelIds).toEqual(["t1"]);
    });
  });

  describe("hydrateTabGroups - worktree repair", () => {
    it("repairs worktree mismatch using majority worktreeId", () => {
      const t1 = createMockTerminal("t1", "wt-a", "grid");
      const t2 = createMockTerminal("t2", "wt-a", "grid");
      const t3 = createMockTerminal("t3", "wt-b", "grid");
      const group = createMockTabGroup("g1", "wt-b", ["t1", "t2", "t3"]);

      setTerminals([t1, t2, t3]);

      usePanelStore.getState().hydrateTabGroups([group]);

      const state = usePanelStore.getState();
      const repairedGroup = state.tabGroups.get("g1");

      expect(repairedGroup?.worktreeId).toBe("wt-a");

      const repairedT1 = state.panelsById["t1"];
      const repairedT2 = state.panelsById["t2"];
      const repairedT3 = state.panelsById["t3"];

      expect(repairedT1?.worktreeId).toBe("wt-a");
      expect(repairedT2?.worktreeId).toBe("wt-a");
      expect(repairedT3?.worktreeId).toBe("wt-a");
    });

    it("normalizes panel worktreeId to match group", () => {
      const t1 = createMockTerminal("t1", "wt-a", "grid");
      const t2 = createMockTerminal("t2", "wt-b", "grid");
      const group = createMockTabGroup("g1", "wt-a", ["t1", "t2"]);

      setTerminals([t1, t2]);

      usePanelStore.getState().hydrateTabGroups([group]);

      const state = usePanelStore.getState();
      const repairedT2 = state.panelsById["t2"];

      expect(repairedT2?.worktreeId).toBe("wt-a");
    });

    it("does not modify panels already matching group worktreeId", () => {
      const t1 = createMockTerminal("t1", "wt-a", "grid");
      const t2 = createMockTerminal("t2", "wt-a", "grid");
      const group = createMockTabGroup("g1", "wt-a", ["t1", "t2"]);

      setTerminals([t1, t2]);

      usePanelStore.getState().hydrateTabGroups([group]);

      const state = usePanelStore.getState();
      const repairedT1 = state.panelsById["t1"];
      const repairedT2 = state.panelsById["t2"];

      expect(repairedT1?.worktreeId).toBe("wt-a");
      expect(repairedT2?.worktreeId).toBe("wt-a");
    });

    it("skips trashed panels during worktree repair", () => {
      const t1 = createMockTerminal("t1", "wt-a", "grid");
      const t2 = createMockTerminal("t2", "wt-b", "trash");
      const group = createMockTabGroup("g1", "wt-a", ["t1", "t2"]);

      setTerminals([t1, t2]);

      usePanelStore.getState().hydrateTabGroups([group]);

      const state = usePanelStore.getState();
      const repairedGroup = state.tabGroups.get("g1");

      // Group should be dropped because it only has 1 non-trashed panel remaining
      expect(repairedGroup).toBeUndefined();

      const repairedT2 = state.panelsById["t2"];
      expect(repairedT2?.worktreeId).toBe("wt-b");
      expect(repairedT2?.location).toBe("trash");
    });
  });

  describe("hydrateTabGroups - skipPersist option", () => {
    it("respects skipPersist option with empty groups (error recovery path)", async () => {
      const { panelPersistence } = await import("../../../persistence/panelPersistence");

      const t1 = createMockTerminal("t1", "wt-a", "grid");
      const t2 = createMockTerminal("t2", "wt-a", "grid");

      setTerminals([t1, t2]);
      usePanelStore.setState({ tabGroups: new Map() });

      // Error recovery path: clear in-memory groups without wiping persistence
      usePanelStore.getState().hydrateTabGroups([], { skipPersist: true });

      expect(panelPersistence.saveTabGroups).not.toHaveBeenCalled();
      // Verify in-memory state was still cleared
      expect(usePanelStore.getState().tabGroups.size).toBe(0);
    });

    it("respects skipPersist option with non-empty groups", async () => {
      const { panelPersistence } = await import("../../../persistence/panelPersistence");

      const t1 = createMockTerminal("t1", "wt-a", "grid");
      const t2 = createMockTerminal("t2", "wt-a", "grid");
      const group = createMockTabGroup("g1", "wt-a", ["t1", "t2"]);

      setTerminals([t1, t2]);
      usePanelStore.setState({ tabGroups: new Map() });

      // Hydrate groups but skip persistence
      usePanelStore.getState().hydrateTabGroups([group], { skipPersist: true });

      expect(panelPersistence.saveTabGroups).not.toHaveBeenCalled();
      // Verify in-memory state was updated despite skipPersist
      expect(usePanelStore.getState().tabGroups.size).toBe(1);
      expect(usePanelStore.getState().tabGroups.has("g1")).toBe(true);
    });

    it("persists tab groups when skipPersist is not set", async () => {
      const { panelPersistence } = await import("../../../persistence/panelPersistence");

      const t1 = createMockTerminal("t1", "wt-a", "grid");
      const t2 = createMockTerminal("t2", "wt-a", "grid");
      const group = createMockTabGroup("g1", "wt-a", ["t1", "t2"]);

      setTerminals([t1, t2]);
      usePanelStore.setState({ tabGroups: new Map() });

      // Normal hydration should persist
      usePanelStore.getState().hydrateTabGroups([group]);

      expect(panelPersistence.saveTabGroups).toHaveBeenCalledTimes(1);
      // Verify the persisted data contains the expected group
      const persistedGroups = vi.mocked(panelPersistence.saveTabGroups).mock.calls[0]![0];
      expect(persistedGroups.has("g1")).toBe(true);
    });
  });

  // Regression for #9649: a recipe-launched panel spawns inside a
  // beginSpawnBatch/flushSpawnBatch window where the worktree index
  // (panelIdsByWorktreeId) is committed eagerly but panelIds only appends at
  // flush. getTabGroups must surface the batched panel from the index so the
  // grid paints on first mount instead of staying blank until a worktree
  // switch forces a re-derive.
  describe("getTabGroups pre-flush batch visibility (#9649)", () => {
    // Simulate Commit #1 of a spawn batch: panelsById + the worktree index hold
    // the new panel, but panelIds does NOT yet contain it (deferred to flush).
    function commitOnePanelToIndexOnly(panel: PtyPanelData, committedIds: string[] = []) {
      const byId: Record<string, PtyPanelData> = { [panel.id]: panel };
      const index: Record<string, string[]> = {};
      const bucket = panel.worktreeId ?? NO_WORKTREE;
      index[bucket] = [...committedIds, panel.id];
      usePanelStore.setState({
        panelsById: byId,
        panelIds: committedIds,
        panelIdsByWorktreeId: index,
        tabGroups: new Map(),
      });
    }

    it("returns a virtual grid group for a batched panel before panelIds flush", () => {
      const recipePanel = createMockTerminal("recipe-1", "wt-a", "grid");
      commitOnePanelToIndexOnly(recipePanel);

      const state = usePanelStore.getState();
      // Precondition: panelIds is still stale (deferred), index already has it.
      expect(state.panelIds).not.toContain("recipe-1");
      expect(state.panelIdsByWorktreeId["wt-a"]).toContain("recipe-1");

      const groups = state.getTabGroups("grid", "wt-a");
      expect(groups).toEqual([
        {
          id: "recipe-1",
          location: "grid",
          worktreeId: "wt-a",
          activeTabId: "recipe-1",
          panelIds: ["recipe-1"],
        },
      ]);
    });

    it("includes a global dock panel in a worktree-scoped dock query before flush", () => {
      const dockPanel = createMockTerminal("dock-1", undefined, "dock");
      commitOnePanelToIndexOnly(dockPanel);

      const state = usePanelStore.getState();
      expect(state.panelIds).not.toContain("dock-1");
      expect(state.panelIdsByWorktreeId[NO_WORKTREE]).toContain("dock-1");

      // Dock-global rule: a panel with worktreeId === undefined must still
      // appear in a dock query scoped to a concrete worktree.
      const groups = state.getTabGroups("dock", "wt-a");
      const allIds = groups.flatMap((g) => g.panelIds);
      expect(allIds).toContain("dock-1");
    });

    it("keeps a batched panel out of a different worktree's grid", () => {
      const recipePanel = createMockTerminal("recipe-1", "wt-a", "grid");
      commitOnePanelToIndexOnly(recipePanel);

      const groups = usePanelStore.getState().getTabGroups("grid", "wt-b");
      const allIds = groups.flatMap((g) => g.panelIds);
      expect(allIds).not.toContain("recipe-1");
    });

    it("keeps a global pending panel out of a concrete worktree's grid", () => {
      // The NO_WORKTREE bucket is scanned for grid queries too, but the in-loop
      // panelMatchesWorktreeScope filter must still keep global panels out of a
      // worktree-scoped grid (only dock queries surface them).
      const globalPanel = createMockTerminal("global-1", undefined, "grid");
      commitOnePanelToIndexOnly(globalPanel);

      const state = usePanelStore.getState();
      expect(state.panelIdsByWorktreeId[NO_WORKTREE]).toContain("global-1");

      const groups = state.getTabGroups("grid", "wt-a");
      const allIds = groups.flatMap((g) => g.panelIds);
      expect(allIds).not.toContain("global-1");
    });

    it("preserves committed panelIds ordering and appends batched panels last", () => {
      const committed = createMockTerminal("committed-1", "wt-a", "grid");
      const batched = createMockTerminal("batched-2", "wt-a", "grid");
      usePanelStore.setState({
        panelsById: { "committed-1": committed, "batched-2": batched },
        panelIds: ["committed-1"],
        panelIdsByWorktreeId: { "wt-a": ["committed-1", "batched-2"] },
        tabGroups: new Map(),
      });

      const groups = usePanelStore.getState().getTabGroups("grid", "wt-a");
      const orderedIds = groups.flatMap((g) => g.panelIds);
      expect(orderedIds).toEqual(["committed-1", "batched-2"]);
    });

    it("does not duplicate a panel once it lands in both panelIds and the index after flush", () => {
      const panel = createMockTerminal("recipe-1", "wt-a", "grid");
      // Post-flush state: the id is now in BOTH panelIds and the index bucket.
      usePanelStore.setState({
        panelsById: { "recipe-1": panel },
        panelIds: ["recipe-1"],
        panelIdsByWorktreeId: { "wt-a": ["recipe-1"] },
        tabGroups: new Map(),
      });

      const groups = usePanelStore.getState().getTabGroups("grid", "wt-a");
      const allIds = groups.flatMap((g) => g.panelIds);
      expect(allIds).toEqual(["recipe-1"]);
    });
  });
});

describe("hydrateTabGroups — repair never elects a deleted worktree (#11911)", () => {
  // Restoring a group whose worktree was deleted can now split: PTYs that
  // survived keep the deleted id, while any whose process died cold-respawn
  // onto a live worktree. The repair rewrites EVERY member to one worktree, so
  // electing the deleted one would move a freshly spawned agent onto a row the
  // cleanup sweep trashes.
  beforeEach(() => {
    usePanelStore.getState().reset();
    usePanelStore.setState({
      panelsById: {},
      panelIds: [],
      tabGroups: new Map(),
      focusedId: null,
      maximizedId: null,
      commandQueue: [],
    });
    setWorktreeSelectionAccessor(() => ({
      activeWorktreeId: "wt-live",
      restoreWorktreeId: null,
      deletedWorktreeIds: new Set(["wt-dead"]),
    }));
  });

  afterEach(() => {
    setWorktreeSelectionAccessor(() => ({
      activeWorktreeId: null,
      restoreWorktreeId: null,
    }));
  });

  it("splits survivors out of a mixed group instead of reparenting either side", () => {
    const survivorA = createMockTerminal("t1", "wt-dead", "grid");
    const survivorB = createMockTerminal("t2", "wt-dead", "grid");
    const respawned = createMockTerminal("t3", "wt-live", "grid");
    const alsoLive = createMockTerminal("t4", "wt-live", "grid");
    setTerminals([survivorA, survivorB, respawned, alsoLive]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    usePanelStore
      .getState()
      .hydrateTabGroups([createMockTabGroup("g1", "wt-dead", ["t1", "t2", "t3", "t4"])]);

    const state = usePanelStore.getState();
    // Neither side is relabelled. Electing the deleted worktree would hand the
    // freshly respawned panels to the sweep; electing the live one would
    // relabel real survivors, empty their row and exempt them from the
    // cleanup that is supposed to retire them.
    expect(state.panelsById["t1"]?.worktreeId).toBe("wt-dead");
    expect(state.panelsById["t2"]?.worktreeId).toBe("wt-dead");
    expect(state.panelsById["t3"]?.worktreeId).toBe("wt-live");
    expect(state.panelsById["t4"]?.worktreeId).toBe("wt-live");
    // The group keeps only the coherent live half.
    const group = state.tabGroups.get("g1");
    expect(group?.worktreeId).toBe("wt-live");
    expect(group?.panelIds.sort()).toEqual(["t3", "t4"]);
    warn.mockRestore();
  });

  it("dissolves the group when the split leaves it with one member", () => {
    const survivorA = createMockTerminal("t1", "wt-dead", "grid");
    const survivorB = createMockTerminal("t2", "wt-dead", "grid");
    const respawned = createMockTerminal("t3", "wt-live", "grid");
    setTerminals([survivorA, survivorB, respawned]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    usePanelStore
      .getState()
      .hydrateTabGroups([createMockTabGroup("g1", "wt-dead", ["t1", "t2", "t3"])]);

    const state = usePanelStore.getState();
    expect(state.tabGroups.has("g1")).toBe(false);
    // Every panel still keeps the worktree it restored onto.
    expect(state.panelsById["t1"]?.worktreeId).toBe("wt-dead");
    expect(state.panelsById["t2"]?.worktreeId).toBe("wt-dead");
    expect(state.panelsById["t3"]?.worktreeId).toBe("wt-live");
    warn.mockRestore();
  });

  it("leaves an all-survivor group on its deleted worktree", () => {
    const survivorA = createMockTerminal("t1", "wt-dead", "grid");
    const survivorB = createMockTerminal("t2", "wt-dead", "grid");
    setTerminals([survivorA, survivorB]);

    usePanelStore.getState().hydrateTabGroups([createMockTabGroup("g1", "wt-dead", ["t1", "t2"])]);

    const state = usePanelStore.getState();
    // Nothing restored onto a live worktree, so there is no safer destination —
    // and the row is exactly where these panels belong until it is swept.
    expect(state.tabGroups.get("g1")?.worktreeId).toBe("wt-dead");
    expect(state.panelsById["t1"]?.worktreeId).toBe("wt-dead");
    expect(state.panelsById["t2"]?.worktreeId).toBe("wt-dead");
  });
});
