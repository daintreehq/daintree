// @vitest-environment jsdom
/**
 * Tests for trashPanel auto-removing panels from tab groups
 * Issue #1848: trashPanel should auto-remove panel from tab group at store level
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { TabGroup } from "@/types";
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
  },
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    cleanup: vi.fn(),
    destroy: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
  },
}));

const { usePanelStore } = await import("../../../panelStore");

type MockTerminal = Partial<PtyPanelData> & { id: string };

function setTerminals(terminals: MockTerminal[]) {
  usePanelStore.setState({
    panelsById: Object.fromEntries(terminals.map((t) => [t.id, t])) as Record<string, PtyPanelData>,
    panelIds: terminals.map((t) => t.id),
  });
}

describe("trashPanel group cleanup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const { reset } = usePanelStore.getState();
    reset();
    usePanelStore.setState({
      panelsById: {},
      panelIds: [],
      tabGroups: new Map(),
      trashedTerminals: new Map(),
      backgroundedTerminals: new Map(),
      focusedId: null,
      maximizedId: null,
      commandQueue: [],
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("should update activeTabId when active tab is trashed", () => {
    const group: TabGroup = {
      id: "group-1",
      panelIds: ["term-1", "term-2", "term-3"],
      activeTabId: "term-1",
      location: "grid",
    };

    setTerminals([
      {
        id: "term-1",
        title: "Shell 1",
        cwd: "/test",
        cols: 80,
        rows: 24,
        location: "grid",
      },
      {
        id: "term-2",
        title: "Shell 2",
        cwd: "/test",
        cols: 80,
        rows: 24,
        location: "grid",
      },
      {
        id: "term-3",
        title: "Shell 3",
        cwd: "/test",
        cols: 80,
        rows: 24,
        location: "grid",
      },
    ]);
    usePanelStore.setState({ tabGroups: new Map([["group-1", group]]) });

    const { trashPanel } = usePanelStore.getState();
    trashPanel("term-1");

    const state = usePanelStore.getState();
    const updatedGroup = state.tabGroups.get("group-1");
    expect(updatedGroup?.activeTabId).toBe("term-2");
  });

  it("should delete group when trashing last panel", () => {
    const group: TabGroup = {
      id: "group-1",
      panelIds: ["term-1"],
      activeTabId: "term-1",
      location: "grid",
    };

    setTerminals([
      {
        id: "term-1",
        title: "Shell 1",
        cwd: "/test",
        cols: 80,
        rows: 24,
        location: "grid",
      },
    ]);
    usePanelStore.setState({ tabGroups: new Map([["group-1", group]]) });

    const { trashPanel } = usePanelStore.getState();
    trashPanel("term-1");

    const state = usePanelStore.getState();
    expect(state.tabGroups.has("group-1")).toBe(false);
  });

  it("should not affect panels not in any group", () => {
    setTerminals([
      {
        id: "term-1",
        title: "Shell 1",
        cwd: "/test",
        cols: 80,
        rows: 24,
        location: "grid",
      },
    ]);
    usePanelStore.setState({ tabGroups: new Map() });

    const { trashPanel } = usePanelStore.getState();
    trashPanel("term-1");

    const state = usePanelStore.getState();
    expect(state.tabGroups.size).toBe(0);
    expect(state.panelsById["term-1"]?.location).toBe("trash");
  });

  it("should work when trashing non-active tab", () => {
    const group: TabGroup = {
      id: "group-1",
      panelIds: ["term-1", "term-2", "term-3"],
      activeTabId: "term-1",
      location: "grid",
    };

    setTerminals([
      {
        id: "term-1",
        title: "Shell 1",
        cwd: "/test",
        cols: 80,
        rows: 24,
        location: "grid",
      },
      {
        id: "term-2",
        title: "Shell 2",
        cwd: "/test",
        cols: 80,
        rows: 24,
        location: "grid",
      },
      {
        id: "term-3",
        title: "Shell 3",
        cwd: "/test",
        cols: 80,
        rows: 24,
        location: "grid",
      },
    ]);
    usePanelStore.setState({ tabGroups: new Map([["group-1", group]]) });

    const { trashPanel } = usePanelStore.getState();
    trashPanel("term-2");

    const state = usePanelStore.getState();
    const updatedGroup = state.tabGroups.get("group-1");
    expect(updatedGroup?.panelIds).toEqual(["term-1", "term-3"]);
    expect(updatedGroup?.activeTabId).toBe("term-1");
  });

  it("should atomically update both terminal location and tab group", () => {
    const group: TabGroup = {
      id: "group-1",
      panelIds: ["term-1", "term-2"],
      activeTabId: "term-1",
      location: "grid",
    };

    setTerminals([
      {
        id: "term-1",
        title: "Shell 1",
        cwd: "/test",
        cols: 80,
        rows: 24,
        location: "grid",
      },
      {
        id: "term-2",
        title: "Shell 2",
        cwd: "/test",
        cols: 80,
        rows: 24,
        location: "grid",
      },
    ]);
    usePanelStore.setState({ tabGroups: new Map([["group-1", group]]) });

    const { trashPanel } = usePanelStore.getState();
    trashPanel("term-1");

    const state = usePanelStore.getState();
    // Both should be updated atomically
    expect(state.panelsById["term-1"]?.location).toBe("trash");
    expect(state.tabGroups.has("group-1")).toBe(false);
  });
});

describe("trash expiry visibility sweep", () => {
  let originalVisibilityState: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    const { reset } = usePanelStore.getState();
    reset();

    // Save the original descriptor from the prototype (not instance).
    originalVisibilityState = Object.getOwnPropertyDescriptor(
      Document.prototype,
      "visibilityState"
    );

    usePanelStore.setState({
      panelsById: {},
      panelIds: [],
      tabGroups: new Map(),
      trashedTerminals: new Map(),
      backgroundedTerminals: new Map(),
      focusedId: null,
      maximizedId: null,
      commandQueue: [],
    });
  });

  afterEach(() => {
    if (originalVisibilityState) {
      Object.defineProperty(document, "visibilityState", originalVisibilityState);
    } else {
      delete (document as unknown as Record<string, unknown>).visibilityState;
    }
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function setVisibilityState(state: string) {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => state,
    });
  }

  function dispatchVisibilityChange(state: string) {
    setVisibilityState(state);
    document.dispatchEvent(new Event("visibilitychange"));
  }

  it("should sweep expired trashed terminals on visibility restore", () => {
    setTerminals([
      {
        id: "term-1",
        title: "Term 1",
        cwd: "/test",
        cols: 80,
        rows: 24,
        location: "grid",
      },
    ]);

    const { trashPanel } = usePanelStore.getState();
    trashPanel("term-1");

    // Verify trashed
    let state = usePanelStore.getState();
    expect(state.trashedTerminals.has("term-1")).toBe(true);
    expect(state.panelsById["term-1"]?.location).toBe("trash");

    // Set expiresAt to 1ms in the past
    const trashedInfo = state.trashedTerminals.get("term-1")!;
    usePanelStore.setState({
      trashedTerminals: new Map([["term-1", { ...trashedInfo, expiresAt: Date.now() - 1 }]]),
    });

    // Make document hidden, then visible
    dispatchVisibilityChange("hidden");
    dispatchVisibilityChange("visible");

    state = usePanelStore.getState();
    expect(state.trashedTerminals.has("term-1")).toBe(false);
    expect(state.panelsById["term-1"]).toBeUndefined();
  });

  it("should not sweep non-expired trashed terminals on visibility restore", () => {
    setTerminals([
      {
        id: "term-1",
        title: "Term 1",
        cwd: "/test",
        cols: 80,
        rows: 24,
        location: "grid",
      },
    ]);

    const { trashPanel } = usePanelStore.getState();
    trashPanel("term-1");

    // Set expiresAt far in the future
    const state = usePanelStore.getState();
    const trashedInfo = state.trashedTerminals.get("term-1")!;
    usePanelStore.setState({
      trashedTerminals: new Map([["term-1", { ...trashedInfo, expiresAt: Date.now() + 60_000 }]]),
    });

    dispatchVisibilityChange("visible");

    const afterState = usePanelStore.getState();
    expect(afterState.trashedTerminals.has("term-1")).toBe(true);
    expect(afterState.panelsById["term-1"]?.location).toBe("trash");
  });

  it("should handle visibility restore race with setTimeout safely", () => {
    setTerminals([
      {
        id: "term-1",
        title: "Term 1",
        cwd: "/test",
        cols: 80,
        rows: 24,
        location: "grid",
      },
    ]);

    const { trashPanel } = usePanelStore.getState();
    trashPanel("term-1");

    // Make it expired, sweep via visibility
    const state = usePanelStore.getState();
    const trashedInfo = state.trashedTerminals.get("term-1")!;
    usePanelStore.setState({
      trashedTerminals: new Map([["term-1", { ...trashedInfo, expiresAt: Date.now() - 1 }]]),
    });

    dispatchVisibilityChange("visible");

    // Terminal should be removed by sweep
    const afterSweep = usePanelStore.getState();
    expect(afterSweep.trashedTerminals.has("term-1")).toBe(false);

    // Now advance fake timers past TTL — the stale callback should be safe
    vi.advanceTimersByTime(30_000);

    // No crash, no-op
    expect(usePanelStore.getState().panelsById["term-1"]).toBeUndefined();
  });

  it("should skip sweep when visibilityState is not visible", () => {
    setTerminals([
      {
        id: "term-1",
        title: "Term 1",
        cwd: "/test",
        cols: 80,
        rows: 24,
        location: "grid",
      },
    ]);

    const { trashPanel } = usePanelStore.getState();
    trashPanel("term-1");

    const state = usePanelStore.getState();
    const trashedInfo = state.trashedTerminals.get("term-1")!;
    usePanelStore.setState({
      trashedTerminals: new Map([["term-1", { ...trashedInfo, expiresAt: Date.now() - 1 }]]),
    });

    // Dispatch hidden — sweep should not run
    dispatchVisibilityChange("hidden");

    const afterState = usePanelStore.getState();
    expect(afterState.trashedTerminals.has("term-1")).toBe(true);
  });

  it("should not remove active terminal with stale trash metadata", () => {
    setTerminals([
      {
        id: "term-1",
        title: "Term 1",
        cwd: "/test",
        cols: 80,
        rows: 24,
        location: "grid",
      },
    ]);

    // Seed stale trash metadata for an active (grid-located) terminal.
    // This simulates corrupted state where trashedTerminals is out of sync
    // with the panel's actual location.
    usePanelStore.setState({
      trashedTerminals: new Map([
        ["term-1", { id: "term-1", expiresAt: Date.now() - 1, originalLocation: "grid" as const }],
      ]),
    });

    dispatchVisibilityChange("visible");

    const afterState = usePanelStore.getState();
    // The active terminal must survive — the sweep must not remove it.
    expect(afterState.panelsById["term-1"]).toBeDefined();
    expect(afterState.panelsById["term-1"]?.location).toBe("grid");
    // The stale trash metadata should be cleaned up.
    expect(afterState.trashedTerminals.has("term-1")).toBe(false);
  });

  it("should clean up expired trash metadata for missing panel safely", () => {
    // Seed a trash entry with no corresponding panelsById entry.
    usePanelStore.setState({
      trashedTerminals: new Map([
        [
          "orphan-1",
          { id: "orphan-1", expiresAt: Date.now() - 1, originalLocation: "grid" as const },
        ],
      ]),
    });

    dispatchVisibilityChange("visible");

    const afterState = usePanelStore.getState();
    // Metadata should be cleaned up without any side effects.
    expect(afterState.trashedTerminals.has("orphan-1")).toBe(false);
  });

  it("sweeps only expired entries leaving non-expired intact", () => {
    setTerminals([
      { id: "term-1", title: "T1", cwd: "/t", cols: 80, rows: 24, location: "grid" },
      { id: "term-2", title: "T2", cwd: "/t", cols: 80, rows: 24, location: "grid" },
      { id: "term-3", title: "T3", cwd: "/t", cols: 80, rows: 24, location: "grid" },
    ]);

    const { trashPanel } = usePanelStore.getState();
    trashPanel("term-1");
    trashPanel("term-2");
    trashPanel("term-3");

    const state = usePanelStore.getState();
    const now = Date.now();
    const mixed = new Map(state.trashedTerminals);
    // term-1 expired, term-2 expired, term-3 still valid
    const info1 = mixed.get("term-1")!;
    const info2 = mixed.get("term-2")!;
    mixed.set("term-1", { ...info1, expiresAt: now - 1 });
    mixed.set("term-2", { ...info2, expiresAt: now - 1 });
    usePanelStore.setState({ trashedTerminals: mixed });

    dispatchVisibilityChange("visible");

    const afterState = usePanelStore.getState();
    expect(afterState.trashedTerminals.has("term-1")).toBe(false);
    expect(afterState.trashedTerminals.has("term-2")).toBe(false);
    expect(afterState.trashedTerminals.has("term-3")).toBe(true);
    expect(afterState.panelsById["term-3"]?.location).toBe("trash");
  });
});

describe("trashPanelGroup anchor-removal regression (#8944)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const { reset } = usePanelStore.getState();
    reset();
    usePanelStore.setState({
      panelsById: {},
      panelIds: [],
      tabGroups: new Map(),
      trashedTerminals: new Map(),
      backgroundedTerminals: new Map(),
      focusedId: null,
      maximizedId: null,
      commandQueue: [],
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function makeTerm(id: string, location: "grid" | "dock" = "grid"): MockTerminal {
    return { id, title: `Shell ${id}`, cwd: "/test", cols: 80, rows: 24, location };
  }

  it("replicates groupMetadata onto every trashed member", () => {
    const group: TabGroup = {
      id: "group-1",
      panelIds: ["term-1", "term-2", "term-3"],
      activeTabId: "term-2",
      location: "grid",
    };
    setTerminals([makeTerm("term-1"), makeTerm("term-2"), makeTerm("term-3")]);
    usePanelStore.setState({ tabGroups: new Map([["group-1", group]]) });

    usePanelStore.getState().trashPanelGroup("term-1");

    const state = usePanelStore.getState();
    for (const id of ["term-1", "term-2", "term-3"]) {
      const trashed = state.trashedTerminals.get(id)!;
      expect(trashed.groupMetadata).toBeDefined();
      expect(trashed.groupMetadata!.panelIds).toEqual(["term-1", "term-2", "term-3"]);
      expect(trashed.groupMetadata!.activeTabId).toBe("term-2");
    }
  });

  it("preserves order and active tab when the original anchor member is removed before restore", () => {
    const group: TabGroup = {
      id: "group-1",
      panelIds: ["term-1", "term-2", "term-3"],
      activeTabId: "term-2",
      location: "grid",
    };
    setTerminals([makeTerm("term-1"), makeTerm("term-2"), makeTerm("term-3")]);
    usePanelStore.setState({ tabGroups: new Map([["group-1", group]]) });

    usePanelStore.getState().trashPanelGroup("term-1");

    const groupRestoreId = usePanelStore.getState().trashedTerminals.get("term-1")!.groupRestoreId!;

    // Remove the original anchor (first member) from trash + panelsById,
    // simulating expiry / individual deletion / hydration loss.
    usePanelStore.setState((state) => {
      const trashedTerminals = new Map(state.trashedTerminals);
      trashedTerminals.delete("term-1");
      const panelsById = { ...state.panelsById };
      delete panelsById["term-1"];
      return {
        trashedTerminals,
        panelsById,
        panelIds: state.panelIds.filter((id) => id !== "term-1"),
      };
    });

    usePanelStore.getState().restoreTrashedGroup(groupRestoreId);

    const state = usePanelStore.getState();
    expect(state.trashedTerminals.size).toBe(0);
    expect(state.tabGroups.size).toBe(1);

    const restored = [...state.tabGroups.values()][0]!;
    // Order from surviving members preserved (anchor term-1 dropped)
    expect(restored.panelIds).toEqual(["term-2", "term-3"]);
    // Originally-active tab (term-2) survived and is still active
    expect(restored.activeTabId).toBe("term-2");
  });

  it("falls back to first surviving panel when the active tab was the removed anchor", () => {
    const group: TabGroup = {
      id: "group-1",
      panelIds: ["term-1", "term-2", "term-3"],
      activeTabId: "term-1",
      location: "grid",
    };
    setTerminals([makeTerm("term-1"), makeTerm("term-2"), makeTerm("term-3")]);
    usePanelStore.setState({ tabGroups: new Map([["group-1", group]]) });

    usePanelStore.getState().trashPanelGroup("term-1");

    const groupRestoreId = usePanelStore.getState().trashedTerminals.get("term-1")!.groupRestoreId!;

    // Remove term-1 — both the anchor and the active tab.
    usePanelStore.setState((state) => {
      const trashedTerminals = new Map(state.trashedTerminals);
      trashedTerminals.delete("term-1");
      const panelsById = { ...state.panelsById };
      delete panelsById["term-1"];
      return {
        trashedTerminals,
        panelsById,
        panelIds: state.panelIds.filter((id) => id !== "term-1"),
      };
    });

    usePanelStore.getState().restoreTrashedGroup(groupRestoreId);

    const restored = [...usePanelStore.getState().tabGroups.values()][0]!;
    expect(restored.panelIds).toEqual(["term-2", "term-3"]);
    // Active tab term-1 is gone, falls back to first surviving panel in original order
    expect(restored.activeTabId).toBe("term-2");
  });

  it("preserves dock location and worktreeId when the anchor is removed before restore", () => {
    const group: TabGroup = {
      id: "group-1",
      panelIds: ["term-1", "term-2", "term-3"],
      activeTabId: "term-2",
      location: "dock",
      worktreeId: "wt-1",
    };
    setTerminals([
      { ...makeTerm("term-1", "dock"), worktreeId: "wt-1" },
      { ...makeTerm("term-2", "dock"), worktreeId: "wt-1" },
      { ...makeTerm("term-3", "dock"), worktreeId: "wt-1" },
    ]);
    usePanelStore.setState({ tabGroups: new Map([["group-1", group]]) });

    usePanelStore.getState().trashPanelGroup("term-1");

    const groupRestoreId = usePanelStore.getState().trashedTerminals.get("term-1")!.groupRestoreId!;

    usePanelStore.setState((state) => {
      const trashedTerminals = new Map(state.trashedTerminals);
      trashedTerminals.delete("term-1");
      const panelsById = { ...state.panelsById };
      delete panelsById["term-1"];
      return {
        trashedTerminals,
        panelsById,
        panelIds: state.panelIds.filter((id) => id !== "term-1"),
      };
    });

    usePanelStore.getState().restoreTrashedGroup(groupRestoreId);

    const state = usePanelStore.getState();
    const restored = [...state.tabGroups.values()][0]!;
    expect(restored.panelIds).toEqual(["term-2", "term-3"]);
    expect(restored.location).toBe("dock");
    expect(restored.worktreeId).toBe("wt-1");
    for (const id of ["term-2", "term-3"]) {
      expect(state.panelsById[id]!.location).toBe("dock");
      expect(state.panelsById[id]!.worktreeId).toBe("wt-1");
    }
  });

  it("restores a single survivor without recreating a tab group", () => {
    const group: TabGroup = {
      id: "group-1",
      panelIds: ["term-1", "term-2", "term-3"],
      activeTabId: "term-2",
      location: "grid",
    };
    setTerminals([makeTerm("term-1"), makeTerm("term-2"), makeTerm("term-3")]);
    usePanelStore.setState({ tabGroups: new Map([["group-1", group]]) });

    usePanelStore.getState().trashPanelGroup("term-1");

    const groupRestoreId = usePanelStore.getState().trashedTerminals.get("term-1")!.groupRestoreId!;

    // Remove two members including the anchor — only term-3 survives.
    usePanelStore.setState((state) => {
      const trashedTerminals = new Map(state.trashedTerminals);
      trashedTerminals.delete("term-1");
      trashedTerminals.delete("term-2");
      const panelsById = { ...state.panelsById };
      delete panelsById["term-1"];
      delete panelsById["term-2"];
      return {
        trashedTerminals,
        panelsById,
        panelIds: state.panelIds.filter((id) => id === "term-3"),
      };
    });

    usePanelStore.getState().restoreTrashedGroup(groupRestoreId);

    const state = usePanelStore.getState();
    expect(state.trashedTerminals.size).toBe(0);
    expect(state.tabGroups.size).toBe(0);
    expect(state.panelsById["term-3"]!.location).toBe("grid");
  });
});

// Issue #9935: trashing a maximized panel must clear the entire maximize
// trio (maximizedId, maximizeTarget, preMaximizeLayout) — leaving a stale
// `maximizeTarget` strands the next `toggleMaximize` as an unmaximize
// request, and `TerminalContextMenu` reads `maximizeTarget` alone to label
// itself.
describe("trashPanel / trashPanelGroup maximize-state clear (#9935)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const { reset } = usePanelStore.getState();
    reset();
    usePanelStore.setState({
      panelsById: {},
      panelIds: [],
      tabGroups: new Map(),
      trashedTerminals: new Map(),
      backgroundedTerminals: new Map(),
      focusedId: null,
      maximizedId: null,
      maximizeTarget: null,
      preMaximizeLayout: null,
      commandQueue: [],
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("trashPanel clears all three maximize fields when trashing the maximized panel", () => {
    setTerminals([
      { id: "term-1", title: "T1", cwd: "/t", cols: 80, rows: 24, location: "grid" },
      { id: "term-2", title: "T2", cwd: "/t", cols: 80, rows: 24, location: "grid" },
    ]);
    usePanelStore.setState({
      focusedId: "term-1",
      maximizedId: "term-1",
      maximizeTarget: { type: "panel", id: "term-1" },
      preMaximizeLayout: { gridCols: 2, gridItemCount: 2, worktreeId: "worktree-1" },
    });

    usePanelStore.getState().trashPanel("term-1");

    const state = usePanelStore.getState();
    expect(state.maximizedId).toBeNull();
    expect(state.maximizeTarget).toBeNull();
    expect(state.preMaximizeLayout).toBeNull();
  });

  it("trashPanelGroup clears all three maximize fields when the maximized panel is in the group", () => {
    const group: TabGroup = {
      id: "group-1",
      panelIds: ["term-1", "term-2"],
      activeTabId: "term-1",
      location: "grid",
    };
    setTerminals([
      { id: "term-1", title: "T1", cwd: "/t", cols: 80, rows: 24, location: "grid" },
      { id: "term-2", title: "T2", cwd: "/t", cols: 80, rows: 24, location: "grid" },
    ]);
    usePanelStore.setState({
      tabGroups: new Map([["group-1", group]]),
      focusedId: "term-1",
      maximizedId: "term-1",
      maximizeTarget: { type: "group", id: "group-1" },
      preMaximizeLayout: { gridCols: 1, gridItemCount: 1, worktreeId: undefined },
    });

    usePanelStore.getState().trashPanelGroup("term-1");

    const state = usePanelStore.getState();
    expect(state.maximizedId).toBeNull();
    expect(state.maximizeTarget).toBeNull();
    expect(state.preMaximizeLayout).toBeNull();
  });

  it("trashPanel leaves the maximize trio untouched when trashing a non-maximized panel", () => {
    setTerminals([
      { id: "term-1", title: "T1", cwd: "/t", cols: 80, rows: 24, location: "grid" },
      { id: "term-2", title: "T2", cwd: "/t", cols: 80, rows: 24, location: "grid" },
    ]);
    usePanelStore.setState({
      focusedId: "term-2",
      maximizedId: "term-2",
      maximizeTarget: { type: "panel", id: "term-2" },
      preMaximizeLayout: { gridCols: 2, gridItemCount: 2, worktreeId: "worktree-1" },
    });

    usePanelStore.getState().trashPanel("term-1");

    const state = usePanelStore.getState();
    // term-2 is still maximized — the trash of an unrelated panel must
    // not touch its maximize state.
    expect(state.maximizedId).toBe("term-2");
    expect(state.maximizeTarget).toEqual({ type: "panel", id: "term-2" });
    expect(state.preMaximizeLayout).toEqual({
      gridCols: 2,
      gridItemCount: 2,
      worktreeId: "worktree-1",
    });
  });
});

/**
 * Tests for restoring a trashed DOCK panel reopening the dock popover (#9938).
 *
 * The panelStore wrappers `restoreTerminal` / `restoreTrashedGroup` used to
 * hardcode `activeDockTerminalId: null` while setting `focusedId` to the
 * restored panel. When the panel was originally docked it landed back in the
 * dock but the popover stayed closed, so focus pointed at an invisible panel
 * and focus-relative shortcuts silently targeted it. The wrappers now derive
 * `activeDockTerminalId` from the restored panel's `location`, and guard the
 * no-op case (id absent after the registry call) so focus is never moved onto
 * a panel that doesn't exist.
 */
