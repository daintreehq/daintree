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

  it("should remove panel from tab group when trashed", () => {
    const group: TabGroup = {
      id: "group-1",
      panelIds: ["term-1", "term-2", "term-3"],
      activeTabId: "term-1",
      location: "grid",
    };

    const terminals: MockTerminal[] = [
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
    ];
    setTerminals(terminals);
    usePanelStore.setState({
      tabGroups: new Map([["group-1", group]]),
      focusedId: "term-1",
    });

    const { trashPanel } = usePanelStore.getState();
    trashPanel("term-1");

    const state = usePanelStore.getState();
    const updatedGroup = state.tabGroups.get("group-1");
    expect(updatedGroup).toBeDefined();
    expect(updatedGroup?.panelIds).not.toContain("term-1");
    expect(updatedGroup?.panelIds).toEqual(["term-2", "term-3"]);
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

  it("should delete group when trashing leaves 1 panel", () => {
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
    expect(state.tabGroups.has("group-1")).toBe(false);
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

  it("should handle dock groups correctly", () => {
    const group: TabGroup = {
      id: "group-1",
      panelIds: ["term-1", "term-2", "term-3"],
      activeTabId: "term-2",
      location: "dock",
    };

    setTerminals([
      {
        id: "term-1",
        title: "Shell 1",
        cwd: "/test",
        cols: 80,
        rows: 24,
        location: "dock",
      },
      {
        id: "term-2",
        title: "Shell 2",
        cwd: "/test",
        cols: 80,
        rows: 24,
        location: "dock",
      },
      {
        id: "term-3",
        title: "Shell 3",
        cwd: "/test",
        cols: 80,
        rows: 24,
        location: "dock",
      },
    ]);
    usePanelStore.setState({ tabGroups: new Map([["group-1", group]]) });

    const { trashPanel } = usePanelStore.getState();
    trashPanel("term-1");

    const state = usePanelStore.getState();
    const updatedGroup = state.tabGroups.get("group-1");
    expect(updatedGroup?.panelIds).toEqual(["term-2", "term-3"]);
    expect(updatedGroup?.activeTabId).toBe("term-2");
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

  it("should handle empty trashedTerminals map safely", () => {
    dispatchVisibilityChange("hidden");
    dispatchVisibilityChange("visible");
    // Should not throw
    expect(usePanelStore.getState().trashedTerminals.size).toBe(0);
  });

  it("should clean up multiple expired entries", () => {
    setTerminals([
      { id: "term-1", title: "T1", cwd: "/t", cols: 80, rows: 24, location: "grid" },
      { id: "term-2", title: "T2", cwd: "/t", cols: 80, rows: 24, location: "grid" },
      { id: "term-3", title: "T3", cwd: "/t", cols: 80, rows: 24, location: "grid" },
    ]);

    const { trashPanel } = usePanelStore.getState();
    trashPanel("term-1");
    trashPanel("term-2");
    trashPanel("term-3");

    // All expired
    const state = usePanelStore.getState();
    const now = Date.now();
    const newTrashed = new Map(state.trashedTerminals);
    for (const [id, info] of newTrashed) {
      newTrashed.set(id, { ...info, expiresAt: now - 1 });
    }
    usePanelStore.setState({ trashedTerminals: newTrashed });

    dispatchVisibilityChange("visible");

    const afterState = usePanelStore.getState();
    expect(afterState.trashedTerminals.size).toBe(0);
    expect(afterState.panelIds).toEqual([]);
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
