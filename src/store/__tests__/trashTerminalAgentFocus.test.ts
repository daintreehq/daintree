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
const { useWorktreeSelectionStore } = await import("../worktreeStore");

function makeTerminal(
  id: string,
  kind: "agent" | "terminal",
  agentId?: string,
  worktreeId?: string
) {
  return {
    id,
    type: "terminal" as const,
    kind: kind as "agent" | "terminal",
    agentId,
    worktreeId,
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
      terminalsById: {},
      terminalIds: [],
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
      terminalsById: {
        "agent-1": makeTerminal("agent-1", "agent", "claude"),
        "shell-1": makeTerminal("shell-1", "terminal"),
        "agent-2": makeTerminal("agent-2", "agent", "gemini"),
        "shell-2": makeTerminal("shell-2", "terminal"),
      },
      terminalIds: ["agent-1", "shell-1", "agent-2", "shell-2"],
      focusedId: "agent-1",
    });

    useTerminalStore.getState().trashTerminal("agent-1");

    expect(useTerminalStore.getState().focusedId).toBe("agent-2");
  });

  it("should fall back to any grid terminal when last agent is trashed", () => {
    useTerminalStore.setState({
      terminalsById: {
        "agent-1": makeTerminal("agent-1", "agent", "claude"),
        "shell-1": makeTerminal("shell-1", "terminal"),
      },
      terminalIds: ["agent-1", "shell-1"],
      focusedId: "agent-1",
    });

    useTerminalStore.getState().trashTerminal("agent-1");

    expect(useTerminalStore.getState().focusedId).toBe("shell-1");
  });

  it("should support rapid sequential agent close", () => {
    useTerminalStore.setState({
      terminalsById: {
        "agent-1": makeTerminal("agent-1", "agent", "claude"),
        "agent-2": makeTerminal("agent-2", "agent", "gemini"),
        "agent-3": makeTerminal("agent-3", "agent", "codex"),
        "shell-1": makeTerminal("shell-1", "terminal"),
      },
      terminalIds: ["agent-1", "agent-2", "agent-3", "shell-1"],
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
      terminalsById: {
        "shell-1": makeTerminal("shell-1", "terminal"),
        "agent-1": makeTerminal("agent-1", "agent", "claude"),
        "shell-2": makeTerminal("shell-2", "terminal"),
      },
      terminalIds: ["shell-1", "agent-1", "shell-2"],
      focusedId: "shell-1",
    });

    useTerminalStore.getState().trashTerminal("shell-1");

    // Should pick first remaining grid terminal (agent-1), same as before
    expect(useTerminalStore.getState().focusedId).toBe("agent-1");
  });

  it("should set focusedId to null when no grid terminals remain", () => {
    useTerminalStore.setState({
      terminalsById: { "agent-1": makeTerminal("agent-1", "agent", "claude") },
      terminalIds: ["agent-1"],
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
      terminalsById: {},
      terminalIds: [],
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
      terminalsById: {
        "agent-1": makeTerminal("agent-1", "agent", "claude"),
        "agent-2": makeTerminal("agent-2", "agent", "gemini"),
        "agent-3": makeTerminal("agent-3", "agent", "codex"),
        "shell-1": makeTerminal("shell-1", "terminal"),
      },
      terminalIds: ["agent-1", "agent-2", "agent-3", "shell-1"],
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
      terminalsById: {
        "agent-1": makeTerminal("agent-1", "agent", "claude"),
        "agent-2": makeTerminal("agent-2", "agent", "gemini"),
        "shell-1": makeTerminal("shell-1", "terminal"),
      },
      terminalIds: ["agent-1", "agent-2", "shell-1"],
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

describe("worktree-scoped focus fallback (#4327)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const { reset } = useTerminalStore.getState();
    reset();
    useTerminalStore.setState({
      terminalsById: {},
      terminalIds: [],
      tabGroups: new Map(),
      trashedTerminals: new Map(),
      backgroundedTerminals: new Map(),
      focusedId: null,
      maximizedId: null,
      commandQueue: [],
    });
  });

  afterEach(() => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: null });
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("trashTerminal: should prefer same-worktree terminal over cross-worktree", () => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    useTerminalStore.setState({
      terminalsById: {
        "agent-1": makeTerminal("agent-1", "agent", "claude", "wt-1"),
        "shell-other": makeTerminal("shell-other", "terminal", undefined, "wt-2"),
        "shell-same": makeTerminal("shell-same", "terminal", undefined, "wt-1"),
      },
      terminalIds: ["agent-1", "shell-other", "shell-same"],
      focusedId: "agent-1",
    });

    useTerminalStore.getState().trashTerminal("agent-1");

    expect(useTerminalStore.getState().focusedId).toBe("shell-same");
  });

  it("trashTerminal: should fall back to null when no same-worktree grid terminals remain", () => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    useTerminalStore.setState({
      terminalsById: {
        "agent-1": makeTerminal("agent-1", "agent", "claude", "wt-1"),
        "shell-other": makeTerminal("shell-other", "terminal", undefined, "wt-2"),
      },
      terminalIds: ["agent-1", "shell-other"],
      focusedId: "agent-1",
    });

    useTerminalStore.getState().trashTerminal("agent-1");

    expect(useTerminalStore.getState().focusedId).toBeNull();
  });

  it("trashTerminal: should prefer same-worktree agent when trashing an agent", () => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    useTerminalStore.setState({
      terminalsById: {
        "agent-1": makeTerminal("agent-1", "agent", "claude", "wt-1"),
        "agent-other": makeTerminal("agent-other", "agent", "gemini", "wt-2"),
        "agent-same": makeTerminal("agent-same", "agent", "codex", "wt-1"),
        "shell-same": makeTerminal("shell-same", "terminal", undefined, "wt-1"),
      },
      terminalIds: ["agent-1", "agent-other", "agent-same", "shell-same"],
      focusedId: "agent-1",
    });

    useTerminalStore.getState().trashTerminal("agent-1");

    expect(useTerminalStore.getState().focusedId).toBe("agent-same");
  });

  it("trashTerminal: root worktree (null activeWorktreeId) matches undefined worktreeId", () => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: null });
    useTerminalStore.setState({
      terminalsById: {
        "agent-1": makeTerminal("agent-1", "agent", "claude"),
        "shell-root": makeTerminal("shell-root", "terminal"),
        "shell-wt": makeTerminal("shell-wt", "terminal", undefined, "wt-1"),
      },
      terminalIds: ["agent-1", "shell-root", "shell-wt"],
      focusedId: "agent-1",
    });

    useTerminalStore.getState().trashTerminal("agent-1");

    expect(useTerminalStore.getState().focusedId).toBe("shell-root");
  });

  it("moveTerminalToDock: should prefer same-worktree terminal", () => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    useTerminalStore.setState({
      terminalsById: {
        "panel-1": makeTerminal("panel-1", "terminal", undefined, "wt-1"),
        "shell-other": makeTerminal("shell-other", "terminal", undefined, "wt-2"),
        "shell-same": makeTerminal("shell-same", "terminal", undefined, "wt-1"),
      },
      terminalIds: ["panel-1", "shell-other", "shell-same"],
      focusedId: "panel-1",
    });

    useTerminalStore.getState().moveTerminalToDock("panel-1");

    expect(useTerminalStore.getState().focusedId).toBe("shell-same");
  });

  it("trashPanelGroup: should prefer same-worktree terminal", () => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    useTerminalStore.setState({
      terminalsById: {
        "agent-1": makeTerminal("agent-1", "agent", "claude", "wt-1"),
        "agent-2": makeTerminal("agent-2", "agent", "gemini", "wt-1"),
        "shell-other": makeTerminal("shell-other", "terminal", undefined, "wt-2"),
        "shell-same": makeTerminal("shell-same", "terminal", undefined, "wt-1"),
      },
      terminalIds: ["agent-1", "agent-2", "shell-other", "shell-same"],
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

    expect(useTerminalStore.getState().focusedId).toBe("shell-same");
  });

  it("moveTerminalToPosition to dock: should prefer same-worktree terminal", () => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    useTerminalStore.setState({
      terminalsById: {
        "panel-1": makeTerminal("panel-1", "terminal", undefined, "wt-1"),
        "shell-other": makeTerminal("shell-other", "terminal", undefined, "wt-2"),
        "shell-same": makeTerminal("shell-same", "terminal", undefined, "wt-1"),
      },
      terminalIds: ["panel-1", "shell-other", "shell-same"],
      focusedId: "panel-1",
    });

    useTerminalStore.getState().moveTerminalToPosition("panel-1", 0, "dock");

    expect(useTerminalStore.getState().focusedId).toBe("shell-same");
  });
});

