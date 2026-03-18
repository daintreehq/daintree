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

  it("skips snapshot when terminals have been removed", () => {
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
});
