/**
 * Tests for trashTerminal auto-removing panels from tab groups
 * Issue #1848: trashTerminal should auto-remove panel from tab group at store level
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

describe("trashTerminal group cleanup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const { reset } = useTerminalStore.getState();
    reset();
    useTerminalStore.setState({
      terminals: [],
      tabGroups: new Map(),
      trashedTerminals: new Map(),
      focusedId: null,
      maximizedId: null,
      commandQueue: [],
      activeTabByGroup: new Map(),
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

    useTerminalStore.setState({
      terminals: [
        {
          id: "term-1",
          type: "terminal",
          title: "Shell 1",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
        {
          id: "term-2",
          type: "terminal",
          title: "Shell 2",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
        {
          id: "term-3",
          type: "terminal",
          title: "Shell 3",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      ],
      tabGroups: new Map([["group-1", group]]),
      focusedId: "term-1",
    });

    const { trashTerminal } = useTerminalStore.getState();
    trashTerminal("term-1");

    const state = useTerminalStore.getState();
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

    useTerminalStore.setState({
      terminals: [
        {
          id: "term-1",
          type: "terminal",
          title: "Shell 1",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
        {
          id: "term-2",
          type: "terminal",
          title: "Shell 2",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
        {
          id: "term-3",
          type: "terminal",
          title: "Shell 3",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      ],
      tabGroups: new Map([["group-1", group]]),
    });

    const { trashTerminal } = useTerminalStore.getState();
    trashTerminal("term-1");

    const state = useTerminalStore.getState();
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

    useTerminalStore.setState({
      terminals: [
        {
          id: "term-1",
          type: "terminal",
          title: "Shell 1",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
        {
          id: "term-2",
          type: "terminal",
          title: "Shell 2",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      ],
      tabGroups: new Map([["group-1", group]]),
    });

    const { trashTerminal } = useTerminalStore.getState();
    trashTerminal("term-1");

    const state = useTerminalStore.getState();
    expect(state.tabGroups.has("group-1")).toBe(false);
  });

  it("should delete group when trashing last panel", () => {
    const group: TabGroup = {
      id: "group-1",
      panelIds: ["term-1"],
      activeTabId: "term-1",
      location: "grid",
    };

    useTerminalStore.setState({
      terminals: [
        {
          id: "term-1",
          type: "terminal",
          title: "Shell 1",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      ],
      tabGroups: new Map([["group-1", group]]),
    });

    const { trashTerminal } = useTerminalStore.getState();
    trashTerminal("term-1");

    const state = useTerminalStore.getState();
    expect(state.tabGroups.has("group-1")).toBe(false);
  });

  it("should not affect panels not in any group", () => {
    useTerminalStore.setState({
      terminals: [
        {
          id: "term-1",
          type: "terminal",
          title: "Shell 1",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      ],
      tabGroups: new Map(),
    });

    const { trashTerminal } = useTerminalStore.getState();
    trashTerminal("term-1");

    const state = useTerminalStore.getState();
    expect(state.tabGroups.size).toBe(0);
    expect(state.terminals.find((t) => t.id === "term-1")?.location).toBe("trash");
  });

  it("should handle dock groups correctly", () => {
    const group: TabGroup = {
      id: "group-1",
      panelIds: ["term-1", "term-2", "term-3"],
      activeTabId: "term-2",
      location: "dock",
    };

    useTerminalStore.setState({
      terminals: [
        {
          id: "term-1",
          type: "terminal",
          title: "Shell 1",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "dock",
        },
        {
          id: "term-2",
          type: "terminal",
          title: "Shell 2",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "dock",
        },
        {
          id: "term-3",
          type: "terminal",
          title: "Shell 3",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "dock",
        },
      ],
      tabGroups: new Map([["group-1", group]]),
    });

    const { trashTerminal } = useTerminalStore.getState();
    trashTerminal("term-1");

    const state = useTerminalStore.getState();
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

    useTerminalStore.setState({
      terminals: [
        {
          id: "term-1",
          type: "terminal",
          title: "Shell 1",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
        {
          id: "term-2",
          type: "terminal",
          title: "Shell 2",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
        {
          id: "term-3",
          type: "terminal",
          title: "Shell 3",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      ],
      tabGroups: new Map([["group-1", group]]),
    });

    const { trashTerminal } = useTerminalStore.getState();
    trashTerminal("term-2");

    const state = useTerminalStore.getState();
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

    useTerminalStore.setState({
      terminals: [
        {
          id: "term-1",
          type: "terminal",
          title: "Shell 1",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
        {
          id: "term-2",
          type: "terminal",
          title: "Shell 2",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      ],
      tabGroups: new Map([["group-1", group]]),
    });

    const { trashTerminal } = useTerminalStore.getState();
    trashTerminal("term-1");

    const state = useTerminalStore.getState();
    // Both should be updated atomically
    expect(state.terminals.find((t) => t.id === "term-1")?.location).toBe("trash");
    expect(state.tabGroups.has("group-1")).toBe(false);
  });
});
