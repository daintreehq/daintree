import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const panelStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const terminalInstanceServiceMock = vi.hoisted(() => ({
  focus: vi.fn(),
  cleanup: vi.fn(),
  applyRendererPolicy: vi.fn(),
  resetRenderer: vi.fn(),
  hibernate: vi.fn(),
}));
const terminalClientMock = vi.hoisted(() => ({
  killTerminal: vi.fn().mockResolvedValue(undefined),
}));
const fireWatchNotificationMock = vi.hoisted(() => vi.fn());
const pendingDestructiveStoreMock = vi.hoisted(() => {
  let pending: unknown = null;
  return {
    state: {
      get pending() {
        return pending;
      },
      request: vi.fn((snap: unknown) => {
        pending = snap;
      }),
      clear: vi.fn(() => {
        pending = null;
      }),
    },
    reset: () => {
      pending = null;
    },
  };
});

vi.mock("@/store/panelStore", () => ({ usePanelStore: panelStoreMock }));
vi.mock("@/services/terminal/TerminalInstanceService", () => ({
  terminalInstanceService: terminalInstanceServiceMock,
}));
vi.mock("@/clients", () => ({ terminalClient: terminalClientMock }));
vi.mock("@/lib/watchNotification", () => ({
  fireWatchNotification: fireWatchNotificationMock,
}));
vi.mock("@/store/terminalPendingDestructiveActionStore", () => ({
  useTerminalPendingDestructiveActionStore: { getState: () => pendingDestructiveStoreMock.state },
}));

import { registerTerminalLifecycleActions } from "../terminalLifecycleActions";

type MockPanel = { id: string; location: "grid" | "dock" | "trash" };

function setPanelState(options: {
  focusedId?: string | null;
  panels?: MockPanel[];
  trashPanel?: ReturnType<typeof vi.fn>;
  postTrashFocusedId?: string | null;
}) {
  const panels = options.panels ?? [];
  const panelsById: Record<string, MockPanel> = {};
  for (const p of panels) panelsById[p.id] = p;
  let focusedId = options.focusedId ?? null;
  const trashPanel =
    options.trashPanel ??
    vi.fn(() => {
      if (options.postTrashFocusedId !== undefined) {
        focusedId = options.postTrashFocusedId;
      }
    });
  panelStoreMock.getState.mockImplementation(() => ({
    focusedId,
    panelIds: panels.map((p) => p.id),
    panelsById,
    trashPanel,
  }));
  return { trashPanel };
}

function setupActions() {
  const actions: ActionRegistry = new Map();
  const callbacks = {} as unknown as ActionCallbacks;
  registerTerminalLifecycleActions(actions, callbacks);
  return async (id: string, args?: unknown): Promise<unknown> => {
    const factory = actions.get(id);
    if (!factory) throw new Error(`missing ${id}`);
    const def = factory() as AnyActionDefinition;
    return def.run(args, {} as never);
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  pendingDestructiveStoreMock.reset();
});

describe("terminal.close DOM focus handoff", () => {
  it("focuses the next panel after trashing the focused panel", async () => {
    const { trashPanel } = setPanelState({
      focusedId: "p1",
      panels: [
        { id: "p1", location: "grid" },
        { id: "p2", location: "grid" },
      ],
      postTrashFocusedId: "p2",
    });
    const run = setupActions();

    await run("terminal.close");

    expect(trashPanel).toHaveBeenCalledWith("p1");
    expect(terminalInstanceServiceMock.focus).toHaveBeenCalledWith("p2");
    expect(terminalInstanceServiceMock.focus).toHaveBeenCalledTimes(1);
  });

  it("does not focus anything when the last grid panel is closed", async () => {
    setPanelState({
      focusedId: "p1",
      panels: [{ id: "p1", location: "grid" }],
      postTrashFocusedId: null,
    });
    const run = setupActions();

    await run("terminal.close");

    expect(terminalInstanceServiceMock.focus).not.toHaveBeenCalled();
  });

  it("focuses the post-trash panel when called with an explicit terminalId", async () => {
    const { trashPanel } = setPanelState({
      focusedId: "p2",
      panels: [
        { id: "p1", location: "grid" },
        { id: "p2", location: "grid" },
      ],
      postTrashFocusedId: "p2",
    });
    const run = setupActions();

    await run("terminal.close", { terminalId: "p1" });

    expect(trashPanel).toHaveBeenCalledWith("p1");
    expect(terminalInstanceServiceMock.focus).toHaveBeenCalledWith("p2");
  });

  it("does not call trashPanel or focus when no targetable panel exists", async () => {
    const { trashPanel } = setPanelState({
      focusedId: null,
      panels: [{ id: "p1", location: "trash" }],
      postTrashFocusedId: null,
    });
    const run = setupActions();

    await run("terminal.close");

    expect(trashPanel).not.toHaveBeenCalled();
    expect(terminalInstanceServiceMock.focus).not.toHaveBeenCalled();
  });
});

