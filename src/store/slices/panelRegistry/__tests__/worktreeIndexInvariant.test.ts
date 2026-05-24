import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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
  } as import("../types").TerminalInstance;
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
