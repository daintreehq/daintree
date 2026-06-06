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
    onPanelBackgrounded: vi.fn(),
    wake: vi.fn(),
  },
}));

vi.mock("@/lib/notify", () => ({
  notify: vi.fn(() => "mock-notification-id"),
}));

const { usePanelStore } = await import("../panelStore");
const { useWorktreeSelectionStore } = await import("../worktreeStore");

function makeTerminal(
  id: string,
  worktreeId?: string,
  detectedAgentId?: "claude" | "gemini" | "codex"
) {
  return {
    id,
    kind: "terminal" as const,
    worktreeId,
    title: id,
    cwd: "/test",
    cols: 80,
    rows: 24,
    location: "grid" as const,
    detectedAgentId,
  };
}

function resetStore() {
  usePanelStore.setState({
    panelsById: {},
    panelIds: [],
    tabGroups: new Map(),
    trashedTerminals: new Map(),
    backgroundedTerminals: new Map(),
    focusedId: null,
    previousFocusedId: null,
    maximizedId: null,
    activeDockTerminalId: null,
    commandQueue: [],
  });
}

describe("backgroundTerminal focus repair (#9937)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    usePanelStore.getState().reset();
    resetStore();
  });

  afterEach(() => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: null });
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("moves focus to the next grid panel when backgrounding the focused panel", () => {
    usePanelStore.setState({
      panelsById: {
        "shell-1": makeTerminal("shell-1"),
        "shell-2": makeTerminal("shell-2"),
      },
      panelIds: ["shell-1", "shell-2"],
      focusedId: "shell-1",
    });

    usePanelStore.getState().backgroundTerminal("shell-1");

    expect(usePanelStore.getState().focusedId).toBe("shell-2");
    expect(usePanelStore.getState().previousFocusedId).toBeNull();
  });

  it("leaves focus unchanged when backgrounding a non-focused panel", () => {
    usePanelStore.setState({
      panelsById: {
        "shell-1": makeTerminal("shell-1"),
        "shell-2": makeTerminal("shell-2"),
      },
      panelIds: ["shell-1", "shell-2"],
      focusedId: "shell-1",
    });

    usePanelStore.getState().backgroundTerminal("shell-2");

    expect(usePanelStore.getState().focusedId).toBe("shell-1");
  });

  it("clears previousFocusedId when it points at the backgrounded panel", () => {
    usePanelStore.setState({
      panelsById: {
        "shell-1": makeTerminal("shell-1"),
        "shell-2": makeTerminal("shell-2"),
      },
      panelIds: ["shell-1", "shell-2"],
      focusedId: "shell-1",
      previousFocusedId: "shell-2",
    });

    usePanelStore.getState().backgroundTerminal("shell-2");

    expect(usePanelStore.getState().focusedId).toBe("shell-1");
    expect(usePanelStore.getState().previousFocusedId).toBeNull();
  });

  it("sets focusedId to null when no grid panels remain", () => {
    usePanelStore.setState({
      panelsById: { "shell-1": makeTerminal("shell-1") },
      panelIds: ["shell-1"],
      focusedId: "shell-1",
    });

    usePanelStore.getState().backgroundTerminal("shell-1");

    expect(usePanelStore.getState().focusedId).toBeNull();
  });

  it("prefers another agent terminal when backgrounding a runtime agent", () => {
    usePanelStore.setState({
      panelsById: {
        "agent-1": makeTerminal("agent-1", undefined, "claude"),
        "shell-1": makeTerminal("shell-1"),
        "agent-2": makeTerminal("agent-2", undefined, "gemini"),
      },
      panelIds: ["agent-1", "shell-1", "agent-2"],
      focusedId: "agent-1",
    });

    usePanelStore.getState().backgroundTerminal("agent-1");

    expect(usePanelStore.getState().focusedId).toBe("agent-2");
  });

  it("prefers a same-worktree panel for the fallback pick", () => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    usePanelStore.setState({
      panelsById: {
        "panel-1": makeTerminal("panel-1", "wt-1"),
        "shell-other": makeTerminal("shell-other", "wt-2"),
        "shell-same": makeTerminal("shell-same", "wt-1"),
      },
      panelIds: ["panel-1", "shell-other", "shell-same"],
      focusedId: "panel-1",
    });

    usePanelStore.getState().backgroundTerminal("panel-1");

    expect(usePanelStore.getState().focusedId).toBe("shell-same");
  });

  it("clears maximizedId when the backgrounded panel is maximized", () => {
    usePanelStore.setState({
      panelsById: {
        "shell-1": makeTerminal("shell-1"),
        "shell-2": makeTerminal("shell-2"),
      },
      panelIds: ["shell-1", "shell-2"],
      focusedId: "shell-1",
      maximizedId: "shell-1",
    });

    usePanelStore.getState().backgroundTerminal("shell-1");

    expect(usePanelStore.getState().maximizedId).toBeNull();
  });

  it("clears activeDockTerminalId when a dock panel is backgrounded", () => {
    usePanelStore.setState({
      panelsById: {
        "shell-1": makeTerminal("shell-1"),
        "dock-1": { ...makeTerminal("dock-1"), location: "dock" as const },
      },
      panelIds: ["shell-1", "dock-1"],
      focusedId: "shell-1",
      activeDockTerminalId: "dock-1",
    });

    usePanelStore.getState().backgroundTerminal("dock-1");

    expect(usePanelStore.getState().activeDockTerminalId).toBeNull();
    expect(usePanelStore.getState().focusedId).toBe("shell-1");
  });

  it("does not steal focus when the slice declines (overlay panel)", () => {
    usePanelStore.setState({
      panelsById: {
        "overlay-1": { ...makeTerminal("overlay-1"), location: "overlay" as const },
        "shell-1": makeTerminal("shell-1"),
      },
      panelIds: ["overlay-1", "shell-1"],
      focusedId: "overlay-1",
    });

    usePanelStore.getState().backgroundTerminal("overlay-1");

    expect(usePanelStore.getState().focusedId).toBe("overlay-1");
    expect(usePanelStore.getState().panelsById["overlay-1"]!.location).toBe("overlay");
  });

  it("does not steal focus when the panel does not exist", () => {
    usePanelStore.setState({
      panelsById: { "shell-1": makeTerminal("shell-1") },
      panelIds: ["shell-1"],
      focusedId: "shell-1",
    });

    usePanelStore.getState().backgroundTerminal("ghost-id");

    expect(usePanelStore.getState().focusedId).toBe("shell-1");
  });
});