describe("restore trashed dock focus (#9938)", () => {
  function makeTerm(id: string, location: "grid" | "dock" = "grid"): MockTerminal {
    return { id, title: `Shell ${id}`, cwd: "/test", cols: 80, rows: 24, location };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    const { reset } = usePanelStore.getState();
    reset();
    usePanelStore.setState({
      panelsById: {},
      panelIds: [],
      tabGroups: new Map(),
      trashedTerminals: new Map(),
      backgroundedTerminals: new Map(),
      focusedId: null,
      maximizedId: null,
      activeDockTerminalId: null,
      commandQueue: [],
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("opens the dock popover when a docked terminal is restored", () => {
    setTerminals([makeTerm("term-1", "dock")]);

    usePanelStore.getState().trashPanel("term-1");
    expect(usePanelStore.getState().panelsById["term-1"]?.location).toBe("trash");

    usePanelStore.getState().restoreTerminal("term-1");

    const state = usePanelStore.getState();
    expect(state.panelsById["term-1"]?.location).toBe("dock");
    expect(state.focusedId).toBe("term-1");
    // The restored panel is back in the dock — the popover must point at it so
    // focus and the visible panel agree.
    expect(state.activeDockTerminalId).toBe("term-1");
    expect(state.activeDockTerminalId).toBe(state.focusedId);
  });

  it("leaves the dock closed when a grid terminal is restored", () => {
    setTerminals([makeTerm("term-1", "grid")]);

    usePanelStore.getState().trashPanel("term-1");
    usePanelStore.getState().restoreTerminal("term-1");

    const state = usePanelStore.getState();
    expect(state.panelsById["term-1"]?.location).toBe("grid");
    expect(state.focusedId).toBe("term-1");
    expect(state.activeDockTerminalId).toBeNull();
  });

  it("does not dismiss an unrelated open dock when a grid terminal is restored", () => {
    setTerminals([makeTerm("term-1", "grid"), makeTerm("other-dock", "dock")]);
    usePanelStore.setState({ activeDockTerminalId: "other-dock", focusedId: "other-dock" });

    usePanelStore.getState().trashPanel("term-1");
    usePanelStore.getState().restoreTerminal("term-1");

    const state = usePanelStore.getState();
    // Restoring a grid terminal moves focus but must not close a dock session
    // belonging to a different panel.
    expect(state.focusedId).toBe("term-1");
    expect(state.activeDockTerminalId).toBe("other-dock");
  });

  it("does not move focus when restoring a missing terminal (no-op)", () => {
    setTerminals([makeTerm("visible-dock", "dock")]);
    usePanelStore.setState({ focusedId: "visible-dock", activeDockTerminalId: "visible-dock" });

    usePanelStore.getState().restoreTerminal("ghost");

    const state = usePanelStore.getState();
    // The no-op restore must not retarget focus or close the open dock panel.
    expect(state.focusedId).toBe("visible-dock");
    expect(state.activeDockTerminalId).toBe("visible-dock");
  });

  it("opens the dock popover on the active tab when a docked group is restored", () => {
    const group: TabGroup = {
      id: "group-1",
      panelIds: ["term-1", "term-2", "term-3"],
      activeTabId: "term-2",
      location: "dock",
    };
    setTerminals([
      makeTerm("term-1", "dock"),
      makeTerm("term-2", "dock"),
      makeTerm("term-3", "dock"),
    ]);
    usePanelStore.setState({ tabGroups: new Map([["group-1", group]]) });

    usePanelStore.getState().trashPanelGroup("term-1");
    const groupRestoreId = usePanelStore.getState().trashedTerminals.get("term-1")!.groupRestoreId!;

    usePanelStore.getState().restoreTrashedGroup(groupRestoreId);

    const state = usePanelStore.getState();
    expect(state.panelsById["term-2"]?.location).toBe("dock");
    // Focus and the dock popover both land on the originally-active tab.
    expect(state.focusedId).toBe("term-2");
    expect(state.activeDockTerminalId).toBe("term-2");
  });

  it("falls back to a surviving member when the preferred tab was pruned", () => {
    const group: TabGroup = {
      id: "group-1",
      panelIds: ["term-1", "term-2", "term-3"],
      activeTabId: "term-1",
      location: "dock",
    };
    setTerminals([
      makeTerm("term-1", "dock"),
      makeTerm("term-2", "dock"),
      makeTerm("term-3", "dock"),
    ]);
    usePanelStore.setState({ tabGroups: new Map([["group-1", group]]) });

    usePanelStore.getState().trashPanelGroup("term-1");
    const groupRestoreId = usePanelStore.getState().trashedTerminals.get("term-2")!.groupRestoreId!;

    // Simulate the preferred active tab being garbage-collected from panelsById
    // during the trash window while its trash metadata lingers.
    usePanelStore.setState((state) => {
      const panelsById = { ...state.panelsById };
      delete panelsById["term-1"];
      return { panelsById, panelIds: state.panelIds.filter((id) => id !== "term-1") };
    });

    usePanelStore.getState().restoreTrashedGroup(groupRestoreId);

    const state = usePanelStore.getState();
    // Focus and the dock popover land on a surviving member rather than being
    // stranded because the preferred tab is gone.
    expect(state.focusedId).toBe("term-2");
    expect(state.activeDockTerminalId).toBe("term-2");
  });

  it("leaves the dock closed when a grid group is restored", () => {
    const group: TabGroup = {
      id: "group-1",
      panelIds: ["term-1", "term-2"],
      activeTabId: "term-1",
      location: "grid",
    };
    setTerminals([makeTerm("term-1", "grid"), makeTerm("term-2", "grid")]);
    usePanelStore.setState({ tabGroups: new Map([["group-1", group]]) });

    usePanelStore.getState().trashPanelGroup("term-1");
    const groupRestoreId = usePanelStore.getState().trashedTerminals.get("term-1")!.groupRestoreId!;

    usePanelStore.getState().restoreTrashedGroup(groupRestoreId);

    const state = usePanelStore.getState();
    expect(state.focusedId).toBe("term-1");
    expect(state.activeDockTerminalId).toBeNull();
  });
});