type AgentPanel = {
  id: string;
  location: "grid" | "dock" | "trash";
  ephemeral?: boolean;
  detectedAgentId?: string;
  launchAgentId?: string;
  agentState?: string;
  worktreeId?: string;
};

function setRichPanelState(options: { focusedId?: string | null; panels: AgentPanel[] }) {
  const panels = options.panels;
  const panelsById: Record<string, AgentPanel> = {};
  for (const p of panels) panelsById[p.id] = p;
  const removePanel = vi.fn();
  const restartTerminal = vi.fn();
  const bulkRestartAll = vi.fn().mockResolvedValue(undefined);
  const bulkRestartByWorktree = vi.fn().mockResolvedValue(undefined);
  panelStoreMock.getState.mockImplementation(() => ({
    focusedId: options.focusedId ?? null,
    panelIds: panels.map((p) => p.id),
    panelsById,
    removePanel,
    restartTerminal,
    bulkRestartAll,
    bulkRestartByWorktree,
  }));
  return { removePanel, restartTerminal, bulkRestartAll };
}

describe("terminal.kill confirm gate", () => {
  it("kills immediately when the terminal is a bare PTY (no agent)", async () => {
    const { removePanel } = setRichPanelState({
      focusedId: "p1",
      panels: [{ id: "p1", location: "grid" }],
    });
    const run = setupActions();

    await run("terminal.kill", { terminalId: "p1" });

    expect(removePanel).toHaveBeenCalledWith("p1");
    expect(pendingDestructiveStoreMock.state.request).not.toHaveBeenCalled();
  });

  it("kills immediately when the agent is idle (not in CLOSE_CONFIRM state)", async () => {
    const { removePanel } = setRichPanelState({
      focusedId: "p1",
      panels: [
        {
          id: "p1",
          location: "grid",
          detectedAgentId: "claude",
          agentState: "idle",
        },
      ],
    });
    const run = setupActions();

    await run("terminal.kill", { terminalId: "p1" });

    expect(removePanel).toHaveBeenCalledWith("p1");
    expect(pendingDestructiveStoreMock.state.request).not.toHaveBeenCalled();
  });

  it("does not kill when an agent is mid-work without confirmed:true — requests confirmation instead", async () => {
    const { removePanel } = setRichPanelState({
      focusedId: "p1",
      panels: [
        {
          id: "p1",
          location: "grid",
          detectedAgentId: "claude",
          agentState: "working",
        },
      ],
    });
    const run = setupActions();

    await run("terminal.kill", { terminalId: "p1" });

    expect(removePanel).not.toHaveBeenCalled();
    expect(pendingDestructiveStoreMock.state.request).toHaveBeenCalledWith({
      kind: "kill",
      targetCount: 1,
      runningAgentCount: 1,
      terminalId: "p1",
    });
  });

  it("kills when an agent is mid-work and confirmed:true is passed", async () => {
    const { removePanel } = setRichPanelState({
      focusedId: "p1",
      panels: [
        {
          id: "p1",
          location: "grid",
          detectedAgentId: "claude",
          agentState: "working",
        },
      ],
    });
    const run = setupActions();

    await run("terminal.kill", { terminalId: "p1", confirmed: true });

    expect(removePanel).toHaveBeenCalledWith("p1");
    expect(pendingDestructiveStoreMock.state.request).not.toHaveBeenCalled();
  });
});

