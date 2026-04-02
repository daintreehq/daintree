/**
 * Tests for background system preserving tab group structure
 * Issue #4843: Backgrounding grouped panel permanently loses tab group structure
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { TabGroup } from "@/types";

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
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
    applyRendererPolicy: vi.fn(),
  },
}));

const { useTerminalStore } = await import("../../../terminalStore");

function makeTerminal(id: string, location: "grid" | "dock" = "grid") {
  return {
    id,
    type: "terminal" as const,
    title: `Shell ${id}`,
    cwd: "/test",
    cols: 80,
    rows: 24,
    location,
  };
}

describe("backgroundTerminal group metadata", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const { reset } = useTerminalStore.getState();
    reset();
    useTerminalStore.setState({
      terminals: [],
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

  it("should save groupRestoreId and groupMetadata when backgrounding a grouped panel", () => {
    const group: TabGroup = {
      id: "group-1",
      panelIds: ["t1", "t2", "t3"],
      activeTabId: "t1",
      location: "grid",
    };

    useTerminalStore.setState({
      terminals: [makeTerminal("t1"), makeTerminal("t2"), makeTerminal("t3")],
      tabGroups: new Map([["group-1", group]]),
    });

    useTerminalStore.getState().backgroundTerminal("t1");

    const state = useTerminalStore.getState();
    const bgInfo = state.backgroundedTerminals.get("t1");
    expect(bgInfo).toBeDefined();
    expect(bgInfo!.groupRestoreId).toBeDefined();
    expect(bgInfo!.groupMetadata).toBeDefined();
    expect(bgInfo!.groupMetadata!.panelIds).toEqual(["t1", "t2", "t3"]);
    expect(bgInfo!.groupMetadata!.activeTabId).toBe("t1");
    expect(bgInfo!.groupMetadata!.location).toBe("grid");
  });

  it("should not save group metadata for ungrouped panels", () => {
    useTerminalStore.setState({
      terminals: [makeTerminal("t1")],
      tabGroups: new Map(),
    });

    useTerminalStore.getState().backgroundTerminal("t1");

    const bgInfo = useTerminalStore.getState().backgroundedTerminals.get("t1");
    expect(bgInfo).toBeDefined();
    expect(bgInfo!.groupRestoreId).toBeUndefined();
    expect(bgInfo!.groupMetadata).toBeUndefined();
  });

  it("should dissolve group correctly when backgrounding one panel from a 3-panel group", () => {
    const group: TabGroup = {
      id: "group-1",
      panelIds: ["t1", "t2", "t3"],
      activeTabId: "t2",
      location: "grid",
    };

    useTerminalStore.setState({
      terminals: [makeTerminal("t1"), makeTerminal("t2"), makeTerminal("t3")],
      tabGroups: new Map([["group-1", group]]),
    });

    useTerminalStore.getState().backgroundTerminal("t1");

    const state = useTerminalStore.getState();
    const updatedGroup = state.tabGroups.get("group-1");
    expect(updatedGroup).toBeDefined();
    expect(updatedGroup!.panelIds).toEqual(["t2", "t3"]);
    expect(updatedGroup!.activeTabId).toBe("t2");
  });
});

describe("backgroundPanelGroup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const { reset } = useTerminalStore.getState();
    reset();
    useTerminalStore.setState({
      terminals: [],
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

  it("should background all panels in a group atomically", () => {
    const group: TabGroup = {
      id: "group-1",
      panelIds: ["t1", "t2", "t3"],
      activeTabId: "t2",
      location: "grid",
    };

    useTerminalStore.setState({
      terminals: [makeTerminal("t1"), makeTerminal("t2"), makeTerminal("t3")],
      tabGroups: new Map([["group-1", group]]),
    });

    useTerminalStore.getState().backgroundPanelGroup("t1");

    const state = useTerminalStore.getState();

    // All panels should be backgrounded
    expect(state.terminals.find((t) => t.id === "t1")!.location).toBe("background");
    expect(state.terminals.find((t) => t.id === "t2")!.location).toBe("background");
    expect(state.terminals.find((t) => t.id === "t3")!.location).toBe("background");

    // All should have same groupRestoreId
    const bg1 = state.backgroundedTerminals.get("t1")!;
    const bg2 = state.backgroundedTerminals.get("t2")!;
    const bg3 = state.backgroundedTerminals.get("t3")!;
    expect(bg1.groupRestoreId).toBeDefined();
    expect(bg1.groupRestoreId).toBe(bg2.groupRestoreId);
    expect(bg2.groupRestoreId).toBe(bg3.groupRestoreId);

    // Only anchor (first) gets groupMetadata
    expect(bg1.groupMetadata).toBeDefined();
    expect(bg1.groupMetadata!.panelIds).toEqual(["t1", "t2", "t3"]);
    expect(bg1.groupMetadata!.activeTabId).toBe("t2");
    expect(bg2.groupMetadata).toBeUndefined();
    expect(bg3.groupMetadata).toBeUndefined();

    // Tab group should be deleted
    expect(state.tabGroups.has("group-1")).toBe(false);
  });

  it("should fall back to backgroundTerminal when panel is not in a group", () => {
    useTerminalStore.setState({
      terminals: [makeTerminal("t1")],
      tabGroups: new Map(),
    });

    useTerminalStore.getState().backgroundPanelGroup("t1");

    const state = useTerminalStore.getState();
    expect(state.terminals.find((t) => t.id === "t1")!.location).toBe("background");
    expect(state.backgroundedTerminals.has("t1")).toBe(true);
  });
});

describe("restoreBackgroundGroup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const { reset } = useTerminalStore.getState();
    reset();
    useTerminalStore.setState({
      terminals: [],
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

  it("should reconstruct the tab group with correct order and active tab", () => {
    const groupRestoreId = "group-test-123";

    useTerminalStore.setState({
      terminals: [
        { ...makeTerminal("t1"), location: "background" as const },
        { ...makeTerminal("t2"), location: "background" as const },
        { ...makeTerminal("t3"), location: "background" as const },
      ],
      backgroundedTerminals: new Map([
        [
          "t1",
          {
            id: "t1",
            originalLocation: "grid" as const,
            groupRestoreId,
            groupMetadata: {
              panelIds: ["t1", "t2", "t3"],
              activeTabId: "t2",
              location: "grid" as const,
              worktreeId: null,
            },
          },
        ],
        ["t2", { id: "t2", originalLocation: "grid" as const, groupRestoreId }],
        ["t3", { id: "t3", originalLocation: "grid" as const, groupRestoreId }],
      ]),
    });

    useTerminalStore.getState().restoreBackgroundGroup(groupRestoreId);

    const state = useTerminalStore.getState();

    // All panels restored
    expect(state.terminals.find((t) => t.id === "t1")!.location).toBe("grid");
    expect(state.terminals.find((t) => t.id === "t2")!.location).toBe("grid");
    expect(state.terminals.find((t) => t.id === "t3")!.location).toBe("grid");

    // Backgrounded entries cleared
    expect(state.backgroundedTerminals.size).toBe(0);

    // Tab group recreated
    expect(state.tabGroups.size).toBe(1);
    const group = [...state.tabGroups.values()][0];
    expect(group.panelIds).toEqual(["t1", "t2", "t3"]);
    expect(group.activeTabId).toBe("t2");
    expect(group.location).toBe("grid");
  });

  it("should filter out panels that no longer exist", () => {
    const groupRestoreId = "group-test-456";

    // t2 was removed while backgrounded
    useTerminalStore.setState({
      terminals: [
        { ...makeTerminal("t1"), location: "background" as const },
        { ...makeTerminal("t3"), location: "background" as const },
      ],
      backgroundedTerminals: new Map([
        [
          "t1",
          {
            id: "t1",
            originalLocation: "grid" as const,
            groupRestoreId,
            groupMetadata: {
              panelIds: ["t1", "t2", "t3"],
              activeTabId: "t2",
              location: "grid" as const,
              worktreeId: null,
            },
          },
        ],
        ["t3", { id: "t3", originalLocation: "grid" as const, groupRestoreId }],
      ]),
    });

    useTerminalStore.getState().restoreBackgroundGroup(groupRestoreId);

    const state = useTerminalStore.getState();
    expect(state.tabGroups.size).toBe(1);
    const group = [...state.tabGroups.values()][0];
    // t2 should be filtered out
    expect(group.panelIds).toEqual(["t1", "t3"]);
    // activeTabId falls back since t2 is gone
    expect(group.activeTabId).toBe("t1");
  });

  it("should be a no-op when groupRestoreId is not found", () => {
    useTerminalStore.setState({
      terminals: [makeTerminal("t1")],
      backgroundedTerminals: new Map(),
    });

    useTerminalStore.getState().restoreBackgroundGroup("nonexistent");

    const state = useTerminalStore.getState();
    expect(state.tabGroups.size).toBe(0);
  });
});

describe("restoreBackgroundTerminal with groupRestoreId", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const { reset } = useTerminalStore.getState();
    reset();
    useTerminalStore.setState({
      terminals: [],
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

  it("should delegate to restoreBackgroundGroup when panel has groupRestoreId", () => {
    const groupRestoreId = "group-test-789";

    useTerminalStore.setState({
      terminals: [
        { ...makeTerminal("t1"), location: "background" as const },
        { ...makeTerminal("t2"), location: "background" as const },
      ],
      backgroundedTerminals: new Map([
        [
          "t1",
          {
            id: "t1",
            originalLocation: "grid" as const,
            groupRestoreId,
            groupMetadata: {
              panelIds: ["t1", "t2"],
              activeTabId: "t1",
              location: "grid" as const,
              worktreeId: null,
            },
          },
        ],
        ["t2", { id: "t2", originalLocation: "grid" as const, groupRestoreId }],
      ]),
    });

    // Restore via single-panel API — should restore the whole group
    useTerminalStore.getState().restoreBackgroundTerminal("t1");

    const state = useTerminalStore.getState();
    expect(state.terminals.find((t) => t.id === "t1")!.location).toBe("grid");
    expect(state.terminals.find((t) => t.id === "t2")!.location).toBe("grid");
    expect(state.backgroundedTerminals.size).toBe(0);
    expect(state.tabGroups.size).toBe(1);
  });

  it("should restore standalone panel without group reconstruction", () => {
    useTerminalStore.setState({
      terminals: [{ ...makeTerminal("t1"), location: "background" as const }],
      backgroundedTerminals: new Map([["t1", { id: "t1", originalLocation: "dock" as const }]]),
    });

    useTerminalStore.getState().restoreBackgroundTerminal("t1");

    const state = useTerminalStore.getState();
    expect(state.terminals.find((t) => t.id === "t1")!.location).toBe("dock");
    expect(state.backgroundedTerminals.size).toBe(0);
    expect(state.tabGroups.size).toBe(0);
  });
});

describe("round-trip: backgroundPanelGroup → restoreBackgroundGroup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const { reset } = useTerminalStore.getState();
    reset();
    useTerminalStore.setState({
      terminals: [],
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

  it("should fully reconstruct the group after background and restore", () => {
    const group: TabGroup = {
      id: "group-1",
      panelIds: ["t1", "t2", "t3"],
      activeTabId: "t2",
      location: "dock",
      worktreeId: "wt-1",
    };

    useTerminalStore.setState({
      terminals: [
        { ...makeTerminal("t1", "dock"), worktreeId: "wt-1" },
        { ...makeTerminal("t2", "dock"), worktreeId: "wt-1" },
        { ...makeTerminal("t3", "dock"), worktreeId: "wt-1" },
      ],
      tabGroups: new Map([["group-1", group]]),
    });

    // Background the group
    useTerminalStore.getState().backgroundPanelGroup("t1");

    let state = useTerminalStore.getState();
    expect(state.tabGroups.size).toBe(0);
    expect(state.backgroundedTerminals.size).toBe(3);

    // Get the groupRestoreId
    const groupRestoreId = state.backgroundedTerminals.get("t1")!.groupRestoreId!;

    // Restore the group
    useTerminalStore.getState().restoreBackgroundGroup(groupRestoreId);

    state = useTerminalStore.getState();
    expect(state.backgroundedTerminals.size).toBe(0);
    expect(state.tabGroups.size).toBe(1);

    const restoredGroup = [...state.tabGroups.values()][0];
    expect(restoredGroup.panelIds).toEqual(["t1", "t2", "t3"]);
    expect(restoredGroup.activeTabId).toBe("t2");
    expect(restoredGroup.location).toBe("dock");
    expect(restoredGroup.worktreeId).toBe("wt-1");

    // All panels restored to dock with correct worktreeId
    for (const id of ["t1", "t2", "t3"]) {
      const t = state.terminals.find((t) => t.id === id)!;
      expect(t.location).toBe("dock");
      expect(t.worktreeId).toBe("wt-1");
    }
  });
});
