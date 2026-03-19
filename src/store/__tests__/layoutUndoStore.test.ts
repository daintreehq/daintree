// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/controllers", () => ({
  terminalRegistryController: {
    onAgentStateChanged: vi.fn(() => vi.fn()),
    onAgentDetected: vi.fn(() => vi.fn()),
    onAgentExited: vi.fn(() => vi.fn()),
    onActivity: vi.fn(() => vi.fn()),
    onTrashed: vi.fn(() => vi.fn()),
    onRestored: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    onStatus: vi.fn(() => vi.fn()),
    onBackendCrashed: vi.fn(() => vi.fn()),
    onBackendReady: vi.fn(() => vi.fn()),
    onSpawnResult: vi.fn(() => vi.fn()),
    onReduceScrollback: vi.fn(() => vi.fn()),
    onRestoreScrollback: vi.fn(() => vi.fn()),
    spawn: vi.fn(),
    kill: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    getCwd: vi.fn(),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    destroy: vi.fn(),
    applyRendererPolicy: vi.fn(),
    lockResize: vi.fn(),
    optimizeForDock: vi.fn(),
    suppressResizesDuringProjectSwitch: vi.fn(),
    detachForProjectSwitch: vi.fn(),
  },
}));

vi.mock("@/clients/appClient", () => ({
  appClient: {
    setState: vi.fn(),
  },
}));

import { useLayoutUndoStore } from "../layoutUndoStore";
import { useTerminalStore } from "../terminalStore";
import { useLayoutConfigStore } from "../layoutConfigStore";
import type { TerminalInstance } from "@shared/types";

function makeTerminal(overrides: Partial<TerminalInstance> = {}): TerminalInstance {
  return {
    id: `t-${Math.random().toString(36).slice(2, 8)}`,
    title: "test",
    location: "grid",
    ...overrides,
  } as TerminalInstance;
}

function seedTerminals(terminals: TerminalInstance[]) {
  useTerminalStore.setState({
    terminals,
    tabGroups: new Map(),
    focusedId: terminals[0]?.id ?? null,
    maximizedId: null,
    activeDockTerminalId: null,
  });
}

