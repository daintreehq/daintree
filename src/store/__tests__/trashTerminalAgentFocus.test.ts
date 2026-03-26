import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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

const { useTerminalStore } = await import("../terminalStore");

function makeTerminal(id: string, kind: "agent" | "terminal", agentId?: string) {
  return {
    id,
    type: "terminal" as const,
    kind: kind as "agent" | "terminal",
    agentId,
    title: id,
    cwd: "/test",
    cols: 80,
    rows: 24,
    location: "grid" as const,
  };
}

describe("trashTerminal agent-aware focus", () => {
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

  it("should focus next agent when trashing an agent terminal", () => {
    useTerminalStore.setState({
      terminals: [
        makeTerminal("agent-1", "agent", "claude"),
        makeTerminal("shell-1", "terminal"),
        makeTerminal("agent-2", "agent", "gemini"),
        makeTerminal("shell-2", "terminal"),
      ],
      focusedId: "agent-1",
    });

    useTerminalStore.getState().trashTerminal("agent-1");

    expect(useTerminalStore.getState().focusedId).toBe("agent-2");
  });

  it("should fall back to any grid terminal when last agent is trashed", () => {
    useTerminalStore.setState({
      terminals: [makeTerminal("agent-1", "agent", "claude"), makeTerminal("shell-1", "terminal")],
      focusedId: "agent-1",
    });

    useTerminalStore.getState().trashTerminal("agent-1");

    expect(useTerminalStore.getState().focusedId).toBe("shell-1");
  });

  it("should support rapid sequential agent close", () => {
    useTerminalStore.setState({
      terminals: [
        makeTerminal("agent-1", "agent", "claude"),
        makeTerminal("agent-2", "agent", "gemini"),
        makeTerminal("agent-3", "agent", "codex"),
        makeTerminal("shell-1", "terminal"),
      ],
      focusedId: "agent-1",
    });

    useTerminalStore.getState().trashTerminal("agent-1");
    expect(useTerminalStore.getState().focusedId).toBe("agent-2");

    useTerminalStore.getState().trashTerminal("agent-2");
    expect(useTerminalStore.getState().focusedId).toBe("agent-3");

    useTerminalStore.getState().trashTerminal("agent-3");
    expect(useTerminalStore.getState().focusedId).toBe("shell-1");
  });

  it("should not change behavior when trashing a non-agent terminal", () => {
    useTerminalStore.setState({
      terminals: [
        makeTerminal("shell-1", "terminal"),
        makeTerminal("agent-1", "agent", "claude"),
        makeTerminal("shell-2", "terminal"),
      ],
      focusedId: "shell-1",
    });

    useTerminalStore.getState().trashTerminal("shell-1");

    // Should pick first remaining grid terminal (agent-1), same as before
    expect(useTerminalStore.getState().focusedId).toBe("agent-1");
  });

  it("should set focusedId to null when no grid terminals remain", () => {
    useTerminalStore.setState({
      terminals: [makeTerminal("agent-1", "agent", "claude")],
      focusedId: "agent-1",
    });

    useTerminalStore.getState().trashTerminal("agent-1");

    expect(useTerminalStore.getState().focusedId).toBeNull();
  });
});

describe("trashPanelGroup agent-aware focus", () => {
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

  it("should focus next agent when trashing a group with focused agent", () => {
    useTerminalStore.setState({
      terminals: [
        makeTerminal("agent-1", "agent", "claude"),
        makeTerminal("agent-2", "agent", "gemini"),
        makeTerminal("agent-3", "agent", "codex"),
        makeTerminal("shell-1", "terminal"),
      ],
      tabGroups: new Map([
        [
          "group-1",
          {
            id: "group-1",
            panelIds: ["agent-1", "agent-2"],
            activeTabId: "agent-1",
            location: "grid" as const,
          },
        ],
      ]),
      focusedId: "agent-1",
    });

    useTerminalStore.getState().trashPanelGroup("agent-1");

    expect(useTerminalStore.getState().focusedId).toBe("agent-3");
  });

  it("should fall back to non-agent when no agents remain after group trash", () => {
    useTerminalStore.setState({
      terminals: [
        makeTerminal("agent-1", "agent", "claude"),
        makeTerminal("agent-2", "agent", "gemini"),
        makeTerminal("shell-1", "terminal"),
      ],
      tabGroups: new Map([
        [
          "group-1",
          {
            id: "group-1",
            panelIds: ["agent-1", "agent-2"],
            activeTabId: "agent-1",
            location: "grid" as const,
          },
        ],
      ]),
      focusedId: "agent-1",
    });

    useTerminalStore.getState().trashPanelGroup("agent-1");

    expect(useTerminalStore.getState().focusedId).toBe("shell-1");
  });
});
