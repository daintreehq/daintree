// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    onBackendRecovering: vi.fn(() => vi.fn()),
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
    get: vi.fn().mockReturnValue(null),
    getAgentState: vi.fn(),
    addAgentStateListener: vi.fn(() => vi.fn()),
    addExitListener: vi.fn(() => vi.fn()),
    addInstanceDestroyedListener: vi.fn(() => vi.fn()),
    destroy: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
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
import { setWorktreeSelectionAccessor } from "@/store/storeAccessors";
import { isPtyPanel, type PtyPanelData } from "@shared/types/panel";
import type { TabGroup } from "@shared/types";

let terminalCounter = 0;

function makeTerminal(overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id: `t-${++terminalCounter}`,
    title: "test",
    location: "grid",
    ...overrides,
  } as PtyPanelData;
}

function setTerminals(terminals: PtyPanelData[]) {
  usePanelStore.setState({
    panelsById: Object.fromEntries(terminals.map((t) => [t.id, t])),
    panelIds: terminals.map((t) => t.id),
  });
}

function seedTerminals(terminals: PtyPanelData[]) {
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
  return s.panelsById[s.panelIds[0]!]! as PtyPanelData;
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
    expect(undoStack[0]!.terminals).toEqual([
      { id: "t1", location: "grid", worktreeId: "w1" },
      { id: "t2", location: "dock", worktreeId: undefined },
    ]);
    expect(undoStack[0]!.focusedId).toBe("t1");
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
    expect(state.panelsById[state.panelIds[0]!]!.location).toBe("grid");
    expect(state.panelsById[state.panelIds[1]!]!.location).toBe("grid");
    expect(state.focusedId).toBe("t1");
  });

  it("undo preserves an overlay assistant panel instead of orphaning it (#9699)", () => {
    const grid = makeTerminal({ id: "grid1", location: "grid", worktreeId: "w1" });
    const assistant = makeTerminal({ id: "assistant", location: "overlay", worktreeId: "w1" });
    seedTerminals([grid, assistant]);

    useLayoutUndoStore.getState().pushLayoutSnapshot();

    // Simulate a layout change to the grid panel, then undo.
    setTerminals([{ ...grid, location: "dock" }, assistant]);
    useLayoutUndoStore.getState().undo();

    const state = usePanelStore.getState();
    // The assistant must still exist in the store and remain an overlay — the
    // full-replacement rebuild in applySnapshot must not drop it.
    expect(state.panelsById["assistant"]).toBeDefined();
    expect(state.panelsById["assistant"]!.location).toBe("overlay");
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
    expect(snapshot!.tabGroups.has("g2")).toBe(false);
    expect(snapshot!.tabGroups.size).toBe(1);
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
    expect(snapshot!.terminals).toHaveLength(1);
    expect(snapshot!.terminals[0]!.id).toBe("t1");
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
    expect(state.panelsById[state.panelIds[0]!]!.location).toBe("grid");
    expect(state.panelsById[state.panelIds[0]!]!.worktreeId).toBe("w1");
    expect(state.panelsById[state.panelIds[1]!]!.location).toBe("dock");
    expect(state.panelsById[state.panelIds[1]!]!.worktreeId).toBe("w1");
    expect(state.focusedId).toBe("t1");
    expect(state.maximizedId).toBe("t1");
    expect(state.activeDockTerminalId).toBe("t2");
    expect(state.tabGroups.size).toBe(1);
    expect(state.tabGroups.get("g1")?.panelIds).toEqual(["t1"]);
    // The per-worktree index must follow the restored worktreeIds — sidebar
    // summaries and worktree cycling read it, and a stale bucket would leave
    // the terminals attributed to the pre-undo worktree.
    expect(state.panelIdsByWorktreeId["w1"]).toEqual(["t1", "t2"]);
    expect(state.panelIdsByWorktreeId["w2"]).toBeUndefined();
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
    expect(allTerminals[0]!.id).toBe("t1");
    expect(allTerminals[0]!.location).toBe("grid");
    expect(allTerminals[1]!.id).toBe("t2");
    expect(allTerminals[1]!.location).toBe("dock");
  });

  // Scrollable panel grid (#8805): undo no longer clamps panels to the
  // screen-fit capacity. The grid scrolls vertically, so restoring a snapshot
  // returns every panel to its captured location regardless of how many fit.
  describe("scrollable grid restore (no clamp)", () => {
    it("undo restores every grid panel from the snapshot even past the legacy fit cap", () => {
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
      const gridCount = allTerms.filter((t) => t!.location === "grid").length;
      const dockCount = allTerms.filter((t) => t!.location === "dock").length;

      expect(gridCount).toBe(6);
      expect(dockCount).toBe(0);
    });

    it("undo restores per-worktree grids without clamping", () => {
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
      expect(allTerms.filter((t) => t!.worktreeId === "w1" && t!.location === "grid")).toHaveLength(
        4
      );
      expect(allTerms.filter((t) => t!.worktreeId === "w2" && t!.location === "grid")).toHaveLength(
        2
      );
      expect(allTerms.filter((t) => t!.location === "dock")).toHaveLength(0);
    });

    it("undo restores tab groups to their captured location without splitting them", () => {
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
      expect(state.panelsById["t3"]?.location).toBe("grid");
      expect(state.panelsById["tg1"]?.location).toBe("grid");
      expect(state.panelsById["tg2"]?.location).toBe("grid");
      expect(state.tabGroups.get("g1")?.location).toBe("grid");
    });

    it("undo restores a small layout without modification", () => {
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
      expect(state.panelsById[state.panelIds[0]!]!.location).toBe("grid");
      expect(state.panelsById[state.panelIds[1]!]!.location).toBe("grid");
    });

    it("undo with null gridDimensions still restores all panels to grid", () => {
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
        .filter((t) => t!.location === "grid").length;
      expect(gridCount).toBe(10);
    });

    it("post-snapshot grid terminals are appended in their current location", () => {
      const t1 = makeTerminal({ id: "t1", location: "grid", worktreeId: "w1" });
      seedTerminals([t1]);
      useLayoutUndoStore.getState().pushLayoutSnapshot();

      const t2 = makeTerminal({ id: "t2", location: "grid", worktreeId: "w1" });
      const t3 = makeTerminal({ id: "t3", location: "grid", worktreeId: "w1" });
      setTerminals([{ ...t1, location: "dock" }, t2, t3]);

      useLayoutConfigStore.setState({ gridDimensions: { width: 800, height: 400 } });

      useLayoutUndoStore.getState().undo();

      const state = usePanelStore.getState();
      // t1 returns to its snapshotted grid; t2 and t3 were created post-snapshot
      // and keep their current grid location — no overflow clamp.
      expect(state.panelsById["t1"]?.location).toBe("grid");
      expect(state.panelsById["t2"]?.location).toBe("grid");
      expect(state.panelsById["t3"]?.location).toBe("grid");
    });
  });

  describe("dockability normalization on undo (#11375)", () => {
    beforeEach(() => {
      setWorktreeSelectionAccessor(() => ({
        activeWorktreeId: "wt-active",
        restoreWorktreeId: null,
      }));
    });

    afterEach(() => {
      setWorktreeSelectionAccessor(() => ({ activeWorktreeId: null, restoreWorktreeId: null }));
    });

    it("restores a now-non-dockable panel to the grid instead of the dock", () => {
      // The panel was dockable when it was docked; its kind now reports
      // non-dockable (a plugin re-registered as dockable:false). Undo must not
      // write it back into the dock — the dock filters it out and the grid
      // excludes it while location stays "dock", so it would strand invisibly.
      const docked = makeTerminal({ id: "t1", location: "dock", worktreeId: "wt-1" });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test carrier: a non-dockable kind on a PTY-shaped panel
      (docked as { kind: string }).kind = "review";
      seedTerminals([docked]);
      useLayoutUndoStore.getState().pushLayoutSnapshot();
      // Move to grid so undo has something to revert to the dock.
      usePanelStore.setState({
        panelsById: { t1: { ...docked, location: "grid" } as PtyPanelData },
      });

      useLayoutUndoStore.getState().undo();

      expect(usePanelStore.getState().panelsById["t1"]?.location).toBe("grid");
    });

    it("adopts the active worktree when a rescued dock panel is worktree-less", () => {
      const docked = makeTerminal({ id: "t1", location: "dock" });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test carrier: a non-dockable kind on a PTY-shaped panel
      (docked as { kind: string }).kind = "review";
      delete (docked as { worktreeId?: string }).worktreeId;
      seedTerminals([docked]);
      useLayoutUndoStore.getState().pushLayoutSnapshot();
      usePanelStore.setState({
        panelsById: { t1: { ...docked, location: "grid" } as PtyPanelData },
      });

      useLayoutUndoStore.getState().undo();

      const panel = usePanelStore.getState().panelsById["t1"];
      expect(panel?.location).toBe("grid");
      expect(panel?.worktreeId).toBe("wt-active");
    });

    it("clears a snapshot activeDockTerminalId that no longer identifies a dock panel", () => {
      const docked = makeTerminal({ id: "t1", location: "dock", worktreeId: "wt-1" });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test carrier: a non-dockable kind on a PTY-shaped panel
      (docked as { kind: string }).kind = "review";
      seedTerminals([docked]);
      usePanelStore.setState({ activeDockTerminalId: "t1" });
      useLayoutUndoStore.getState().pushLayoutSnapshot();
      usePanelStore.setState({
        panelsById: { t1: { ...docked, location: "grid" } as PtyPanelData },
        activeDockTerminalId: null,
      });

      useLayoutUndoStore.getState().undo();

      // The snapshot pointed activeDockTerminalId at t1, but t1 rescued to grid —
      // restoring the stale pointer would open the dock popover onto nothing.
      expect(usePanelStore.getState().activeDockTerminalId).toBeNull();
    });

    it("adopts the active worktree on the group RECORD and members when a global dock group is rescued", () => {
      const a = makeTerminal({ id: "ga", location: "dock" });
      const b = makeTerminal({ id: "gb", location: "dock" });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test carrier: non-dockable kind on a PTY-shaped panel
      (b as { kind: string }).kind = "review"; // one non-dockable member
      delete (a as { worktreeId?: string }).worktreeId;
      delete (b as { worktreeId?: string }).worktreeId;
      seedTerminals([a, b]);
      const dockGroup: TabGroup = {
        id: "g1",
        panelIds: ["ga", "gb"],
        activeTabId: "ga",
        location: "dock",
      };
      usePanelStore.setState({ tabGroups: new Map([["g1", dockGroup]]) });
      useLayoutUndoStore.getState().pushLayoutSnapshot();
      // Flip group + members to grid so undo reverts to the dock snapshot.
      usePanelStore.setState({
        panelsById: {
          ga: { ...a, location: "grid" } as PtyPanelData,
          gb: { ...b, location: "grid" } as PtyPanelData,
        },
        tabGroups: new Map([["g1", { ...dockGroup, location: "grid" }]]),
      });

      useLayoutUndoStore.getState().undo();

      const state = usePanelStore.getState();
      const group = state.tabGroups.get("g1");
      // Group and members agree on grid + the adopted worktree — no split-brain
      // between getTabGroups (filters the group by worktree) and getPanelGroup.
      expect(group?.location).toBe("grid");
      expect(group?.worktreeId).toBe("wt-active");
      expect(state.panelsById["ga"]?.location).toBe("grid");
      expect(state.panelsById["ga"]?.worktreeId).toBe("wt-active");
      expect(state.panelsById["gb"]?.worktreeId).toBe("wt-active");
    });
  });
});

