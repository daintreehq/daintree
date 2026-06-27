import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const panelStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const terminalInstanceServiceMock = vi.hoisted(() => ({
  focus: vi.fn(),
  cleanup: vi.fn(),
  applyRendererPolicy: vi.fn(),
  onPanelBackgrounded: vi.fn(),
  resetRenderer: vi.fn(),
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

// Run the optimistic-close commit synchronously so these tests assert the
// canonical trash outcome directly; the deferral is covered by
// optimisticPanelClose.test.ts.
vi.mock("@/services/terminal/optimisticPanelClose", () => ({
  requestPanelClose: vi.fn((req: { commit: () => void }) => req.commit()),
  flushOptimisticCloses: vi.fn(),
}));

import { registerTerminalLifecycleActions } from "../terminalLifecycleActions";

type MockPanel = { id: string; location: "grid" | "dock" | "trash" | "background" };

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

// terminal.close routes through the optimistic-close coordinator (mocked here
// to run its commit synchronously). Focus handoff is the coordinator's job now
// and is covered by optimisticPanelClose.test.ts.
describe("terminal.close", () => {
  it("trashes the focused panel", async () => {
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
  });

  it("trashes an explicit terminalId when provided", async () => {
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
  });

  it("no-ops when no targetable panel exists", async () => {
    const { trashPanel } = setPanelState({
      focusedId: null,
      panels: [{ id: "p1", location: "trash" }],
      postTrashFocusedId: null,
    });
    const run = setupActions();

    await run("terminal.close");

    expect(trashPanel).not.toHaveBeenCalled();
  });

  it("fallback skips background panels (#9937)", async () => {
    const { trashPanel } = setPanelState({
      focusedId: null,
      panels: [
        { id: "bg1", location: "background" },
        { id: "p2", location: "grid" },
      ],
      postTrashFocusedId: null,
    });
    const run = setupActions();

    await run("terminal.close");

    expect(trashPanel).toHaveBeenCalledWith("p2");
  });

  it("no-ops when only background panels remain (#9937)", async () => {
    const { trashPanel } = setPanelState({
      focusedId: null,
      panels: [{ id: "bg1", location: "background" }],
      postTrashFocusedId: null,
    });
    const run = setupActions();

    await run("terminal.close");

    expect(trashPanel).not.toHaveBeenCalled();
  });
});

type AgentPanel = {
  id: string;
  location: "grid" | "dock" | "trash";
  excludeFromPersistence?: boolean;
  removeOnExit?: boolean;
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
  it("kills all user-facing panels immediately when no agents are running", async () => {
    const { removePanel } = setRichPanelState({
      panels: [
        { id: "p1", location: "grid" },
        { id: "p2", location: "grid" },
        { id: "ephem", location: "dock", excludeFromPersistence: true },
      ],
    });
    const run = setupActions();

    await run("terminal.killAll");

    expect(removePanel).toHaveBeenCalledWith("p1");
    expect(removePanel).toHaveBeenCalledWith("p2");
    expect(removePanel).not.toHaveBeenCalledWith("ephem");
    expect(pendingDestructiveStoreMock.state.request).not.toHaveBeenCalled();
  });

  it("kills removeOnExit-only panels — only excludeFromPersistence is spared (flags independent)", async () => {
    const { removePanel } = setRichPanelState({
      panels: [
        { id: "p1", location: "grid" },
        { id: "rox", location: "grid", removeOnExit: true, excludeFromPersistence: false },
        { id: "ephem", location: "dock", excludeFromPersistence: true },
      ],
    });
    const run = setupActions();

    await run("terminal.killAll");

    expect(removePanel).toHaveBeenCalledWith("p1");
    expect(removePanel).toHaveBeenCalledWith("rox");
    expect(removePanel).not.toHaveBeenCalledWith("ephem");
  });

  it("requests confirmation when any user-facing panel has a running agent", async () => {
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
