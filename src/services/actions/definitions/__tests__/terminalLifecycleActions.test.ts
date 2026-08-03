import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  forceResume: vi.fn().mockResolvedValue(undefined),
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
  return async (id: string, args?: unknown, ctx?: unknown): Promise<unknown> => {
    const factory = actions.get(id);
    if (!factory) throw new Error(`missing ${id}`);
    const def = factory() as AnyActionDefinition;
    return def.run(args, (ctx ?? {}) as never);
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

// Every action below resolves an omitted `terminalId` from ambient focus. That
// is right for a keybinding or a palette pick and wrong for a headless caller,
// which cannot see what is focused — so agent/MCP dispatch has to fail closed
// rather than act on whatever the user happens to be looking at (#11532).
describe("agent dispatch target binding (#11532)", () => {
  class TestCustomEvent<T = unknown> extends Event {
    readonly detail: T;

    constructor(type: string, eventInitDict?: CustomEventInit<T>) {
      super(type);
      this.detail = eventInitDict?.detail as T;
    }
  }

  const dispatchEvent = vi.fn();
  const getInfo = vi.fn().mockResolvedValue({ id: "explicit-panel" });

  // Matched in full rather than on /terminalId/ alone: several of these actions
  // destructure their args unguarded, so a bare `run(undefined)` raises a
  // TypeError that also mentions "terminalId" and would pass a loose assertion.
  const UNBOUND_TARGET =
    /requires an explicit `terminalId` when dispatched by an agent or MCP client/;

  // What ActionService actually hands run() for a target-less dispatch. It
  // rewrites undefined to {} only when the schema rejects undefined but accepts
  // {} (ActionService.ts), so a `.optional()` schema still receives undefined.
  // Each row below uses its own action's real shape, which also keeps the
  // undefined path — where an unguarded destructure would throw — under test.
  const OPTIONAL_SCHEMA = undefined;
  const OBJECT_SCHEMA = {};

  function setGuardState(
    options: { focusedId?: string | null; focusedPanel?: Record<string, unknown> } = {}
  ) {
    const focusedId = options.focusedId === undefined ? "focused-panel" : options.focusedId;
    const store = {
      trashPanel: vi.fn(),
      removePanel: vi.fn(),
      restartTerminal: vi.fn(),
      backgroundTerminal: vi.fn(),
      backgroundPanelGroup: vi.fn(),
      getPanelGroup: vi.fn(() => undefined),
      updateTitle: vi.fn(),
      toggleInputLocked: vi.fn(),
      watchPanel: vi.fn(),
      unwatchPanel: vi.fn(),
    };
    panelStoreMock.getState.mockImplementation(() => ({
      focusedId,
      // "explicit-panel" leads deliberately: terminal.close falls past focus to
      // the first visible panel, so listing the focused one first would let its
      // interactive assertion pass even with the focusedId leg removed.
      panelIds: ["explicit-panel", "focused-panel"],
      panelsById: {
        "focused-panel": {
          id: "focused-panel",
          location: "grid",
          ...(options.focusedPanel ?? {}),
        },
        "explicit-panel": { id: "explicit-panel", location: "grid" },
      },
      watchedPanels: new Set<string>(),
      ...store,
    }));
    return {
      ...store,
      resetRenderer: terminalInstanceServiceMock.resetRenderer,
      forceResume: terminalClientMock.forceResume,
      requestConfirm: pendingDestructiveStoreMock.state.request,
      dispatchEvent,
      getInfo,
    };
  }

  type GuardSpies = ReturnType<typeof setGuardState>;

  beforeEach(() => {
    dispatchEvent.mockClear();
    getInfo.mockClear();
    vi.stubGlobal("window", {
      dispatchEvent,
      setTimeout: globalThis.setTimeout.bind(globalThis),
      electron: { terminal: { getInfo } },
    });
    vi.stubGlobal("CustomEvent", TestCustomEvent);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Asserts the CustomEvent the info dialogs fire carried the focused panel.
  function expectInfoEventFor(id: string) {
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    const event = dispatchEvent.mock.calls[0]?.[0] as CustomEvent<{ id: string }>;
    expect(event.type).toBe("daintree:open-terminal-info");
    expect(event.detail).toEqual({ id });
  }

  const GUARDED: ReadonlyArray<{
    id: string;
    // The target-less args this action really receives (see above).
    noTarget: unknown;
    // Extra args the interactive case needs beyond a target.
    interactiveArgs?: Record<string, unknown>;
    // Must NOT have run when agent dispatch named no terminal.
    blocked: (spies: GuardSpies) => { mock: { calls: unknown[] } };
    // Must have acted on the focused terminal for interactive dispatch.
    hitFocused: (spies: GuardSpies) => void;
  }> = [
    {
      id: "terminal.close",
      noTarget: OPTIONAL_SCHEMA,
      blocked: (s) => s.trashPanel,
      hitFocused: (s) => expect(s.trashPanel).toHaveBeenCalledWith("focused-panel"),
    },
    {
      id: "terminal.trash",
      noTarget: OBJECT_SCHEMA,
      blocked: (s) => s.trashPanel,
      hitFocused: (s) => expect(s.trashPanel).toHaveBeenCalledWith("focused-panel"),
    },
    {
      id: "terminal.background",
      noTarget: OPTIONAL_SCHEMA,
      blocked: (s) => s.backgroundTerminal,
      hitFocused: (s) => expect(s.backgroundTerminal).toHaveBeenCalledWith("focused-panel"),
    },
    {
      id: "terminal.kill",
      noTarget: OBJECT_SCHEMA,
      blocked: (s) => s.removePanel,
      hitFocused: (s) => expect(s.removePanel).toHaveBeenCalledWith("focused-panel"),
    },
    {
      id: "terminal.restart",
      noTarget: OBJECT_SCHEMA,
      blocked: (s) => s.restartTerminal,
      hitFocused: (s) => expect(s.restartTerminal).toHaveBeenCalledWith("focused-panel"),
    },
    {
      id: "terminal.redraw",
      noTarget: OPTIONAL_SCHEMA,
      blocked: (s) => s.resetRenderer,
      // #11638: the explicit user path forces past the streaming-write
      // deferral. An unforced call here would be the bug this action shipped.
      hitFocused: (s) =>
        expect(s.resetRenderer).toHaveBeenCalledWith("focused-panel", { force: true }),
    },
    {
      id: "terminal.rename",
      noTarget: OBJECT_SCHEMA,
      // Carries a name so the interactive case takes the programmatic path.
      // Omitting it would schedule a real rename-dialog timer that outlives
      // this test's stubbed window.
      interactiveArgs: { name: "renamed" },
      blocked: (s) => s.updateTitle,
      hitFocused: (s) =>
        expect(s.updateTitle).toHaveBeenCalledWith("focused-panel", "renamed", "automation"),
    },
    {
      id: "terminal.viewInfo",
      noTarget: OBJECT_SCHEMA,
      blocked: (s) => s.dispatchEvent,
      hitFocused: () => expectInfoEventFor("focused-panel"),
    },
    {
      id: "terminal.info.open",
      noTarget: OBJECT_SCHEMA,
      blocked: (s) => s.dispatchEvent,
      hitFocused: () => expectInfoEventFor("focused-panel"),
    },
    {
      id: "terminal.info.get",
      noTarget: OPTIONAL_SCHEMA,
      blocked: (s) => s.getInfo,
      hitFocused: (s) => expect(s.getInfo).toHaveBeenCalledWith("focused-panel"),
    },
    {
      id: "terminal.toggleInputLock",
      noTarget: OBJECT_SCHEMA,
      blocked: (s) => s.toggleInputLocked,
      hitFocused: (s) => expect(s.toggleInputLocked).toHaveBeenCalledWith("focused-panel"),
    },
    {
      id: "terminal.forceResume",
      noTarget: OBJECT_SCHEMA,
      blocked: (s) => s.forceResume,
      hitFocused: (s) => expect(s.forceResume).toHaveBeenCalledWith("focused-panel"),
    },
    {
      id: "terminal.watch",
      noTarget: OPTIONAL_SCHEMA,
      blocked: (s) => s.watchPanel,
      hitFocused: (s) => expect(s.watchPanel).toHaveBeenCalledWith("focused-panel"),
    },
  ];

  it.each(GUARDED)(
    "$id rejects agent dispatch that names no terminal, and never touches the focused one",
    async ({ id, noTarget, blocked }) => {
      const spies = setGuardState();
      const run = setupActions();

      await expect(run(id, noTarget, { dispatchSource: "agent" })).rejects.toThrow(UNBOUND_TARGET);

      expect(blocked(spies)).not.toHaveBeenCalled();
    }
  );

  it.each(GUARDED)(
    "$id still acts on the focused terminal for interactive dispatch",
    async ({ id, noTarget, interactiveArgs, hitFocused }) => {
      const spies = setGuardState();
      const run = setupActions();

      // A keybinding may legitimately omit the target — that ambient fallback
      // is the whole point, and the guard has to stay out of its way.
      const args = interactiveArgs ? { ...(noTarget as object), ...interactiveArgs } : noTarget;
      await run(id, args, { dispatchSource: "keybinding" });

      hitFocused(spies);
    }
  );

  it("lets agent dispatch through once it names a terminal, ignoring focus", async () => {
    const spies = setGuardState();
    const run = setupActions();

    await run("terminal.redraw", { terminalId: "explicit-panel" }, { dispatchSource: "agent" });

    expect(spies.resetRenderer).toHaveBeenCalledWith("explicit-panel", { force: true });
    // The old `not.toHaveBeenCalledWith("focused-panel")` would now pass even if
    // the focused pane WERE redrawn, since the real call carries a second
    // argument and never matches that shape. Pin the call count and the target
    // instead, so the negative can't rot into a false positive (#11638).
    expect(spies.resetRenderer).toHaveBeenCalledTimes(1);
    expect(spies.resetRenderer.mock.calls[0]?.[0]).toBe("explicit-panel");
  });

  it("treats an empty terminalId as naming nothing", async () => {
    // The helper checks `!terminalId` rather than `== null`, so "" is rejected
    // like a missing target. It would not retarget focus either way — "" is not
    // nullish, so `??` keeps it — but it must be a clear error, not a silent
    // no-op an agent cannot distinguish from success.
    const spies = setGuardState();
    const run = setupActions();

    await expect(
      run("terminal.redraw", { terminalId: "" }, { dispatchSource: "agent" })
    ).rejects.toThrow(UNBOUND_TARGET);

    expect(spies.resetRenderer).not.toHaveBeenCalled();
  });

  it("refuses an unbound kill before staging a confirm dialog", async () => {
    // The severe case: terminal.kill is agent-reachable and danger:"confirm",
    // so an unguarded unbound call would ask the user to approve killing the
    // terminal they are looking at rather than the one the agent meant.
    //
    // The focused panel has to be a mid-work agent, or terminalHasRunningAgentSession
    // returns false, the confirm branch never runs for any input, and asserting
    // that it did not fire would prove nothing.
    const spies = setGuardState({
      focusedPanel: { kind: "terminal", detectedAgentId: "claude", agentState: "working" },
    });
    const run = setupActions();

    await expect(run("terminal.kill", OBJECT_SCHEMA, { dispatchSource: "agent" })).rejects.toThrow(
      UNBOUND_TARGET
    );

    expect(spies.requestConfirm).not.toHaveBeenCalled();
    expect(spies.removePanel).not.toHaveBeenCalled();
  });

  it("stages the confirm dialog for the terminal the agent named", async () => {
    // The companion to the test above: with the guard satisfied, the confirm
    // path is demonstrably live, so the assertion there is not vacuous.
    const spies = setGuardState({
      focusedPanel: { kind: "terminal", detectedAgentId: "claude", agentState: "working" },
    });
    panelStoreMock.getState.mockImplementation(() => ({
      focusedId: "focused-panel",
      panelIds: ["focused-panel", "explicit-panel"],
      panelsById: {
        "focused-panel": { id: "focused-panel", location: "grid" },
        "explicit-panel": {
          id: "explicit-panel",
          location: "grid",
          kind: "terminal",
          detectedAgentId: "claude",
          agentState: "working",
        },
      },
      watchedPanels: new Set<string>(),
      removePanel: spies.removePanel,
    }));
    const run = setupActions();

    await run("terminal.kill", { terminalId: "explicit-panel" }, { dispatchSource: "agent" });

    expect(spies.requestConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "kill", terminalId: "explicit-panel" })
    );
    expect(spies.removePanel).not.toHaveBeenCalled();
  });

  describe("terminal.rename headless name binding", () => {
    it("rejects agent dispatch with a target but no name instead of opening the dialog", async () => {
      const spies = setGuardState();
      const run = setupActions();

      await expect(
        run("terminal.rename", { terminalId: "explicit-panel" }, { dispatchSource: "agent" })
      ).rejects.toThrow(/requires an explicit `name` when dispatched by an agent or MCP client/);

      expect(spies.updateTitle).not.toHaveBeenCalled();
      expect(spies.dispatchEvent).not.toHaveBeenCalled();
    });

    it("reports the missing target first when both are absent", async () => {
      setGuardState();
      const run = setupActions();

      await expect(
        run("terminal.rename", OBJECT_SCHEMA, { dispatchSource: "agent" })
      ).rejects.toThrow(UNBOUND_TARGET);
    });

    it("renames when the agent supplies both", async () => {
      const spies = setGuardState();
      const run = setupActions();

      await run(
        "terminal.rename",
        { terminalId: "explicit-panel", name: "build" },
        { dispatchSource: "agent" }
      );

      expect(spies.updateTitle).toHaveBeenCalledWith("explicit-panel", "build", "automation");
    });

    it("accepts an empty name, which restores the default title", async () => {
      // "" is a meaningful value, not a missing one — the guard tests
      // `name === undefined` so this path stays reachable.
      const spies = setGuardState();
      const run = setupActions();

      await run(
        "terminal.rename",
        { terminalId: "explicit-panel", name: "" },
        { dispatchSource: "agent" }
      );

      expect(spies.updateTitle).toHaveBeenCalledWith("explicit-panel", "", "automation");
    });
  });

  describe("terminal.info.get guard composition", () => {
    it("gives an agent the binding error even while a terminal is focused", async () => {
      // The pre-existing "No terminal selected" throw only fires when nothing
      // is focused either, so on its own it would let an agent silently read
      // the wrong terminal.
      const spies = setGuardState({ focusedId: "focused-panel" });
      const run = setupActions();

      await expect(
        run("terminal.info.get", OPTIONAL_SCHEMA, { dispatchSource: "agent" })
      ).rejects.toThrow(UNBOUND_TARGET);

      expect(spies.getInfo).not.toHaveBeenCalled();
    });

    it("keeps the focus fallback for interactive dispatch", async () => {
      const spies = setGuardState({ focusedId: "focused-panel" });
      const run = setupActions();

      await run("terminal.info.get", undefined, { dispatchSource: "menu" });

      expect(spies.getInfo).toHaveBeenCalledWith("focused-panel");
    });

    it("keeps 'No terminal selected' for interactive dispatch with nothing focused", async () => {
      setGuardState({ focusedId: null });
      const run = setupActions();

      await expect(run("terminal.info.get", undefined, { dispatchSource: "menu" })).rejects.toThrow(
        "No terminal selected"
      );
    });
  });
});
