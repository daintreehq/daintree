import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { PtyPanelData } from "@shared/types/panel";

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    trash: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAgentStateChanged: vi.fn(),
  },
  appClient: {
    setState: vi.fn().mockResolvedValue(undefined),
  },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
  },
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    destroy: vi.fn(),
  },
}));

const { usePanelStore } = await import("../../../panelStore");
import { addToWorktreeIndex } from "../worktreeIndex";

function seedTerminal(id: string, worktreeId: string, location: "grid" | "dock" = "grid") {
  const terminal = {
    id,
    title: id,
    kind: "browser" as const,
    type: "terminal" as const,
    location,
    worktreeId,
    isVisible: true,
  } as unknown as PtyPanelData;
  usePanelStore.setState((state) => ({
    panelsById: { ...state.panelsById, [id]: terminal },
    panelIds: [...state.panelIds, id],
    panelIdsByWorktreeId: addToWorktreeIndex(state.panelIdsByWorktreeId, worktreeId, id),
  }));
}

describe("panelIdsByWorktreeId invariant across mutations", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    const { reset } = usePanelStore.getState();
    await reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("ordering operations", () => {
    it("reorderTerminals updates the bucket order", () => {
      seedTerminal("t1", "wt-A");
      seedTerminal("t2", "wt-A");
      seedTerminal("t3", "wt-A");

      // Move index 2 (t3) to position 0 within wt-A's grid scope
      usePanelStore.getState().reorderTerminals(2, 0, "grid", "wt-A");

      expect(usePanelStore.getState().panelIdsByWorktreeId["wt-A"]).toEqual(["t3", "t1", "t2"]);
    });

    it("restoreTerminalOrder syncs bucket order on hydration restore", () => {
      seedTerminal("t1", "wt-A");
      seedTerminal("t2", "wt-A");
      seedTerminal("t3", "wt-A");

      usePanelStore.getState().restoreTerminalOrder(["t3", "t1", "t2"]);

      expect(usePanelStore.getState().panelIdsByWorktreeId["wt-A"]).toEqual(["t3", "t1", "t2"]);
    });

    it("reorderTabGroups updates the bucket order", () => {
      seedTerminal("t1", "wt-A");
      seedTerminal("t2", "wt-A");
      seedTerminal("t3", "wt-A");

      // getTabGroups interleaves explicit and virtual groups by earliest
      // panelIds position; the explicit [t1, t2] group lands at index 0 and
      // virtual t3 at index 1.
      usePanelStore.getState().createTabGroup("grid", "wt-A", ["t1", "t2"]);

      // Move the virtual t3 group (index 1) to the front of the grid scope.
      usePanelStore.getState().reorderTabGroups(1, 0, "grid", "wt-A");

      expect(usePanelStore.getState().panelIdsByWorktreeId["wt-A"]).toEqual(["t3", "t1", "t2"]);
    });

    it("getTabGroups interleaves explicit and virtual groups by panelIds order", () => {
      // A panel gaining a second tab (becoming an explicit group) must keep its
      // grid position rather than jumping to the front (#10435).
      seedTerminal("t1", "wt-A");
      seedTerminal("t2", "wt-A");
      seedTerminal("t3", "wt-A");

      usePanelStore.getState().createTabGroup("grid", "wt-A", ["t2", "t3"]);

      // Leading virtual group (t1) must precede the explicit [t2, t3] group.
      expect(
        usePanelStore
          .getState()
          .getTabGroups("grid", "wt-A")
          .map((g) => g.panelIds)
      ).toEqual([["t1"], ["t2", "t3"]]);
    });

    it("getTabGroups interleaves a virtual group on each side of an explicit group", () => {
      seedTerminal("t1", "wt-A");
      seedTerminal("t2", "wt-A");
      seedTerminal("t3", "wt-A");
      seedTerminal("t4", "wt-A");

      usePanelStore.getState().createTabGroup("grid", "wt-A", ["t2", "t3"]);

      // Virtual groups must surround the explicit group in panelIds order.
      expect(
        usePanelStore
          .getState()
          .getTabGroups("grid", "wt-A")
          .map((g) => g.panelIds)
      ).toEqual([["t1"], ["t2", "t3"], ["t4"]]);
    });

    it("getTabGroups keeps group position when a panel gains a second tab via addPanelToGroup", () => {
      // The real #10435 trigger path: an existing panel gains a second tab
      // through addPanelToGroup. The group must stay at its earliest member's
      // position rather than jumping to grid position 0.
      seedTerminal("t1", "wt-A");
      seedTerminal("t2", "wt-A");
      seedTerminal("t3", "wt-A");

      const groupId = usePanelStore.getState().createTabGroup("grid", "wt-A", ["t2"]);
      usePanelStore.getState().addPanelToGroup(groupId, "t3");

      expect(
        usePanelStore
          .getState()
          .getTabGroups("grid", "wt-A")
          .map((g) => g.panelIds)
      ).toEqual([["t1"], ["t2", "t3"]]);
    });

    it("getTabGroups interleaves multiple explicit groups by panelIds order", () => {
      seedTerminal("t1", "wt-A");
      seedTerminal("t2", "wt-A");
      seedTerminal("t3", "wt-A");
      seedTerminal("t4", "wt-A");
      seedTerminal("t5", "wt-A");

      usePanelStore.getState().createTabGroup("grid", "wt-A", ["t2", "t3"]);
      usePanelStore.getState().createTabGroup("grid", "wt-A", ["t4", "t5"]);

      expect(
        usePanelStore
          .getState()
          .getTabGroups("grid", "wt-A")
          .map((g) => g.panelIds)
      ).toEqual([["t1"], ["t2", "t3"], ["t4", "t5"]]);
    });

    it("getTabGroups places a non-contiguous group at its earliest member's position", () => {
      // A group owning t2 and t4 lands at t2's position; t3 stays a virtual
      // group emitted after the group it sits between in panelIds.
      seedTerminal("t1", "wt-A");
      seedTerminal("t2", "wt-A");
      seedTerminal("t3", "wt-A");
      seedTerminal("t4", "wt-A");

      usePanelStore.getState().createTabGroup("grid", "wt-A", ["t2", "t4"]);

      expect(
        usePanelStore
          .getState()
          .getTabGroups("grid", "wt-A")
          .map((g) => g.panelIds)
      ).toEqual([["t1"], ["t2", "t4"], ["t3"]]);
    });

    it("moveTerminalToPosition reorders the affected bucket", () => {
      seedTerminal("t1", "wt-A");
      seedTerminal("t2", "wt-A");
      seedTerminal("t3", "wt-A");

      // Move t3 to grid position 0 within wt-A
      usePanelStore.getState().moveTerminalToPosition("t3", 0, "grid", "wt-A");

      expect(usePanelStore.getState().panelIdsByWorktreeId["wt-A"]).toEqual(["t3", "t1", "t2"]);
    });

    it("reorderTerminals does not pollute unrelated worktree buckets", () => {
      seedTerminal("a1", "wt-A");
      seedTerminal("a2", "wt-A");
      seedTerminal("b1", "wt-B");

      usePanelStore.getState().reorderTerminals(1, 0, "grid", "wt-A");

      expect(usePanelStore.getState().panelIdsByWorktreeId["wt-A"]).toEqual(["a2", "a1"]);
      expect(usePanelStore.getState().panelIdsByWorktreeId["wt-B"]).toEqual(["b1"]);
    });
  });

  describe("structural mutations", () => {
    it("removePanel drops the id from its worktree bucket", () => {
      seedTerminal("t1", "wt-A");
      seedTerminal("t2", "wt-A");
      seedTerminal("t3", "wt-B");

      usePanelStore.getState().removePanel("t1");

      expect(usePanelStore.getState().panelIdsByWorktreeId["wt-A"]).toEqual(["t2"]);
      expect(usePanelStore.getState().panelIdsByWorktreeId["wt-B"]).toEqual(["t3"]);
    });

    it("removePanel deletes the bucket when its last panel goes away", () => {
      seedTerminal("solo", "wt-A");

      usePanelStore.getState().removePanel("solo");

      expect("wt-A" in usePanelStore.getState().panelIdsByWorktreeId).toBe(false);
    });

    it("moveTerminalToWorktree transfers the id between buckets", () => {
      seedTerminal("t1", "wt-A");
      seedTerminal("t2", "wt-B");

      usePanelStore.getState().moveTerminalToWorktree("t1", "wt-B");

      expect("wt-A" in usePanelStore.getState().panelIdsByWorktreeId).toBe(false);
      expect(usePanelStore.getState().panelIdsByWorktreeId["wt-B"]).toEqual(["t2", "t1"]);
    });
  });

  describe("reference stability invariant", () => {
    it("removing a panel from one bucket does not change other bucket references", () => {
      seedTerminal("a1", "wt-A");
      seedTerminal("b1", "wt-B");
      seedTerminal("b2", "wt-B");

      const wtBBefore = usePanelStore.getState().panelIdsByWorktreeId["wt-B"];
      usePanelStore.getState().removePanel("a1");
      const wtBAfter = usePanelStore.getState().panelIdsByWorktreeId["wt-B"];

      expect(wtBAfter).toBe(wtBBefore);
    });

    it("transferring a panel between two buckets does not touch a third", () => {
      seedTerminal("a1", "wt-A");
      seedTerminal("b1", "wt-B");
      seedTerminal("c1", "wt-C");

      const wtCBefore = usePanelStore.getState().panelIdsByWorktreeId["wt-C"];
      usePanelStore.getState().moveTerminalToWorktree("a1", "wt-B");
      const wtCAfter = usePanelStore.getState().panelIdsByWorktreeId["wt-C"];

      expect(wtCAfter).toBe(wtCBefore);
    });
  });
});
