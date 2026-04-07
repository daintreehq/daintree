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
import { usePanelStore } from "../panelStore";
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

function setTerminals(terminals: TerminalInstance[]) {
  usePanelStore.setState({
    panelsById: Object.fromEntries(terminals.map((t) => [t.id, t])),
    panelIds: terminals.map((t) => t.id),
  });
}

function seedTerminals(terminals: TerminalInstance[]) {
  usePanelStore.setState({
    panelsById: Object.fromEntries(terminals.map((t) => [t.id, t])),
    panelIds: terminals.map((t) => t.id),
    tabGroups: new Map(),
    focusedId: terminals[0]?.id ?? null,
    maximizedId: null,
    activeDockTerminalId: null,
  });
}

function getTerminals() {
  const state = usePanelStore.getState();
  return state.panelIds.map((id) => state.panelsById[id]);
}

function firstTerminal() {
  const s = usePanelStore.getState();
  return s.panelsById[s.panelIds[0]];
}

describe("layoutUndoStore", () => {
  beforeEach(() => {
    useLayoutUndoStore.setState({
      undoStack: [],
      redoStack: [],
      canUndo: false,
      canRedo: false,
    });
    usePanelStore.setState({
      panelsById: {},
      panelIds: [],
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

    useLayoutUndoStore.getState().pushLayoutSnapshot();

    setTerminals([
      { ...t1, location: "dock" },
      { ...t2, location: "grid" },
    ]);
    usePanelStore.setState({ focusedId: "t2" });

    useLayoutUndoStore.getState().undo();

    const state = usePanelStore.getState();
    expect(state.panelsById[state.panelIds[0]].location).toBe("grid");
    expect(state.panelsById[state.panelIds[1]].location).toBe("grid");
    expect(state.focusedId).toBe("t1");
  });

  it("redo reverses undo", () => {
    const t1 = makeTerminal({ id: "t1", location: "grid" });
    seedTerminals([t1]);

    useLayoutUndoStore.getState().pushLayoutSnapshot();

    setTerminals([{ ...t1, location: "dock" }]);
    usePanelStore.setState({ focusedId: null });

    useLayoutUndoStore.getState().undo();
    expect(firstTerminal().location).toBe("grid");

    useLayoutUndoStore.getState().redo();
    expect(firstTerminal().location).toBe("dock");
  });

  it("new push clears redo stack", () => {
    const t1 = makeTerminal({ id: "t1", location: "grid" });
    seedTerminals([t1]);

    useLayoutUndoStore.getState().pushLayoutSnapshot();
    setTerminals([{ ...t1, location: "dock" }]);
    useLayoutUndoStore.getState().undo();

    expect(useLayoutUndoStore.getState().canRedo).toBe(true);

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

    useLayoutUndoStore.getState().pushLayoutSnapshot();

    setTerminals([{ ...t1, location: "dock" }]);

    useLayoutUndoStore.getState().undo();

    expect(firstTerminal().location).toBe("dock");

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
    setTerminals([{ ...t1, location: "dock" }]);
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
    usePanelStore.setState({ tabGroups });

    useLayoutUndoStore.getState().pushLayoutSnapshot();

    tabGroups.set("g2", {
      id: "g2",
      location: "dock",
      activeTabId: "t1",
      panelIds: ["t1"],
    });

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

    setTerminals([
      { ...t3, location: "grid" },
      { ...t1, location: "grid" },
      { ...t2, location: "grid" },
    ]);

    useLayoutUndoStore.getState().undo();

    const ids = usePanelStore.getState().panelIds;
    expect(ids).toEqual(["t1", "t2", "t3"]);
  });

  it("undo does nothing when stack is empty", () => {
    const t1 = makeTerminal({ id: "t1", location: "dock" });
    seedTerminals([t1]);

    useLayoutUndoStore.getState().undo();

    expect(firstTerminal().location).toBe("dock");
  });

  it("redo does nothing when stack is empty", () => {
    const t1 = makeTerminal({ id: "t1", location: "grid" });
    seedTerminals([t1]);

    useLayoutUndoStore.getState().redo();

    expect(firstTerminal().location).toBe("grid");
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

    usePanelStore.setState({
      panelsById: Object.fromEntries([t1, t2].map((t) => [t.id, t])),
      panelIds: [t1, t2].map((t) => t.id),
      tabGroups,
      focusedId: "t1",
      maximizedId: "t1",
      activeDockTerminalId: "t2",
    });

    useLayoutUndoStore.getState().pushLayoutSnapshot();

    const mutated = [
      { ...t1, location: "dock" as const, worktreeId: "w2" },
      { ...t2, location: "grid" as const, worktreeId: "w2" },
    ];
    usePanelStore.setState({
      panelsById: Object.fromEntries(mutated.map((t) => [t.id, t])),
      panelIds: mutated.map((t) => t.id),
      tabGroups: new Map(),
      focusedId: "t2",
      maximizedId: null,
      activeDockTerminalId: null,
    });

    useLayoutUndoStore.getState().undo();

    const state = usePanelStore.getState();
    expect(state.panelsById[state.panelIds[0]].location).toBe("grid");
    expect(state.panelsById[state.panelIds[0]].worktreeId).toBe("w1");
    expect(state.panelsById[state.panelIds[1]].location).toBe("dock");
    expect(state.panelsById[state.panelIds[1]].worktreeId).toBe("w1");
    expect(state.focusedId).toBe("t1");
    expect(state.maximizedId).toBe("t1");
    expect(state.activeDockTerminalId).toBe("t2");
    expect(state.tabGroups.size).toBe(1);
    expect(state.tabGroups.get("g1")?.panelIds).toEqual(["t1"]);
  });

  it("multi-step undo/redo traverses history correctly", () => {
    const t1 = makeTerminal({ id: "t1", location: "grid" });
    seedTerminals([t1]);

    useLayoutUndoStore.getState().pushLayoutSnapshot();
    setTerminals([{ ...t1, location: "dock" }]);

    useLayoutUndoStore.getState().pushLayoutSnapshot();
    setTerminals([{ ...t1, location: "grid", worktreeId: "w2" }]);

    expect(useLayoutUndoStore.getState().undoStack).toHaveLength(2);

    useLayoutUndoStore.getState().undo();
    expect(firstTerminal().location).toBe("dock");

    useLayoutUndoStore.getState().undo();
    expect(firstTerminal().location).toBe("grid");
    expect(firstTerminal().worktreeId).toBeUndefined();

    useLayoutUndoStore.getState().redo();
    expect(firstTerminal().location).toBe("dock");

    useLayoutUndoStore.getState().redo();
    expect(firstTerminal().location).toBe("grid");
    expect(firstTerminal().worktreeId).toBe("w2");

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

    setTerminals([{ ...t1, location: "dock" }]);

    useLayoutUndoStore.getState().undo();

    const restored = firstTerminal();
    expect(restored.location).toBe("grid");
    expect(restored.title).toBe("My Terminal");
    expect(restored.pid).toBe(12345);
    expect(restored.agentState).toBe("working");
  });

  it("appends terminals added after snapshot during undo", () => {
    const t1 = makeTerminal({ id: "t1", location: "grid" });
    seedTerminals([t1]);

    useLayoutUndoStore.getState().pushLayoutSnapshot();

    const t2 = makeTerminal({ id: "t2", location: "dock" });
    setTerminals([{ ...t1, location: "dock" }, t2]);

    useLayoutUndoStore.getState().undo();

    const allTerminals = getTerminals();
    expect(allTerminals).toHaveLength(2);
    expect(allTerminals[0].id).toBe("t1");
    expect(allTerminals[0].location).toBe("grid");
    expect(allTerminals[1].id).toBe("t2");
    expect(allTerminals[1].location).toBe("dock");
  });

  describe("grid capacity clamping", () => {
    it("undo clamps grid panels to current capacity", () => {
      const terminals = Array.from({ length: 6 }, (_, i) =>
        makeTerminal({ id: `t${i}`, location: "grid", worktreeId: "w1" })
      );
      seedTerminals(terminals);
      useLayoutUndoStore.getState().pushLayoutSnapshot();

      setTerminals(terminals.map((t) => ({ ...t, location: "dock" })));

      useLayoutConfigStore.setState({ gridDimensions: { width: 800, height: 400 } });

      useLayoutUndoStore.getState().undo();

      const state = usePanelStore.getState();
      const allTerms = state.panelIds.map((id) => state.panelsById[id]);
      const gridCount = allTerms.filter((t) => t.location === "grid").length;
      const dockCount = allTerms.filter((t) => t.location === "dock").length;

      expect(gridCount).toBe(2);
      expect(dockCount).toBe(4);

      expect(state.panelsById[state.panelIds[0]].location).toBe("grid");
      expect(state.panelsById[state.panelIds[1]].location).toBe("grid");
      expect(state.panelsById[state.panelIds[2]].location).toBe("dock");
    });

    it("undo respects per-worktree capacity", () => {
      const w1Terminals = Array.from({ length: 4 }, (_, i) =>
        makeTerminal({ id: `w1-t${i}`, location: "grid", worktreeId: "w1" })
      );
      const w2Terminals = Array.from({ length: 2 }, (_, i) =>
        makeTerminal({ id: `w2-t${i}`, location: "grid", worktreeId: "w2" })
      );
      seedTerminals([...w1Terminals, ...w2Terminals]);
      useLayoutUndoStore.getState().pushLayoutSnapshot();

      setTerminals([...w1Terminals, ...w2Terminals].map((t) => ({ ...t, location: "dock" })));

      useLayoutConfigStore.setState({ gridDimensions: { width: 800, height: 400 } });

      useLayoutUndoStore.getState().undo();

      const state = usePanelStore.getState();
      const allTerms = state.panelIds.map((id) => state.panelsById[id]);
      const w1Grid = allTerms.filter((t) => t.worktreeId === "w1" && t.location === "grid");
      const w1Dock = allTerms.filter((t) => t.worktreeId === "w1" && t.location === "dock");
      const w2Grid = allTerms.filter((t) => t.worktreeId === "w2" && t.location === "grid");

      expect(w1Grid).toHaveLength(2);
      expect(w1Dock).toHaveLength(2);
      expect(w2Grid).toHaveLength(2);
    });

    it("undo clamps tab groups as whole units", () => {
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

      const allTerms = [t1, t2, t3, tg1, tg2];
      usePanelStore.setState({
        panelsById: Object.fromEntries(allTerms.map((t) => [t.id, t])),
        panelIds: allTerms.map((t) => t.id),
        tabGroups,
        focusedId: "t1",
        maximizedId: null,
        activeDockTerminalId: null,
      });

      useLayoutUndoStore.getState().pushLayoutSnapshot();

      const docked = allTerms.map((t) => ({ ...t, location: "dock" as const }));
      usePanelStore.setState({
        panelsById: Object.fromEntries(docked.map((t) => [t.id, t])),
        panelIds: docked.map((t) => t.id),
        tabGroups: new Map(),
      });

      useLayoutConfigStore.setState({ gridDimensions: { width: 800, height: 400 } });

      useLayoutUndoStore.getState().undo();

      const state = usePanelStore.getState();

      expect(state.panelsById["t1"]?.location).toBe("grid");
      expect(state.panelsById["t2"]?.location).toBe("grid");
      expect(state.panelsById["t3"]?.location).toBe("dock");
      expect(state.panelsById["tg1"]?.location).toBe("dock");
      expect(state.panelsById["tg2"]?.location).toBe("dock");
      expect(state.tabGroups.get("g1")?.location).toBe("dock");
    });

    it("undo with no capacity exceeded works normally", () => {
      const t1 = makeTerminal({ id: "t1", location: "grid", worktreeId: "w1" });
      const t2 = makeTerminal({ id: "t2", location: "grid", worktreeId: "w1" });
      seedTerminals([t1, t2]);
      useLayoutUndoStore.getState().pushLayoutSnapshot();

      setTerminals([
        { ...t1, location: "dock" },
        { ...t2, location: "dock" },
      ]);

      useLayoutConfigStore.setState({ gridDimensions: { width: 2000, height: 1200 } });

      useLayoutUndoStore.getState().undo();

      const state = usePanelStore.getState();
      expect(state.panelsById[state.panelIds[0]].location).toBe("grid");
      expect(state.panelsById[state.panelIds[1]].location).toBe("grid");
    });

    it("undo with null gridDimensions uses absolute max", () => {
      const terminals = Array.from({ length: 10 }, (_, i) =>
        makeTerminal({ id: `t${i}`, location: "grid", worktreeId: "w1" })
      );
      seedTerminals(terminals);
      useLayoutUndoStore.getState().pushLayoutSnapshot();

      setTerminals(terminals.map((t) => ({ ...t, location: "dock" })));

      useLayoutUndoStore.getState().undo();

      const state = usePanelStore.getState();
      const gridCount = state.panelIds
        .map((id) => state.panelsById[id])
        .filter((t) => t.location === "grid").length;
      expect(gridCount).toBe(10);
    });

    it("post-snapshot grid terminals are clamped during undo", () => {
      const t1 = makeTerminal({ id: "t1", location: "grid", worktreeId: "w1" });
      seedTerminals([t1]);
      useLayoutUndoStore.getState().pushLayoutSnapshot();

      const t2 = makeTerminal({ id: "t2", location: "grid", worktreeId: "w1" });
      const t3 = makeTerminal({ id: "t3", location: "grid", worktreeId: "w1" });
      setTerminals([{ ...t1, location: "dock" }, t2, t3]);

      useLayoutConfigStore.setState({ gridDimensions: { width: 800, height: 400 } });

      useLayoutUndoStore.getState().undo();

      const state = usePanelStore.getState();
      expect(state.panelsById["t1"]?.location).toBe("grid");
      expect(state.panelsById["t2"]?.location).toBe("grid");
      expect(state.panelsById["t3"]?.location).toBe("dock");
    });
  });
});
