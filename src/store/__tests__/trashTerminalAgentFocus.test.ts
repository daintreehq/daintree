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

const { usePanelStore } = await import("../panelStore");
const { useWorktreeSelectionStore } = await import("../worktreeStore");

function makeTerminal(
  id: string,
  _legacyKind: "terminal" | "agent",
  launchAgentId?: string,
  worktreeId?: string,
  detectedAgentId?: "claude" | "gemini" | "codex",
  everDetectedAgent?: boolean
) {
  // After the kind collapse, all PTY panels have kind:"terminal".
  // Agent-ness is expressed via launchAgentId / detectedAgentId.
  return {
    id,
    kind: "terminal" as const,
    launchAgentId,
    worktreeId,
    title: id,
    cwd: "/test",
    cols: 80,
    rows: 24,
    location: "grid" as const,
    detectedAgentId,
    everDetectedAgent,
  };
}

describe("trashPanel agent-aware focus", () => {
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

  it("should focus next agent when trashing an agent terminal", () => {
    usePanelStore.setState({
      panelsById: {
        "agent-1": makeTerminal("agent-1", "agent", "claude", undefined, "claude"),
        "shell-1": makeTerminal("shell-1", "terminal"),
        "agent-2": makeTerminal("agent-2", "agent", "gemini", undefined, "gemini"),
        "shell-2": makeTerminal("shell-2", "terminal"),
      },
      panelIds: ["agent-1", "shell-1", "agent-2", "shell-2"],
      focusedId: "agent-1",
    });

    usePanelStore.getState().trashPanel("agent-1");

    expect(usePanelStore.getState().focusedId).toBe("agent-2");
  });

  it("should fall back to any grid terminal when last agent is trashed", () => {
    usePanelStore.setState({
      panelsById: {
        "agent-1": makeTerminal("agent-1", "agent", "claude"),
        "shell-1": makeTerminal("shell-1", "terminal"),
      },
      panelIds: ["agent-1", "shell-1"],
      focusedId: "agent-1",
    });

    usePanelStore.getState().trashPanel("agent-1");

    expect(usePanelStore.getState().focusedId).toBe("shell-1");
  });

  it("should support rapid sequential agent close", () => {
    usePanelStore.setState({
      panelsById: {
        "agent-1": makeTerminal("agent-1", "agent", "claude"),
        "agent-2": makeTerminal("agent-2", "agent", "gemini"),
        "agent-3": makeTerminal("agent-3", "agent", "codex"),
        "shell-1": makeTerminal("shell-1", "terminal"),
      },
      panelIds: ["agent-1", "agent-2", "agent-3", "shell-1"],
      focusedId: "agent-1",
    });

    usePanelStore.getState().trashPanel("agent-1");
    expect(usePanelStore.getState().focusedId).toBe("agent-2");

    usePanelStore.getState().trashPanel("agent-2");
    expect(usePanelStore.getState().focusedId).toBe("agent-3");

    usePanelStore.getState().trashPanel("agent-3");
    expect(usePanelStore.getState().focusedId).toBe("shell-1");
  });

  it("should not change behavior when trashing a non-agent terminal", () => {
    usePanelStore.setState({
      panelsById: {
        "shell-1": makeTerminal("shell-1", "terminal"),
        "agent-1": makeTerminal("agent-1", "agent", "claude"),
        "shell-2": makeTerminal("shell-2", "terminal"),
      },
      panelIds: ["shell-1", "agent-1", "shell-2"],
      focusedId: "shell-1",
    });

    usePanelStore.getState().trashPanel("shell-1");

    // Should pick first remaining grid terminal (agent-1), same as before
    expect(usePanelStore.getState().focusedId).toBe("agent-1");
  });

  it("should set focusedId to null when no grid terminals remain", () => {
    usePanelStore.setState({
      panelsById: { "agent-1": makeTerminal("agent-1", "agent", "claude") },
      panelIds: ["agent-1"],
      focusedId: "agent-1",
    });

    usePanelStore.getState().trashPanel("agent-1");

    expect(usePanelStore.getState().focusedId).toBeNull();
  });

  // Runtime identity coverage for #5772: trash fallback should treat a panel as
  // an agent based on what's running now (detectedAgentId + sticky
  // everDetectedAgent), not only how it was spawned (kind/agentId).
  it("should not prefer another agent when a demoted ex-agent is trashed", () => {
    usePanelStore.setState({
      panelsById: {
        // Spawned as agent, detector fired then cleared on exit — demoted.
        "ex-agent": makeTerminal("ex-agent", "agent", "claude", undefined, undefined, true),
        "shell-1": makeTerminal("shell-1", "terminal"),
        // Another live agent further down the grid
        "agent-2": makeTerminal("agent-2", "agent", "gemini", undefined, "gemini"),
      },
      panelIds: ["ex-agent", "shell-1", "agent-2"],
      focusedId: "ex-agent",
    });

    usePanelStore.getState().trashPanel("ex-agent");

    // Because the trashed panel was not a runtime agent, fallback picks the
    // first grid terminal rather than preferring the next agent.
    expect(usePanelStore.getState().focusedId).toBe("shell-1");
  });

  it("should prefer another agent when trashing a promoted shell with a detected agent", () => {
    usePanelStore.setState({
      panelsById: {
        // Spawned as plain terminal but runtime-detected as claude
        "promoted-shell": makeTerminal(
          "promoted-shell",
          "terminal",
          undefined,
          undefined,
          "claude"
        ),
        "shell-1": makeTerminal("shell-1", "terminal"),
        // agent-2 must have detectedAgentId so isRuntimeAgentTerminal returns true
        "agent-2": makeTerminal("agent-2", "agent", "gemini", undefined, "gemini"),
      },
      panelIds: ["promoted-shell", "shell-1", "agent-2"],
      focusedId: "promoted-shell",
    });

    usePanelStore.getState().trashPanel("promoted-shell");

    // Trashed panel is a runtime agent, so prefer the next agent.
    expect(usePanelStore.getState().focusedId).toBe("agent-2");
  });
});