describe("layoutUndoStore", () => {
  beforeEach(() => {
    useLayoutUndoStore.setState({
      undoStack: [],
      redoStack: [],
      canUndo: false,
      canRedo: false,
    });
    useTerminalStore.setState({
      terminals: [],
      tabGroups: new Map(),
      focusedId: null,
      maximizedId: null,
      activeDockTerminalId: null,
    });
    useLayoutConfigStore.setState({ gridDimensions: null });
  });

  it("pushLayoutSnapshot captures current terminal layout", () => {
    const t1 = makeTerminal({ id: "t1", location: "grid", worktreeId: "w1" });
    const t2 = makeTerminal({ id: "t2", location: "dock" });
    seedTerminals([t1, t2]);

    useLayoutUndoStore.getState().pushLayoutSnapshot();

    const { undoStack, canUndo } = useLayoutUndoStore.getState();
    expect(undoStack).toHaveLength(1);
    expect(canUndo).toBe(true);
    expect(undoStack[0].terminals).toEqual([
      { id: "t1", location: "grid", worktreeId: "w1" },
      { id: "t2", location: "dock", worktreeId: undefined },
    ]);
    expect(undoStack[0].focusedId).toBe("t1");
  });

  it("undo restores previous layout", () => {
    const t1 = makeTerminal({ id: "t1", location: "grid" });
    const t2 = makeTerminal({ id: "t2", location: "grid" });
    seedTerminals([t1, t2]);

    // Capture original layout
    useLayoutUndoStore.getState().pushLayoutSnapshot();

    // Mutate layout - move t1 to dock
    useTerminalStore.setState({
      terminals: [
        { ...t1, location: "dock" },
        { ...t2, location: "grid" },
      ],
      focusedId: "t2",
    });

    // Undo
    useLayoutUndoStore.getState().undo();

    const state = useTerminalStore.getState();
    expect(state.terminals[0].location).toBe("grid");
    expect(state.terminals[1].location).toBe("grid");
    expect(state.focusedId).toBe("t1");
  });

  it("redo reverses undo", () => {
    const t1 = makeTerminal({ id: "t1", location: "grid" });
    seedTerminals([t1]);

    useLayoutUndoStore.getState().pushLayoutSnapshot();

    // Mutate
    useTerminalStore.setState({
      terminals: [{ ...t1, location: "dock" }],
      focusedId: null,
    });

    useLayoutUndoStore.getState().undo();
    expect(useTerminalStore.getState().terminals[0].location).toBe("grid");

    useLayoutUndoStore.getState().redo();
    expect(useTerminalStore.getState().terminals[0].location).toBe("dock");
  });

  it("new push clears redo stack", () => {
    const t1 = makeTerminal({ id: "t1", location: "grid" });
    seedTerminals([t1]);

    useLayoutUndoStore.getState().pushLayoutSnapshot();
    useTerminalStore.setState({ terminals: [{ ...t1, location: "dock" }] });
    useLayoutUndoStore.getState().undo();

    expect(useLayoutUndoStore.getState().canRedo).toBe(true);

    // New push should clear redo
    useLayoutUndoStore.getState().pushLayoutSnapshot();
    expect(useLayoutUndoStore.getState().canRedo).toBe(false);
    expect(useLayoutUndoStore.getState().redoStack).toHaveLength(0);
  });

  it("caps undo stack at 10 entries", () => {
    const t1 = makeTerminal({ id: "t1", location: "grid" });
    seedTerminals([t1]);

    for (let i = 0; i < 15; i++) {
      useLayoutUndoStore.getState().pushLayoutSnapshot();
    }

    expect(useLayoutUndoStore.getState().undoStack).toHaveLength(10);
  });

  it("skips snapshot when terminals have been removed and preserves history state", () => {
    const t1 = makeTerminal({ id: "t1", location: "grid" });
    const t2 = makeTerminal({ id: "t2", location: "grid" });
    seedTerminals([t1, t2]);

    // Snapshot with both terminals
    useLayoutUndoStore.getState().pushLayoutSnapshot();

    // Remove t2
    useTerminalStore.setState({
      terminals: [{ ...t1, location: "dock" }],
    });

    // Undo should not apply since t2 is missing
    useLayoutUndoStore.getState().undo();

    // Layout should remain unchanged (t1 in dock)
    expect(useTerminalStore.getState().terminals[0].location).toBe("dock");

    // History should be unmodified — undo entry preserved, no redo created
    const undoState = useLayoutUndoStore.getState();
    expect(undoState.undoStack).toHaveLength(1);
    expect(undoState.redoStack).toHaveLength(0);
    expect(undoState.canUndo).toBe(true);
    expect(undoState.canRedo).toBe(false);
  });

  it("clearHistory empties both stacks", () => {
    const t1 = makeTerminal({ id: "t1", location: "grid" });
    seedTerminals([t1]);

    useLayoutUndoStore.getState().pushLayoutSnapshot();
    useTerminalStore.setState({ terminals: [{ ...t1, location: "dock" }] });
    useLayoutUndoStore.getState().undo();

    expect(useLayoutUndoStore.getState().canUndo).toBe(false);
    expect(useLayoutUndoStore.getState().canRedo).toBe(true);

    useLayoutUndoStore.getState().clearHistory();

    expect(useLayoutUndoStore.getState().undoStack).toHaveLength(0);
    expect(useLayoutUndoStore.getState().redoStack).toHaveLength(0);
    expect(useLayoutUndoStore.getState().canUndo).toBe(false);
    expect(useLayoutUndoStore.getState().canRedo).toBe(false);
  });

  it("canUndo and canRedo reflect stack state", () => {
    expect(useLayoutUndoStore.getState().canUndo).toBe(false);
    expect(useLayoutUndoStore.getState().canRedo).toBe(false);

    const t1 = makeTerminal({ id: "t1", location: "grid" });
    seedTerminals([t1]);

    useLayoutUndoStore.getState().pushLayoutSnapshot();
    expect(useLayoutUndoStore.getState().canUndo).toBe(true);
    expect(useLayoutUndoStore.getState().canRedo).toBe(false);

    useLayoutUndoStore.getState().undo();
    expect(useLayoutUndoStore.getState().canUndo).toBe(false);
    expect(useLayoutUndoStore.getState().canRedo).toBe(true);
  });

  it("tabGroups are properly cloned (no reference sharing)", () => {
    const t1 = makeTerminal({ id: "t1", location: "grid" });
    seedTerminals([t1]);

    const tabGroups = new Map();
    tabGroups.set("g1", {
      id: "g1",
      location: "grid",
      activeTabId: "t1",
      panelIds: ["t1"],
    });
    useTerminalStore.setState({ tabGroups });

    useLayoutUndoStore.getState().pushLayoutSnapshot();

    // Mutate original tabGroups
    tabGroups.set("g2", {
      id: "g2",
      location: "dock",
      activeTabId: "t1",
      panelIds: ["t1"],
    });

    // Snapshot should not be affected
    const snapshot = useLayoutUndoStore.getState().undoStack[0];
    expect(snapshot.tabGroups.has("g2")).toBe(false);
    expect(snapshot.tabGroups.size).toBe(1);
  });

  it("preserves terminal order during undo", () => {
    const t1 = makeTerminal({ id: "t1", location: "grid" });
    const t2 = makeTerminal({ id: "t2", location: "grid" });
    const t3 = makeTerminal({ id: "t3", location: "grid" });
    seedTerminals([t1, t2, t3]);

    useLayoutUndoStore.getState().pushLayoutSnapshot();

    // Reorder: t3, t1, t2
    useTerminalStore.setState({
      terminals: [
        { ...t3, location: "grid" },
        { ...t1, location: "grid" },
        { ...t2, location: "grid" },
      ],
    });

    useLayoutUndoStore.getState().undo();

    const ids = useTerminalStore.getState().terminals.map((t) => t.id);
    expect(ids).toEqual(["t1", "t2", "t3"]);
  });

  it("undo does nothing when stack is empty", () => {
    const t1 = makeTerminal({ id: "t1", location: "dock" });
    seedTerminals([t1]);

    useLayoutUndoStore.getState().undo();

    // State should be unchanged
    expect(useTerminalStore.getState().terminals[0].location).toBe("dock");
  });

  it("redo does nothing when stack is empty", () => {
    const t1 = makeTerminal({ id: "t1", location: "grid" });
    seedTerminals([t1]);

    useLayoutUndoStore.getState().redo();

    expect(useTerminalStore.getState().terminals[0].location).toBe("grid");
  });

  it("filters out trashed terminals from snapshots", () => {
    const t1 = makeTerminal({ id: "t1", location: "grid" });
    const t2 = makeTerminal({ id: "t2", location: "trash" });
    seedTerminals([t1, t2]);

    useLayoutUndoStore.getState().pushLayoutSnapshot();

    const snapshot = useLayoutUndoStore.getState().undoStack[0];
    expect(snapshot.terminals).toHaveLength(1);
    expect(snapshot.terminals[0].id).toBe("t1");
  });

  it("undo restores all snapshot fields including worktreeId, maximizedId, and activeDockTerminalId", () => {
    const t1 = makeTerminal({ id: "t1", location: "grid", worktreeId: "w1" });
    const t2 = makeTerminal({ id: "t2", location: "dock", worktreeId: "w1" });

    const tabGroups = new Map();
    tabGroups.set("g1", {
      id: "g1",
      location: "grid",
      worktreeId: "w1",
      activeTabId: "t1",
      panelIds: ["t1"],
    });

    useTerminalStore.setState({
      terminals: [t1, t2],
      tabGroups,
      focusedId: "t1",
      maximizedId: "t1",
      activeDockTerminalId: "t2",
    });

    useLayoutUndoStore.getState().pushLayoutSnapshot();

    // Mutate everything
    useTerminalStore.setState({
      terminals: [
        { ...t1, location: "dock", worktreeId: "w2" },
        { ...t2, location: "grid", worktreeId: "w2" },
      ],
      tabGroups: new Map(),
      focusedId: "t2",
      maximizedId: null,
      activeDockTerminalId: null,
    });

    useLayoutUndoStore.getState().undo();

    const state = useTerminalStore.getState();
    expect(state.terminals[0].location).toBe("grid");
    expect(state.terminals[0].worktreeId).toBe("w1");
    expect(state.terminals[1].location).toBe("dock");
    expect(state.terminals[1].worktreeId).toBe("w1");
    expect(state.focusedId).toBe("t1");
    expect(state.maximizedId).toBe("t1");
    expect(state.activeDockTerminalId).toBe("t2");
    expect(state.tabGroups.size).toBe(1);
    expect(state.tabGroups.get("g1")?.panelIds).toEqual(["t1"]);
  });

  it("multi-step undo/redo traverses history correctly", () => {
    const t1 = makeTerminal({ id: "t1", location: "grid" });
    seedTerminals([t1]);

    // State A: grid
    useLayoutUndoStore.getState().pushLayoutSnapshot();
    useTerminalStore.setState({ terminals: [{ ...t1, location: "dock" }] });

    // State B: dock
    useLayoutUndoStore.getState().pushLayoutSnapshot();
    useTerminalStore.setState({ terminals: [{ ...t1, location: "grid", worktreeId: "w2" }] });

    // State C: grid+w2
    expect(useLayoutUndoStore.getState().undoStack).toHaveLength(2);

    // Undo C→B
    useLayoutUndoStore.getState().undo();
    expect(useTerminalStore.getState().terminals[0].location).toBe("dock");

    // Undo B→A
    useLayoutUndoStore.getState().undo();
    expect(useTerminalStore.getState().terminals[0].location).toBe("grid");
    expect(useTerminalStore.getState().terminals[0].worktreeId).toBeUndefined();

    // Redo A→B
    useLayoutUndoStore.getState().redo();
    expect(useTerminalStore.getState().terminals[0].location).toBe("dock");

    // Redo B→C
    useLayoutUndoStore.getState().redo();
    expect(useTerminalStore.getState().terminals[0].location).toBe("grid");
    expect(useTerminalStore.getState().terminals[0].worktreeId).toBe("w2");

    expect(useLayoutUndoStore.getState().canRedo).toBe(false);
    expect(useLayoutUndoStore.getState().canUndo).toBe(true);
  });

  it("undo preserves non-layout terminal fields", () => {
    const t1 = makeTerminal({
      id: "t1",
      location: "grid",
      title: "My Terminal",
      pid: 12345,
      agentState: "working",
    });
    seedTerminals([t1]);

    useLayoutUndoStore.getState().pushLayoutSnapshot();

    // Mutate layout only
    useTerminalStore.setState({
      terminals: [{ ...t1, location: "dock" }],
    });

    useLayoutUndoStore.getState().undo();

    const restored = useTerminalStore.getState().terminals[0];
    expect(restored.location).toBe("grid");
    expect(restored.title).toBe("My Terminal");
    expect(restored.pid).toBe(12345);
    expect(restored.agentState).toBe("working");
  });

  it("appends terminals added after snapshot during undo", () => {
    const t1 = makeTerminal({ id: "t1", location: "grid" });
    seedTerminals([t1]);

    useLayoutUndoStore.getState().pushLayoutSnapshot();

    // Add a new terminal and move t1
    const t2 = makeTerminal({ id: "t2", location: "dock" });
    useTerminalStore.setState({
      terminals: [{ ...t1, location: "dock" }, t2],
    });

    useLayoutUndoStore.getState().undo();

    const terminals = useTerminalStore.getState().terminals;
    // t1 should be restored to grid, t2 appended at end
    expect(terminals).toHaveLength(2);
    expect(terminals[0].id).toBe("t1");
    expect(terminals[0].location).toBe("grid");
    expect(terminals[1].id).toBe("t2");
    expect(terminals[1].location).toBe("dock");
  });

  describe("grid capacity clamping", () => {
    it("undo clamps grid panels to current capacity", () => {
      // Set up 6 grid terminals in one worktree
      const terminals = Array.from({ length: 6 }, (_, i) =>
        makeTerminal({ id: `t${i}`, location: "grid", worktreeId: "w1" })
      );
      seedTerminals(terminals);
      useLayoutUndoStore.getState().pushLayoutSnapshot();

      // Move all to dock (simulating a layout change)
      useTerminalStore.setState({
        terminals: terminals.map((t) => ({ ...t, location: "dock" })),
      });

      // Shrink grid: 800x400 gives capacity of 2 (2 cols × 2 rows)
      useLayoutConfigStore.setState({ gridDimensions: { width: 800, height: 400 } });

      useLayoutUndoStore.getState().undo();

      const state = useTerminalStore.getState();
      const gridCount = state.terminals.filter((t) => t.location === "grid").length;
      const dockCount = state.terminals.filter((t) => t.location === "dock").length;

      // Capacity at 800x400: cols=2, rows=1 → capacity=2
      expect(gridCount).toBe(2);
      expect(dockCount).toBe(4);

      // First 2 terminals stay in grid, last 4 overflow to dock
      expect(state.terminals[0].location).toBe("grid");
      expect(state.terminals[1].location).toBe("grid");
      expect(state.terminals[2].location).toBe("dock");
    });

    it("undo respects per-worktree capacity", () => {
      // w1 has 4 grid panels, w2 has 2 grid panels
      const w1Terminals = Array.from({ length: 4 }, (_, i) =>
        makeTerminal({ id: `w1-t${i}`, location: "grid", worktreeId: "w1" })
      );
      const w2Terminals = Array.from({ length: 2 }, (_, i) =>
        makeTerminal({ id: `w2-t${i}`, location: "grid", worktreeId: "w2" })
      );
      seedTerminals([...w1Terminals, ...w2Terminals]);
      useLayoutUndoStore.getState().pushLayoutSnapshot();

      // Move all to dock
      useTerminalStore.setState({
        terminals: [...w1Terminals, ...w2Terminals].map((t) => ({ ...t, location: "dock" })),
      });

      // Capacity = 2 per worktree
      useLayoutConfigStore.setState({ gridDimensions: { width: 800, height: 400 } });

      useLayoutUndoStore.getState().undo();

      const state = useTerminalStore.getState();
      const w1Grid = state.terminals.filter((t) => t.worktreeId === "w1" && t.location === "grid");
      const w1Dock = state.terminals.filter((t) => t.worktreeId === "w1" && t.location === "dock");
      const w2Grid = state.terminals.filter((t) => t.worktreeId === "w2" && t.location === "grid");

      expect(w1Grid).toHaveLength(2);
      expect(w1Dock).toHaveLength(2);
      expect(w2Grid).toHaveLength(2); // w2 fits within capacity
    });

    it("undo clamps tab groups as whole units", () => {
      // 3 ungrouped panels + 1 tab group with 2 panels = 4 slots total
      const t1 = makeTerminal({ id: "t1", location: "grid", worktreeId: "w1" });
      const t2 = makeTerminal({ id: "t2", location: "grid", worktreeId: "w1" });
      const t3 = makeTerminal({ id: "t3", location: "grid", worktreeId: "w1" });
      const tg1 = makeTerminal({ id: "tg1", location: "grid", worktreeId: "w1" });
      const tg2 = makeTerminal({ id: "tg2", location: "grid", worktreeId: "w1" });

      const tabGroups = new Map();
      tabGroups.set("g1", {
        id: "g1",
        location: "grid",
        worktreeId: "w1",
        activeTabId: "tg1",
        panelIds: ["tg1", "tg2"],
      });

      useTerminalStore.setState({
        terminals: [t1, t2, t3, tg1, tg2],
        tabGroups,
        focusedId: "t1",
        maximizedId: null,
        activeDockTerminalId: null,
      });

      useLayoutUndoStore.getState().pushLayoutSnapshot();

      // Move all to dock
      useTerminalStore.setState({
        terminals: [t1, t2, t3, tg1, tg2].map((t) => ({ ...t, location: "dock" })),
        tabGroups: new Map(),
      });

      // Capacity = 2 → only 2 of 4 slots fit
      useLayoutConfigStore.setState({ gridDimensions: { width: 800, height: 400 } });

      useLayoutUndoStore.getState().undo();

      const state = useTerminalStore.getState();

      // First 2 slots are t1 and t2 (ungrouped). t3 and g1 overflow.
      expect(state.terminals.find((t) => t.id === "t1")?.location).toBe("grid");
      expect(state.terminals.find((t) => t.id === "t2")?.location).toBe("grid");
      expect(state.terminals.find((t) => t.id === "t3")?.location).toBe("dock");
      // Both panels in the tab group should be docked together
      expect(state.terminals.find((t) => t.id === "tg1")?.location).toBe("dock");
      expect(state.terminals.find((t) => t.id === "tg2")?.location).toBe("dock");
      // Tab group location should be updated to dock
      expect(state.tabGroups.get("g1")?.location).toBe("dock");
    });

    it("undo with no capacity exceeded works normally", () => {
      const t1 = makeTerminal({ id: "t1", location: "grid", worktreeId: "w1" });
      const t2 = makeTerminal({ id: "t2", location: "grid", worktreeId: "w1" });
      seedTerminals([t1, t2]);
      useLayoutUndoStore.getState().pushLayoutSnapshot();

      useTerminalStore.setState({
        terminals: [
          { ...t1, location: "dock" },
          { ...t2, location: "dock" },
        ],
      });

      // Large grid: capacity >> 2
      useLayoutConfigStore.setState({ gridDimensions: { width: 2000, height: 1200 } });

      useLayoutUndoStore.getState().undo();

      const state = useTerminalStore.getState();
      expect(state.terminals[0].location).toBe("grid");
      expect(state.terminals[1].location).toBe("grid");
    });

    it("undo with null gridDimensions uses absolute max", () => {
      // null dimensions → ABSOLUTE_MAX_GRID_TERMINALS (16)
      const terminals = Array.from({ length: 10 }, (_, i) =>
        makeTerminal({ id: `t${i}`, location: "grid", worktreeId: "w1" })
      );
      seedTerminals(terminals);
      useLayoutUndoStore.getState().pushLayoutSnapshot();

      useTerminalStore.setState({
        terminals: terminals.map((t) => ({ ...t, location: "dock" })),
      });

      // gridDimensions is null (default)
      useLayoutUndoStore.getState().undo();

      const state = useTerminalStore.getState();
      const gridCount = state.terminals.filter((t) => t.location === "grid").length;
      expect(gridCount).toBe(10); // All fit within capacity 16
    });

    it("post-snapshot grid terminals are clamped during undo", () => {
      // Snapshot with t1 in grid
      const t1 = makeTerminal({ id: "t1", location: "grid", worktreeId: "w1" });
      seedTerminals([t1]);
      useLayoutUndoStore.getState().pushLayoutSnapshot();

      // After snapshot, add t2 and t3 to grid
      const t2 = makeTerminal({ id: "t2", location: "grid", worktreeId: "w1" });
      const t3 = makeTerminal({ id: "t3", location: "grid", worktreeId: "w1" });
      useTerminalStore.setState({
        terminals: [{ ...t1, location: "dock" }, t2, t3],
      });

      // Capacity = 2 → snapshot has t1 in grid, post-snapshot has t2+t3 in grid = 3 slots
      useLayoutConfigStore.setState({ gridDimensions: { width: 800, height: 400 } });

      useLayoutUndoStore.getState().undo();

      const state = useTerminalStore.getState();
      // t1 (from snapshot) gets priority, t2 is second, t3 overflows
      expect(state.terminals.find((t) => t.id === "t1")?.location).toBe("grid");
      expect(state.terminals.find((t) => t.id === "t2")?.location).toBe("grid");
      expect(state.terminals.find((t) => t.id === "t3")?.location).toBe("dock");
    });
  });
});
