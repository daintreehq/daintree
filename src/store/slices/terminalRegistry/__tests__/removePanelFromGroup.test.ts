/**
 * Tests for removePanelFromGroup behavior
 * Issue #1861: Ensure group is deleted when ≤1 panel remains
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { TabGroup } from "@/types";

const mockProjectClient = {
  getTerminals: vi.fn().mockResolvedValue([]),
  setTerminals: vi.fn().mockResolvedValue(undefined),
  setTabGroups: vi.fn().mockResolvedValue(undefined),
};

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
  projectClient: mockProjectClient,
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    destroy: vi.fn(),
  },
}));

vi.mock("../../../persistence/terminalPersistence", () => ({
  terminalPersistence: {
    save: vi.fn(),
    saveTabGroups: vi.fn(),
    load: vi.fn().mockReturnValue([]),
  },
}));

const { useTerminalStore } = await import("../../../terminalStore");
const { terminalPersistence } = await import("../../../persistence/terminalPersistence");

describe("removePanelFromGroup", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    const { reset } = useTerminalStore.getState();
    await reset();
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

  it("should delete group when removing leaves exactly 1 panel", () => {
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

    const { removePanelFromGroup } = useTerminalStore.getState();
    removePanelFromGroup("term-1");

    const state = useTerminalStore.getState();
    expect(state.tabGroups.has("group-1")).toBe(false);
  });

  it("should delete group when removing leaves 0 panels", () => {
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

    const { removePanelFromGroup } = useTerminalStore.getState();
    removePanelFromGroup("term-1");

    const state = useTerminalStore.getState();
    expect(state.tabGroups.has("group-1")).toBe(false);
  });

  it("should keep group when removing leaves 2+ panels", () => {
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

    const { removePanelFromGroup } = useTerminalStore.getState();
    removePanelFromGroup("term-1");

    const state = useTerminalStore.getState();
    expect(state.tabGroups.has("group-1")).toBe(true);
    expect(state.tabGroups.get("group-1")?.panelIds).toEqual(["term-2", "term-3"]);
  });

  it("should update activeTabId when active panel is removed", () => {
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

    const { removePanelFromGroup } = useTerminalStore.getState();
    removePanelFromGroup("term-1");

    const state = useTerminalStore.getState();
    const updatedGroup = state.tabGroups.get("group-1");
    expect(updatedGroup?.activeTabId).toBe("term-2");
  });

  it("should keep activeTabId unchanged when non-active panel is removed", () => {
    const group: TabGroup = {
      id: "group-1",
      panelIds: ["term-1", "term-2", "term-3"],
      activeTabId: "term-2",
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

    const { removePanelFromGroup } = useTerminalStore.getState();
    removePanelFromGroup("term-1");

    const state = useTerminalStore.getState();
    const updatedGroup = state.tabGroups.get("group-1");
    expect(updatedGroup?.activeTabId).toBe("term-2");
  });

  it("should be a no-op when panel is not in any group", () => {
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

    const { removePanelFromGroup } = useTerminalStore.getState();
    removePanelFromGroup("term-1");

    const state = useTerminalStore.getState();
    expect(state.tabGroups.size).toBe(0);
  });

  it("should only affect the group containing the panel", () => {
    const group1: TabGroup = {
      id: "group-1",
      panelIds: ["term-1", "term-2"],
      activeTabId: "term-1",
      location: "grid",
    };

    const group2: TabGroup = {
      id: "group-2",
      panelIds: ["term-3", "term-4", "term-5"],
      activeTabId: "term-3",
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
          location: "dock",
        },
        {
          id: "term-4",
          type: "terminal",
          title: "Shell 4",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "dock",
        },
        {
          id: "term-5",
          type: "terminal",
          title: "Shell 5",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "dock",
        },
      ],
      tabGroups: new Map([
        ["group-1", group1],
        ["group-2", group2],
      ]),
    });

    const { removePanelFromGroup } = useTerminalStore.getState();
    removePanelFromGroup("term-1");

    const state = useTerminalStore.getState();
    // group-1 should be deleted (was 2 panels, now 1)
    expect(state.tabGroups.has("group-1")).toBe(false);
    // group-2 should be unchanged
    expect(state.tabGroups.has("group-2")).toBe(true);
    expect(state.tabGroups.get("group-2")?.panelIds).toEqual(["term-3", "term-4", "term-5"]);
  });

  it("should handle dock groups correctly", () => {
    const group: TabGroup = {
      id: "group-1",
      panelIds: ["term-1", "term-2", "term-3"],
      activeTabId: "term-1",
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

    const { removePanelFromGroup } = useTerminalStore.getState();
    removePanelFromGroup("term-2");

    const state = useTerminalStore.getState();
    const updatedGroup = state.tabGroups.get("group-1");
    expect(updatedGroup?.panelIds).toEqual(["term-1", "term-3"]);
    expect(updatedGroup?.location).toBe("dock");
  });

  it("should persist changes via saveTabGroups when group is deleted", async () => {
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

    const { removePanelFromGroup } = useTerminalStore.getState();
    removePanelFromGroup("term-1");

    // Should call saveTabGroups (which triggers persistence)
    expect(terminalPersistence.saveTabGroups).toHaveBeenCalled();
  });

  it("should persist changes via saveTabGroups when group is updated", async () => {
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

    const { removePanelFromGroup } = useTerminalStore.getState();
    removePanelFromGroup("term-1");

    // Should call saveTabGroups (which triggers persistence)
    expect(terminalPersistence.saveTabGroups).toHaveBeenCalled();
  });

  it("should preserve worktreeId when group survives removal", () => {
    const group: TabGroup = {
      id: "group-1",
      panelIds: ["term-1", "term-2", "term-3"],
      activeTabId: "term-1",
      location: "grid",
      worktreeId: "wt-123",
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
          worktreeId: "wt-123",
        },
        {
          id: "term-2",
          type: "terminal",
          title: "Shell 2",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
          worktreeId: "wt-123",
        },
        {
          id: "term-3",
          type: "terminal",
          title: "Shell 3",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
          worktreeId: "wt-123",
        },
      ],
      tabGroups: new Map([["group-1", group]]),
    });

    const { removePanelFromGroup } = useTerminalStore.getState();
    removePanelFromGroup("term-1");

    const state = useTerminalStore.getState();
    const updatedGroup = state.tabGroups.get("group-1");
    expect(updatedGroup?.worktreeId).toBe("wt-123");
  });
});