describe("terminal.restart confirm gate", () => {
  it("restarts immediately when the terminal is a bare PTY", async () => {
    const { restartTerminal } = setRichPanelState({
      focusedId: "p1",
      panels: [{ id: "p1", location: "grid" }],
    });
    const run = setupActions();

    await run("terminal.restart", { terminalId: "p1" });

    expect(restartTerminal).toHaveBeenCalledWith("p1");
    expect(pendingDestructiveStoreMock.state.request).not.toHaveBeenCalled();
  });

  it("requests confirmation when an agent is mid-work without confirmed:true", async () => {
    const { restartTerminal } = setRichPanelState({
      focusedId: "p1",
      panels: [
        {
          id: "p1",
          location: "grid",
          detectedAgentId: "claude",
          agentState: "working",
        },
      ],
    });
    const run = setupActions();

    await run("terminal.restart", { terminalId: "p1" });

    expect(restartTerminal).not.toHaveBeenCalled();
    expect(pendingDestructiveStoreMock.state.request).toHaveBeenCalledWith({
      kind: "restart",
      targetCount: 1,
      runningAgentCount: 1,
      terminalId: "p1",
    });
  });

  it("restarts when an agent is mid-work and confirmed:true is passed", async () => {
    const { restartTerminal } = setRichPanelState({
      focusedId: "p1",
      panels: [
        {
          id: "p1",
          location: "grid",
          detectedAgentId: "claude",
          agentState: "working",
        },
      ],
    });
    const run = setupActions();

    await run("terminal.restart", { terminalId: "p1", confirmed: true });

    expect(restartTerminal).toHaveBeenCalledWith("p1");
  });
});

describe("terminal.killAll confirm gate", () => {
  it("kills all non-ephemeral panels immediately when no agents are running", async () => {
    const { removePanel } = setRichPanelState({
      panels: [
        { id: "p1", location: "grid" },
        { id: "p2", location: "grid" },
        { id: "ephem", location: "dock", ephemeral: true },
      ],
    });
    const run = setupActions();

    await run("terminal.killAll");

    expect(removePanel).toHaveBeenCalledWith("p1");
    expect(removePanel).toHaveBeenCalledWith("p2");
    expect(removePanel).not.toHaveBeenCalledWith("ephem");
    expect(pendingDestructiveStoreMock.state.request).not.toHaveBeenCalled();
  });

  it("requests confirmation when any non-ephemeral panel has a running agent", async () => {
    const { removePanel } = setRichPanelState({
      panels: [
        { id: "p1", location: "grid" },
        {
          id: "p2",
          location: "grid",
          detectedAgentId: "claude",
          agentState: "working",
        },
      ],
    });
    const run = setupActions();

    await run("terminal.killAll");

    expect(removePanel).not.toHaveBeenCalled();
    expect(pendingDestructiveStoreMock.state.request).toHaveBeenCalledWith({
      kind: "killAll",
      targetCount: 2,
      runningAgentCount: 1,
    });
  });

  it("kills all when confirmed:true is passed even with running agents", async () => {
    const { removePanel } = setRichPanelState({
      panels: [
        { id: "p1", location: "grid" },
        {
          id: "p2",
          location: "grid",
          detectedAgentId: "claude",
          agentState: "working",
        },
      ],
    });
    const run = setupActions();

    await run("terminal.killAll", { confirmed: true });

    expect(removePanel).toHaveBeenCalledWith("p1");
    expect(removePanel).toHaveBeenCalledWith("p2");
  });
});

describe("terminal.restartAll confirm gate", () => {
  it("restarts immediately when no agents are running", async () => {
    const { bulkRestartAll } = setRichPanelState({
      panels: [{ id: "p1", location: "grid" }],
    });
    const run = setupActions();

    await run("terminal.restartAll");

    expect(bulkRestartAll).toHaveBeenCalledTimes(1);
    expect(pendingDestructiveStoreMock.state.request).not.toHaveBeenCalled();
  });

  it("requests confirmation when any non-trash panel has a running agent", async () => {
    const { bulkRestartAll } = setRichPanelState({
      panels: [
        { id: "p1", location: "grid" },
        {
          id: "p2",
          location: "grid",
          detectedAgentId: "claude",
          agentState: "working",
        },
        { id: "trashed", location: "trash" },
      ],
    });
    const run = setupActions();

    await run("terminal.restartAll");

    expect(bulkRestartAll).not.toHaveBeenCalled();
    expect(pendingDestructiveStoreMock.state.request).toHaveBeenCalledWith({
      kind: "restartAll",
      targetCount: 2,
      runningAgentCount: 1,
    });
  });

  it("restarts when confirmed:true is passed", async () => {
    const { bulkRestartAll } = setRichPanelState({
      panels: [
        {
          id: "p1",
          location: "grid",
          detectedAgentId: "claude",
          agentState: "working",
        },
      ],
    });
    const run = setupActions();

    await run("terminal.restartAll", { confirmed: true });

    expect(bulkRestartAll).toHaveBeenCalledTimes(1);
  });
});