describe("trashPanelGroup agent-aware focus", () => {
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

  it("should focus next agent when trashing a group with focused agent", () => {
    usePanelStore.setState({
      panelsById: {
        "agent-1": makeTerminal("agent-1", "agent", "claude"),
        "agent-2": makeTerminal("agent-2", "agent", "gemini"),
        "agent-3": makeTerminal("agent-3", "agent", "codex"),
        "shell-1": makeTerminal("shell-1", "terminal"),
      },
      panelIds: ["agent-1", "agent-2", "agent-3", "shell-1"],
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

    usePanelStore.getState().trashPanelGroup("agent-1");

    expect(usePanelStore.getState().focusedId).toBe("agent-3");
  });

  it("should not prefer another agent when trashing a group whose focused panel is a demoted ex-agent", () => {
    usePanelStore.setState({
      panelsById: {
        "ex-agent": makeTerminal("ex-agent", "agent", "claude", undefined, undefined, true),
        "agent-paired": makeTerminal("agent-paired", "agent", "gemini"),
        "shell-1": makeTerminal("shell-1", "terminal"),
        // Another live agent that would be preferred if wasAgent were true
        "agent-live": makeTerminal("agent-live", "agent", "codex", undefined, "codex"),
      },
      panelIds: ["ex-agent", "agent-paired", "shell-1", "agent-live"],
      tabGroups: new Map([
        [
          "group-1",
          {
            id: "group-1",
            panelIds: ["ex-agent", "agent-paired"],
            activeTabId: "ex-agent",
            location: "grid" as const,
          },
        ],
      ]),
      focusedId: "ex-agent",
    });

    usePanelStore.getState().trashPanelGroup("ex-agent");

    // Focused panel was a demoted ex-agent → wasAgent is false → pick first grid terminal
    expect(usePanelStore.getState().focusedId).toBe("shell-1");
  });

  it("should prefer another agent when trashing a group whose focused panel is a promoted shell", () => {
    usePanelStore.setState({
      panelsById: {
        "promoted-shell": makeTerminal(
          "promoted-shell",
          "terminal",
          undefined,
          undefined,
          "claude"
        ),
        "plain-shell": makeTerminal("plain-shell", "terminal"),
        "next-shell": makeTerminal("next-shell", "terminal"),
        "live-agent": makeTerminal("live-agent", "agent", "gemini", undefined, "gemini"),
      },
      panelIds: ["promoted-shell", "plain-shell", "next-shell", "live-agent"],
      tabGroups: new Map([
        [
          "group-1",
          {
            id: "group-1",
            panelIds: ["promoted-shell", "plain-shell"],
            activeTabId: "promoted-shell",
            location: "grid" as const,
          },
        ],
      ]),
      focusedId: "promoted-shell",
    });

    usePanelStore.getState().trashPanelGroup("promoted-shell");

    // Focused panel was a promoted shell running claude → wasAgent is true → prefer next agent
    expect(usePanelStore.getState().focusedId).toBe("live-agent");
  });

  it("should fall back to non-agent when no agents remain after group trash", () => {
    usePanelStore.setState({
      panelsById: {
        "agent-1": makeTerminal("agent-1", "agent", "claude"),
        "agent-2": makeTerminal("agent-2", "agent", "gemini"),
        "shell-1": makeTerminal("shell-1", "terminal"),
      },
      panelIds: ["agent-1", "agent-2", "shell-1"],
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

    usePanelStore.getState().trashPanelGroup("agent-1");

    expect(usePanelStore.getState().focusedId).toBe("shell-1");
  });
});

describe("worktree-scoped focus fallback (#4327)", () => {
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
    useWorktreeSelectionStore.setState({ activeWorktreeId: null });
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("trashPanel: should prefer same-worktree terminal over cross-worktree", () => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    usePanelStore.setState({
      panelsById: {
        "agent-1": makeTerminal("agent-1", "agent", "claude", "wt-1"),
        "shell-other": makeTerminal("shell-other", "terminal", undefined, "wt-2"),
        "shell-same": makeTerminal("shell-same", "terminal", undefined, "wt-1"),
      },
      panelIds: ["agent-1", "shell-other", "shell-same"],
      focusedId: "agent-1",
    });

    usePanelStore.getState().trashPanel("agent-1");

    expect(usePanelStore.getState().focusedId).toBe("shell-same");
  });

  it("trashPanel: should fall back to null when no same-worktree grid terminals remain", () => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    usePanelStore.setState({
      panelsById: {
        "agent-1": makeTerminal("agent-1", "agent", "claude", "wt-1"),
        "shell-other": makeTerminal("shell-other", "terminal", undefined, "wt-2"),
      },
      panelIds: ["agent-1", "shell-other"],
      focusedId: "agent-1",
    });

    usePanelStore.getState().trashPanel("agent-1");

    expect(usePanelStore.getState().focusedId).toBeNull();
  });

  it("trashPanel: should prefer same-worktree agent when trashing an agent", () => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    usePanelStore.setState({
      panelsById: {
        "agent-1": makeTerminal("agent-1", "agent", "claude", "wt-1"),
        "agent-other": makeTerminal("agent-other", "agent", "gemini", "wt-2"),
        "agent-same": makeTerminal("agent-same", "agent", "codex", "wt-1"),
        "shell-same": makeTerminal("shell-same", "terminal", undefined, "wt-1"),
      },
      panelIds: ["agent-1", "agent-other", "agent-same", "shell-same"],
      focusedId: "agent-1",
    });

    usePanelStore.getState().trashPanel("agent-1");

    expect(usePanelStore.getState().focusedId).toBe("agent-same");
  });

  it("trashPanel: root worktree (null activeWorktreeId) matches undefined worktreeId", () => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: null });
    usePanelStore.setState({
      panelsById: {
        "agent-1": makeTerminal("agent-1", "agent", "claude"),
        "shell-root": makeTerminal("shell-root", "terminal"),
        "shell-wt": makeTerminal("shell-wt", "terminal", undefined, "wt-1"),
      },
      panelIds: ["agent-1", "shell-root", "shell-wt"],
      focusedId: "agent-1",
    });

    usePanelStore.getState().trashPanel("agent-1");

    expect(usePanelStore.getState().focusedId).toBe("shell-root");
  });

  it("moveTerminalToDock: should prefer same-worktree terminal", () => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    usePanelStore.setState({
      panelsById: {
        "panel-1": makeTerminal("panel-1", "terminal", undefined, "wt-1"),
        "shell-other": makeTerminal("shell-other", "terminal", undefined, "wt-2"),
        "shell-same": makeTerminal("shell-same", "terminal", undefined, "wt-1"),
      },
      panelIds: ["panel-1", "shell-other", "shell-same"],
      focusedId: "panel-1",
    });

    usePanelStore.getState().moveTerminalToDock("panel-1");

    expect(usePanelStore.getState().focusedId).toBe("shell-same");
  });

  it("trashPanelGroup: should prefer same-worktree terminal", () => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    usePanelStore.setState({
      panelsById: {
        "agent-1": makeTerminal("agent-1", "agent", "claude", "wt-1"),
        "agent-2": makeTerminal("agent-2", "agent", "gemini", "wt-1"),
        "shell-other": makeTerminal("shell-other", "terminal", undefined, "wt-2"),
        "shell-same": makeTerminal("shell-same", "terminal", undefined, "wt-1"),
      },
      panelIds: ["agent-1", "agent-2", "shell-other", "shell-same"],
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

    usePanelStore.getState().trashPanelGroup("agent-1");

    expect(usePanelStore.getState().focusedId).toBe("shell-same");
  });

  it("moveTerminalToPosition to dock: should prefer same-worktree terminal", () => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    usePanelStore.setState({
      panelsById: {
        "panel-1": makeTerminal("panel-1", "terminal", undefined, "wt-1"),
        "shell-other": makeTerminal("shell-other", "terminal", undefined, "wt-2"),
        "shell-same": makeTerminal("shell-same", "terminal", undefined, "wt-1"),
      },
      panelIds: ["panel-1", "shell-other", "shell-same"],
      focusedId: "panel-1",
    });

    usePanelStore.getState().moveTerminalToPosition("panel-1", 0, "dock");

    expect(usePanelStore.getState().focusedId).toBe("shell-same");
  });
});