describe("lastClosedConfig snapshot (#4717)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const { reset } = useTerminalStore.getState();
    reset();
    useTerminalStore.setState({
      terminalsById: {},
      terminalIds: [],
      tabGroups: new Map(),
      trashedTerminals: new Map(),
      backgroundedTerminals: new Map(),
      focusedId: null,
      maximizedId: null,
      commandQueue: [],
      lastClosedConfig: null,
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("captures lastClosedConfig when trashing a terminal", () => {
    useTerminalStore.setState({
      terminalsById: {
        "agent-1": {
          ...makeTerminal("agent-1", "agent", "claude", "wt-1"),
          command: "claude --interactive",
          agentModelId: "opus",
          agentLaunchFlags: ["--verbose"],
          cwd: "/projects/app",
        },
      },
      terminalIds: ["agent-1"],
      focusedId: "agent-1",
    });

    useTerminalStore.getState().trashTerminal("agent-1");

    const config = useTerminalStore.getState().lastClosedConfig;
    expect(config).not.toBeNull();
    expect(config!.agentId).toBe("claude");
    expect(config!.worktreeId).toBe("wt-1");
    expect(config!.command).toBe("claude --interactive");
    expect(config!.agentModelId).toBe("opus");
    expect(config!.agentLaunchFlags).toEqual(["--verbose"]);
    expect(config!.cwd).toBe("/projects/app");
  });

  it("overwrites lastClosedConfig on each close", () => {
    useTerminalStore.setState({
      terminalsById: {
        "shell-1": makeTerminal("shell-1", "terminal"),
        "shell-2": { ...makeTerminal("shell-2", "terminal"), command: "zsh" },
      },
      terminalIds: ["shell-1", "shell-2"],
      focusedId: "shell-1",
    });

    useTerminalStore.getState().trashTerminal("shell-1");
    expect(useTerminalStore.getState().lastClosedConfig!.type).toBe("terminal");

    useTerminalStore.getState().trashTerminal("shell-2");
    expect(useTerminalStore.getState().lastClosedConfig!.command).toBe("zsh");
  });

  it("captures lastClosedConfig when trashing a panel group", () => {
    useTerminalStore.setState({
      terminalsById: {
        "agent-1": { ...makeTerminal("agent-1", "agent", "claude"), command: "claude-cmd" },
        "agent-2": makeTerminal("agent-2", "agent", "gemini"),
        "shell-1": makeTerminal("shell-1", "terminal"),
      },
      terminalIds: ["agent-1", "agent-2", "shell-1"],
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

    const config = useTerminalStore.getState().lastClosedConfig;
    expect(config).not.toBeNull();
    expect(config!.agentId).toBe("claude");
    expect(config!.command).toBe("claude-cmd");
  });

  it("clears lastClosedConfig on reset", async () => {
    useTerminalStore.setState({
      terminalsById: { "shell-1": makeTerminal("shell-1", "terminal") },
      terminalIds: ["shell-1"],
      focusedId: "shell-1",
    });

    useTerminalStore.getState().trashTerminal("shell-1");
    expect(useTerminalStore.getState().lastClosedConfig).not.toBeNull();

    await useTerminalStore.getState().reset();
    expect(useTerminalStore.getState().lastClosedConfig).toBeNull();
  });

  it("clears lastClosedConfig on clearTerminalStoreForSwitch", () => {
    useTerminalStore.setState({
      terminalsById: { "shell-1": makeTerminal("shell-1", "terminal") },
      terminalIds: ["shell-1"],
      focusedId: "shell-1",
    });

    useTerminalStore.getState().trashTerminal("shell-1");
    expect(useTerminalStore.getState().lastClosedConfig).not.toBeNull();

    useTerminalStore.getState().clearTerminalStoreForSwitch();
    expect(useTerminalStore.getState().lastClosedConfig).toBeNull();
  });
});