/**
 * An undo restores `worktreeId` with a raw `setState`, so it never passes
 * through the move choke point that owns the cross-worktree banner. Without a
 * reconcile pass the pane comes back where it started still carrying the
 * banner for the destination it just left, and "Tell the agent" would send it
 * to a worktree the user has undone (#11853).
 */
describe("layoutUndoStore — cross-worktree move notice", () => {
  beforeEach(() => {
    useLayoutUndoStore.setState({
      undoStack: [],
      redoStack: [],
      canUndo: false,
      canRedo: false,
    });
    usePanelStore.setState({ panelsById: {}, panelIds: [], tabGroups: new Map() });
  });

  function noticeOf(id: string): string | undefined {
    const panel = usePanelStore.getState().panelsById[id];
    return panel && isPtyPanel(panel) ? panel.worktreeMoveNotice?.destinationWorktreeId : undefined;
  }

  it("clears a stale notice when the move that raised it is undone", () => {
    const agent = makeTerminal({
      id: "t-move",
      worktreeId: "wt-a",
      cwd: "/repo/wt-a",
      launchAgentId: "claude",
      runtimeStatus: "running",
    });
    seedTerminals([agent]);

    useLayoutUndoStore.getState().pushLayoutSnapshot();
    usePanelStore.setState({
      panelsById: {
        "t-move": {
          ...agent,
          worktreeId: "wt-b",
          worktreeMoveNotice: { destinationWorktreeId: "wt-b" },
        },
      },
    });
    expect(noticeOf("t-move")).toBe("wt-b");

    useLayoutUndoStore.getState().undo();

    // Back in wt-a, so a bar still naming wt-b would misdirect the agent.
    expect(usePanelStore.getState().panelsById["t-move"]?.worktreeId).toBe("wt-a");
    expect(noticeOf("t-move")).not.toBe("wt-b");
  });

  it("leaves a panel whose worktree did not change untouched", () => {
    const agent = makeTerminal({
      id: "t-still",
      worktreeId: "wt-a",
      cwd: "/repo/wt-a",
      launchAgentId: "claude",
      runtimeStatus: "running",
    });
    seedTerminals([agent]);

    useLayoutUndoStore.getState().pushLayoutSnapshot();
    usePanelStore.setState({ maximizedId: "t-still" });
    useLayoutUndoStore.getState().undo();

    expect(noticeOf("t-still")).toBeUndefined();
  });
});
