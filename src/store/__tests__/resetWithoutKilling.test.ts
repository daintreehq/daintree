/**
 * Tests for resetWithoutKilling behavior
 * Issue #1861: Ensure tabGroups and activeTabByGroup are cleared on project switch
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { TabGroup } from "@/types";

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
    destroy: vi.fn(),
    setVisible: vi.fn(),
    suppressResizesDuringProjectSwitch: vi.fn(),
    detachForProjectSwitch: vi.fn(),
  },
}));

const { useTerminalStore } = await import("../terminalStore");
const { terminalInstanceService } = await import("@/services/TerminalInstanceService");
const { terminalClient } = await import("@/clients");

describe("resetWithoutKilling", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
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
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("should clear tabGroups", async () => {
    const group1: TabGroup = {
      id: "group-1",
      panelIds: ["term-1", "term-2"],
      activeTabId: "term-1",
      location: "grid",
    };

    const group2: TabGroup = {
      id: "group-2",
      panelIds: ["term-3", "term-4"],
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
      ],
      tabGroups: new Map([
        ["group-1", group1],
        ["group-2", group2],
      ]),
    });

    expect(useTerminalStore.getState().tabGroups.size).toBe(2);

    await useTerminalStore.getState().resetWithoutKilling();

    const state = useTerminalStore.getState();
    expect(state.tabGroups.size).toBe(0);
  });

  it("should clear activeTabByGroup", async () => {
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
      tabGroups: new Map([
        [
          "group-1",
          {
            id: "group-1",
            panelIds: ["term-1", "term-2"],
            activeTabId: "term-2",
            location: "grid",
          },
        ],
      ]),
      activeTabByGroup: new Map([
        ["group-1", "term-2"],
        ["group-2", "term-4"],
      ]),
    });

    expect(useTerminalStore.getState().activeTabByGroup.size).toBe(2);

    await useTerminalStore.getState().resetWithoutKilling();

    const state = useTerminalStore.getState();
    expect(state.activeTabByGroup.size).toBe(0);
  });

  it("should clear terminals array", async () => {
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
      tabGroups: new Map(),
    });

    expect(useTerminalStore.getState().terminals.length).toBe(2);

    await useTerminalStore.getState().resetWithoutKilling();

    const state = useTerminalStore.getState();
    expect(state.terminals.length).toBe(0);
  });

  it("should NOT kill backend processes", async () => {
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
      tabGroups: new Map(),
    });

    await useTerminalStore.getState().resetWithoutKilling();

    // Should NOT call terminalClient.kill for any terminal
    expect(terminalClient.kill).not.toHaveBeenCalled();
  });

  it("should detach xterm.js instances instead of destroying them", async () => {
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
      tabGroups: new Map(),
    });

    await useTerminalStore.getState().resetWithoutKilling();

    // Should detach xterm.js instances (keep alive) instead of destroying
    expect(terminalInstanceService.detachForProjectSwitch).toHaveBeenCalledWith("term-1");
    expect(terminalInstanceService.detachForProjectSwitch).toHaveBeenCalledWith("term-2");
    expect(terminalInstanceService.destroy).not.toHaveBeenCalled();
  });

  it("suppresses terminal resizes for the full project-switch window", async () => {
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
      tabGroups: new Map(),
    });

    await useTerminalStore.getState().resetWithoutKilling();

    expect(terminalInstanceService.suppressResizesDuringProjectSwitch).toHaveBeenCalledWith(
      ["term-1", "term-2"],
      10_000
    );
  });

  it("detaches all terminal instances during project switch regardless of preserve list", async () => {
    useTerminalStore.setState({
      terminals: [
        {
          id: "term-keep",
          type: "terminal",
          title: "Keep",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
        {
          id: "term-drop",
          type: "terminal",
          title: "Drop",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      ],
      tabGroups: new Map(),
    });

    await useTerminalStore.getState().resetWithoutKilling({
      preserveTerminalIds: new Set(["term-keep"]),
    });

    // All terminals should be detached (kept alive), none destroyed
    expect(terminalInstanceService.detachForProjectSwitch).toHaveBeenCalledWith("term-keep");
    expect(terminalInstanceService.detachForProjectSwitch).toHaveBeenCalledWith("term-drop");
    expect(terminalInstanceService.destroy).not.toHaveBeenCalled();
  });

  it("should clear trashedTerminals", async () => {
    useTerminalStore.setState({
      terminals: [],
      tabGroups: new Map(),
      trashedTerminals: new Map([
        [
          "term-1",
          {
            id: "term-1",
            expiresAt: Date.now() + 60000,
            originalLocation: "grid" as const,
          },
        ],
        [
          "term-2",
          {
            id: "term-2",
            expiresAt: Date.now() + 60000,
            originalLocation: "dock" as const,
          },
        ],
      ]),
    });

    expect(useTerminalStore.getState().trashedTerminals.size).toBe(2);

    await useTerminalStore.getState().resetWithoutKilling();

    const state = useTerminalStore.getState();
    expect(state.trashedTerminals.size).toBe(0);
  });

  it("should clear focus state", async () => {
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
      focusedId: "term-1",
      maximizedId: "term-1",
      activeDockTerminalId: "term-2",
    });

    await useTerminalStore.getState().resetWithoutKilling();

    const state = useTerminalStore.getState();
    expect(state.focusedId).toBeNull();
    expect(state.maximizedId).toBeNull();
    expect(state.activeDockTerminalId).toBeNull();
  });

  it("should clear command queue", async () => {
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
      commandQueue: [
        {
          id: "cmd-1",
          terminalId: "term-1",
          payload: "echo hello",
          description: "Run echo",
          queuedAt: Date.now(),
          origin: "user" as const,
        },
        {
          id: "cmd-2",
          terminalId: "term-1",
          payload: "ls -la",
          description: "List files",
          queuedAt: Date.now(),
          origin: "user" as const,
        },
      ],
    });

    await useTerminalStore.getState().resetWithoutKilling();

    const state = useTerminalStore.getState();
    expect(state.commandQueue.length).toBe(0);
  });

  it("should reset core UI state in a single atomic operation", async () => {
    const group: TabGroup = {
      id: "group-1",
      panelIds: ["term-1", "term-2"],
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
          location: "dock",
        },
      ],
      tabGroups: new Map([["group-1", group]]),
      activeTabByGroup: new Map([["group-1", "term-2"]]),
      trashedTerminals: new Map([
        [
          "term-4",
          {
            id: "term-4",
            expiresAt: Date.now() + 60000,
            originalLocation: "grid" as const,
          },
        ],
      ]),
      focusedId: "term-1",
      maximizedId: "term-2",
      activeDockTerminalId: "term-3",
      commandQueue: [
        {
          id: "cmd-1",
          terminalId: "term-1",
          payload: "echo test",
          description: "Test command",
          queuedAt: Date.now(),
          origin: "user" as const,
        },
      ],
    });

    await useTerminalStore.getState().resetWithoutKilling();

    const state = useTerminalStore.getState();

    // All state should be reset
    expect(state.terminals).toEqual([]);
    expect(state.tabGroups.size).toBe(0);
    expect(state.activeTabByGroup.size).toBe(0);
    expect(state.trashedTerminals.size).toBe(0);
    expect(state.focusedId).toBeNull();
    expect(state.maximizedId).toBeNull();
    expect(state.activeDockTerminalId).toBeNull();
    expect(state.commandQueue).toEqual([]);
  });

  it("should reset all state fields including pingedId and preMaximizeLayout", async () => {
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
      pingedId: "term-1",
      preMaximizeLayout: {
        gridCols: 2,
        gridItemCount: 1,
        worktreeId: undefined,
      },
      backendStatus: "recovering" as const,
      lastCrashType: "OUT_OF_MEMORY" as const,
    });

    await useTerminalStore.getState().resetWithoutKilling();

    const state = useTerminalStore.getState();
    expect(state.pingedId).toBeNull();
    expect(state.preMaximizeLayout).toBeNull();
    expect(state.backendStatus).toBe("connected");
    expect(state.lastCrashType).toBeNull();
  });
});