describe("backgroundPanelGroup focus repair (#9937)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    usePanelStore.getState().reset();
    resetStore();
  });

  afterEach(() => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: null });
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("moves focus to a panel outside the group when the focused group is backgrounded", () => {
    usePanelStore.setState({
      panelsById: {
        "tab-1": makeTerminal("tab-1"),
        "tab-2": makeTerminal("tab-2"),
        "shell-1": makeTerminal("shell-1"),
      },
      panelIds: ["tab-1", "tab-2", "shell-1"],
      tabGroups: new Map([
        [
          "group-1",
          {
            id: "group-1",
            panelIds: ["tab-1", "tab-2"],
            activeTabId: "tab-1",
            location: "grid" as const,
          },
        ],
      ]),
      focusedId: "tab-1",
    });

    usePanelStore.getState().backgroundPanelGroup("tab-1");

    expect(usePanelStore.getState().focusedId).toBe("shell-1");
    expect(usePanelStore.getState().previousFocusedId).toBeNull();
  });

  it("leaves focus unchanged when backgrounding a non-focused group", () => {
    usePanelStore.setState({
      panelsById: {
        "tab-1": makeTerminal("tab-1"),
        "tab-2": makeTerminal("tab-2"),
        "shell-1": makeTerminal("shell-1"),
      },
      panelIds: ["tab-1", "tab-2", "shell-1"],
      tabGroups: new Map([
        [
          "group-1",
          {
            id: "group-1",
            panelIds: ["tab-1", "tab-2"],
            activeTabId: "tab-1",
            location: "grid" as const,
          },
        ],
      ]),
      focusedId: "shell-1",
    });

    usePanelStore.getState().backgroundPanelGroup("tab-1");

    expect(usePanelStore.getState().focusedId).toBe("shell-1");
  });

  it("clears previousFocusedId when it points into the backgrounded group", () => {
    usePanelStore.setState({
      panelsById: {
        "tab-1": makeTerminal("tab-1"),
        "tab-2": makeTerminal("tab-2"),
        "shell-1": makeTerminal("shell-1"),
      },
      panelIds: ["tab-1", "tab-2", "shell-1"],
      tabGroups: new Map([
        [
          "group-1",
          {
            id: "group-1",
            panelIds: ["tab-1", "tab-2"],
            activeTabId: "tab-1",
            location: "grid" as const,
          },
        ],
      ]),
      focusedId: "shell-1",
      previousFocusedId: "tab-2",
    });

    usePanelStore.getState().backgroundPanelGroup("tab-1");

    expect(usePanelStore.getState().previousFocusedId).toBeNull();
  });

  it("clears maximizedId when it points into the backgrounded group", () => {
    usePanelStore.setState({
      panelsById: {
        "tab-1": makeTerminal("tab-1"),
        "tab-2": makeTerminal("tab-2"),
        "shell-1": makeTerminal("shell-1"),
      },
      panelIds: ["tab-1", "tab-2", "shell-1"],
      tabGroups: new Map([
        [
          "group-1",
          {
            id: "group-1",
            panelIds: ["tab-1", "tab-2"],
            activeTabId: "tab-1",
            location: "grid" as const,
          },
        ],
      ]),
      focusedId: "tab-1",
      maximizedId: "tab-2",
    });

    usePanelStore.getState().backgroundPanelGroup("tab-1");

    expect(usePanelStore.getState().maximizedId).toBeNull();
  });

  it("repairs focus via the single-panel path for an ungrouped panel", () => {
    usePanelStore.setState({
      panelsById: {
        "shell-1": makeTerminal("shell-1"),
        "shell-2": makeTerminal("shell-2"),
      },
      panelIds: ["shell-1", "shell-2"],
      focusedId: "shell-1",
    });

    usePanelStore.getState().backgroundPanelGroup("shell-1");

    expect(usePanelStore.getState().focusedId).toBe("shell-2");
    expect(usePanelStore.getState().panelsById["shell-1"]!.location).toBe("background");
  });

  it("prefers a same-worktree panel for the group fallback pick", () => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    usePanelStore.setState({
      panelsById: {
        "tab-1": makeTerminal("tab-1", "wt-1"),
        "tab-2": makeTerminal("tab-2", "wt-1"),
        "shell-other": makeTerminal("shell-other", "wt-2"),
        "shell-same": makeTerminal("shell-same", "wt-1"),
      },
      panelIds: ["tab-1", "tab-2", "shell-other", "shell-same"],
      tabGroups: new Map([
        [
          "group-1",
          {
            id: "group-1",
            panelIds: ["tab-1", "tab-2"],
            activeTabId: "tab-1",
            location: "grid" as const,
            worktreeId: "wt-1",
          },
        ],
      ]),
      focusedId: "tab-1",
    });

    usePanelStore.getState().backgroundPanelGroup("tab-1");

    expect(usePanelStore.getState().focusedId).toBe("shell-same");
  });

  it("sets focusedId to null when the group was the only grid content", () => {
    usePanelStore.setState({
      panelsById: {
        "tab-1": makeTerminal("tab-1"),
        "tab-2": makeTerminal("tab-2"),
      },
      panelIds: ["tab-1", "tab-2"],
      tabGroups: new Map([
        [
          "group-1",
          {
            id: "group-1",
            panelIds: ["tab-1", "tab-2"],
            activeTabId: "tab-1",
            location: "grid" as const,
          },
        ],
      ]),
      focusedId: "tab-1",
    });

    usePanelStore.getState().backgroundPanelGroup("tab-1");

    expect(usePanelStore.getState().focusedId).toBeNull();
  });
});