describe("lastClosedConfig snapshot (#4717)", () => {
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
      lastClosedConfig: null,
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("captures lastClosedConfig when trashing a terminal", () => {
    usePanelStore.setState({
      panelsById: {
        "agent-1": {
          ...makeTerminal("agent-1", "agent", "claude", "wt-1"),
          command: "claude --interactive",
          agentModelId: "opus",
          agentLaunchFlags: ["--verbose"],
          cwd: "/projects/app",
        },
      },
      panelIds: ["agent-1"],
      focusedId: "agent-1",
    });

    usePanelStore.getState().trashPanel("agent-1");

    const config = usePanelStore.getState().lastClosedConfig;
    expect(config).not.toBeNull();
    expect(config!.launchAgentId).toBe("claude");
    expect(config!.worktreeId).toBe("wt-1");
    expect(config!.command).toBe("claude --interactive");
    expect(config!.agentModelId).toBe("opus");
    expect(config!.agentLaunchFlags).toEqual(["--verbose"]);
    expect(config!.cwd).toBe("/projects/app");
  });

  it("overwrites lastClosedConfig on each close", () => {
    usePanelStore.setState({
      panelsById: {
        "shell-1": makeTerminal("shell-1", "terminal"),
        "shell-2": { ...makeTerminal("shell-2", "terminal"), command: "zsh" },
      },
      panelIds: ["shell-1", "shell-2"],
      focusedId: "shell-1",
    });

    usePanelStore.getState().trashPanel("shell-1");
    expect(usePanelStore.getState().lastClosedConfig).not.toBeNull();

    usePanelStore.getState().trashPanel("shell-2");
    expect(usePanelStore.getState().lastClosedConfig!.command).toBe("zsh");
  });

  it("captures lastClosedConfig when trashing a panel group", () => {
    usePanelStore.setState({
      panelsById: {
        "agent-1": { ...makeTerminal("agent-1", "agent", "claude"), command: "claude-cmd" },
        "agent-2": makeTerminal("agent-2", "agent", "gemini"),
        "shell-1": makeTerminal("shell-1", "terminal"),
      },
      panelIds: ["agent-1", "agent-2", "shell-1"],
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

    usePanelStore.getState().trashPanelGroup("agent-1");

    const config = usePanelStore.getState().lastClosedConfig;
    expect(config).not.toBeNull();
    expect(config!.launchAgentId).toBe("claude");
    expect(config!.command).toBe("claude-cmd");
  });

  it("clears lastClosedConfig on reset", async () => {
    usePanelStore.setState({
      panelsById: { "shell-1": makeTerminal("shell-1", "terminal") },
      panelIds: ["shell-1"],
      focusedId: "shell-1",
    });

    usePanelStore.getState().trashPanel("shell-1");
    expect(usePanelStore.getState().lastClosedConfig).not.toBeNull();

    await usePanelStore.getState().reset();
    expect(usePanelStore.getState().lastClosedConfig).toBeNull();
  });

  it("clears lastClosedConfig on clearTerminalStoreForSwitch", () => {
    usePanelStore.setState({
      panelsById: { "shell-1": makeTerminal("shell-1", "terminal") },
      panelIds: ["shell-1"],
      focusedId: "shell-1",
    });

    usePanelStore.getState().trashPanel("shell-1");
    expect(usePanelStore.getState().lastClosedConfig).not.toBeNull();

    usePanelStore.getState().clearTerminalStoreForSwitch();
    expect(usePanelStore.getState().lastClosedConfig).toBeNull();
  });
});