describe("terminal.rename DOM handoff", () => {
  it("opens the inline rename input from a timer", async () => {
    vi.useFakeTimers();
    class TestCustomEvent<T = unknown> extends Event {
      readonly detail: T;

      constructor(type: string, eventInitDict?: CustomEventInit<T>) {
        super(type);
        this.detail = eventInitDict?.detail as T;
      }
    }
    const eventTarget = new EventTarget();
    const testWindow = {
      addEventListener: eventTarget.addEventListener.bind(eventTarget),
      removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
      dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
      setTimeout: globalThis.setTimeout.bind(globalThis),
    } as unknown as Window;
    vi.stubGlobal("window", testWindow);
    vi.stubGlobal("CustomEvent", TestCustomEvent);

    const renameEvents: CustomEvent[] = [];
    const handleRename = (event: Event) => {
      renameEvents.push(event as CustomEvent);
    };
    window.addEventListener("daintree:rename-terminal", handleRename);

    try {
      setPanelState({
        focusedId: "p1",
        panels: [{ id: "p1", location: "grid" }],
      });
      const run = setupActions();

      await run("terminal.rename", { terminalId: "p1" });

      expect(renameEvents).toHaveLength(0);
      await vi.runOnlyPendingTimersAsync();
      expect(renameEvents).toHaveLength(1);
      expect(renameEvents[0]?.detail).toEqual({ id: "p1" });
    } finally {
      window.removeEventListener("daintree:rename-terminal", handleRename);
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});

describe("terminal.hibernate", () => {
  it("hibernates the focused terminal when no id is passed", async () => {
    setPanelState({ focusedId: "p1", panels: [{ id: "p1", location: "grid" }] });
    const run = setupActions();
    await run("terminal.hibernate");
    expect(terminalInstanceServiceMock.hibernate).toHaveBeenCalledWith("p1");
  });

  it("hibernates the explicitly targeted terminal", async () => {
    setPanelState({
      focusedId: "p1",
      panels: [
        { id: "p1", location: "grid" },
        { id: "p2", location: "grid" },
      ],
    });
    const run = setupActions();
    await run("terminal.hibernate", { terminalId: "p2" });
    expect(terminalInstanceServiceMock.hibernate).toHaveBeenCalledWith("p2");
  });

  it("no-ops when nothing is focused and no id is provided", async () => {
    setPanelState({ focusedId: null, panels: [] });
    const run = setupActions();
    await run("terminal.hibernate");
    expect(terminalInstanceServiceMock.hibernate).not.toHaveBeenCalled();
  });
});

describe("terminal.hibernateAllIdle", () => {
  function setPanelsWithStates(
    panels: Array<{
      id: string;
      kind?: string;
      location?: "grid" | "dock" | "trash";
      agentState?: string;
      ephemeral?: boolean;
    }>
  ) {
    const panelsById: Record<string, unknown> = {};
    for (const p of panels) {
      panelsById[p.id] = {
        id: p.id,
        kind: p.kind ?? "terminal",
        location: p.location ?? "grid",
        agentState: p.agentState,
        ephemeral: p.ephemeral,
      };
    }
    panelStoreMock.getState.mockImplementation(() => ({
      panelIds: panels.map((p) => p.id),
      panelsById,
    }));
  }

  it("hibernates idle and completed terminals; skips working and ephemeral", async () => {
    setPanelsWithStates([
      { id: "idle1" },
      { id: "completed1", agentState: "completed" },
      { id: "exited1", agentState: "exited" },
      { id: "working1", agentState: "working" },
      { id: "waiting1", agentState: "waiting" },
      { id: "directing1", agentState: "directing" },
      { id: "ephemeral1", ephemeral: true },
      { id: "trashed1", location: "trash" },
      { id: "browser1", kind: "browser" },
    ]);
    const run = setupActions();
    await run("terminal.hibernateAllIdle");

    const calls = terminalInstanceServiceMock.hibernate.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(expect.arrayContaining(["idle1", "completed1", "exited1"]));
    expect(calls).not.toEqual(expect.arrayContaining(["working1"]));
    expect(calls).not.toEqual(expect.arrayContaining(["waiting1"]));
    expect(calls).not.toEqual(expect.arrayContaining(["directing1"]));
    expect(calls).not.toEqual(expect.arrayContaining(["ephemeral1"]));
    expect(calls).not.toEqual(expect.arrayContaining(["trashed1"]));
    expect(calls).not.toEqual(expect.arrayContaining(["browser1"]));
  });

  it("hibernates plain terminals without agentState", async () => {
    setPanelsWithStates([{ id: "plain1" }]);
    const run = setupActions();
    await run("terminal.hibernateAllIdle");
    expect(terminalInstanceServiceMock.hibernate).toHaveBeenCalledWith("plain1");
  });
});
