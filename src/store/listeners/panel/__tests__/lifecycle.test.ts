// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { usePanelStore } from "@/store/panelStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";

const dispatchMock = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));

vi.mock("@/lib/notify", () => ({
  notify: vi.fn(),
  muteForDuration: vi.fn(),
  muteUntilNextMorning: vi.fn(),
  setSessionQuietUntil: vi.fn(),
  isScheduledQuietHours: vi.fn().mockReturnValue(false),
}));

vi.mock("@/utils/logger", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

const restoredHandlers = vi.hoisted(() => [] as Array<(data: { id: string }) => void>);
const trashedHandlers = vi.hoisted(
  () => [] as Array<(data: { id: string; expiresAt: number }) => void>
);
const exitHandlers = vi.hoisted(() => [] as Array<(id: string, exitCode: number) => void>);
const reliabilityMetricHandlers = vi.hoisted(
  () =>
    [] as Array<
      (payload: {
        metricType: string;
        terminalId?: string;
        perTerminalHeld?: Array<{ terminalId: string; heldDurationMs: number }>;
      }) => void
    >
);
vi.mock("@/controllers", () => {
  const noopSub = () => () => {};
  return {
    terminalRegistryController: {
      onFallbackTriggered: vi.fn(noopSub),
      onTrashed: vi.fn((handler: (data: { id: string; expiresAt: number }) => void) => {
        trashedHandlers.push(handler);
        return () => {};
      }),
      onRestored: vi.fn((handler: (data: { id: string }) => void) => {
        restoredHandlers.push(handler);
        return () => {};
      }),
      onExit: vi.fn((handler: (id: string, exitCode: number) => void) => {
        exitHandlers.push(handler);
        return () => {};
      }),
      onStatus: vi.fn(noopSub),
      onReliabilityMetric: vi.fn(
        (
          handler: (payload: {
            metricType: string;
            terminalId?: string;
            perTerminalHeld?: Array<{ terminalId: string; heldDurationMs: number }>;
          }) => void
        ) => {
          reliabilityMetricHandlers.push(handler);
          return () => {};
        }
      ),
      onSpawnResult: vi.fn(noopSub),
      onReduceScrollback: vi.fn(noopSub),
      onRestoreScrollback: vi.fn(noopSub),
    },
  };
});

import { handleFallbackTriggered, setupLifecycleListeners } from "../lifecycle";
import { notify } from "@/lib/notify";
import { flushPanelStatusBuffer, enqueueFlowStatusUpdate } from "@/store/panelStatusBuffer";
import { isPtyPanel } from "@shared/types/panel";

function getPtyHeldDuration(id: string): number | undefined {
  const panel = usePanelStore.getState().panelsById[id];
  if (!panel || !isPtyPanel(panel)) return undefined;
  return panel.heldDurationMs;
}

const actionMatcher = {
  label: "Open agent settings",
  actionId: "app.settings.openTab",
  actionArgs: { tab: "agents" },
};

function setupPanel(overrides: Record<string, unknown> = {}) {
  usePanelStore.setState({
    panelsById: {
      "term-1": {
        id: "term-1",
        kind: "terminal",
        title: "Test Terminal",
        cwd: "/tmp",
        cols: 80,
        rows: 24,
        location: "grid" as const,
        agentPresetId: "preset-1",
        originalPresetId: "preset-1",
        fallbackChainIndex: 0,
        ...overrides,
      },
    },
    panelIds: ["term-1"],
  });
}

beforeEach(() => {
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
  useAgentSettingsStore.setState({ settings: { agents: {} } });
  useCcrPresetsStore.setState({ ccrPresetsByAgent: {} });
  useProjectPresetsStore.setState({ presetsByAgent: {} });
  dispatchMock.mockClear();
  vi.mocked(notify).mockClear();
});

describe("handleFallbackTriggered — exhausted chain", () => {
  it("emits error with recovery action when preset has a fallback chain but chain is exhausted", async () => {
    useAgentSettingsStore.setState({
      settings: {
        agents: {
          testAgent: {
            customPresets: [
              {
                id: "preset-1",
                name: "Primary",
                fallbacks: ["preset-2"],
              },
              {
                id: "preset-2",
                name: "Fallback",
              },
            ],
          },
        },
      },
    });
    setupPanel({
      agentPresetId: "preset-1",
      fallbackChainIndex: 1,
    });

    await handleFallbackTriggered({
      terminalId: "term-1",
      agentId: "testAgent",
      fromPresetId: "preset-1",
      reason: "connection",
    });

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        priority: "high",
        title: "Fallback chain exhausted",
        message: expect.stringContaining("Configure fallback presets"),
        duration: 12000,
        action: expect.objectContaining(actionMatcher),
      })
    );
  });

  it("dispatches settings navigation when action onClick is invoked", async () => {
    useAgentSettingsStore.setState({
      settings: {
        agents: {
          testAgent: {
            customPresets: [
              {
                id: "preset-1",
                name: "Primary",
                fallbacks: ["preset-2"],
              },
              {
                id: "preset-2",
                name: "Fallback",
              },
            ],
          },
        },
      },
    });
    setupPanel({
      agentPresetId: "preset-1",
      fallbackChainIndex: 1,
    });

    await handleFallbackTriggered({
      terminalId: "term-1",
      agentId: "testAgent",
      fromPresetId: "preset-1",
      reason: "connection",
    });

    const callArgs = vi.mocked(notify).mock.lastCall?.[0];
    const action = callArgs?.action;
    expect(action).toBeDefined();
    (action!.onClick as () => void)();

    expect(dispatchMock).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "agents" },
      { source: "user" }
    );
  });

  it("emits error for no-fallback preset when fromName is unavailable", async () => {
    useAgentSettingsStore.setState({
      settings: {
        agents: {
          testAgent: {
            customPresets: [
              {
                id: "preset-1",
                name: "Primary",
              },
            ],
          },
        },
      },
    });
    setupPanel({
      agentPresetId: "preset-1",
      fallbackChainIndex: 0,
    });

    await handleFallbackTriggered({
      terminalId: "term-1",
      agentId: "testAgent",
      fromPresetId: "preset-1",
      reason: "connection",
    });

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        priority: "high",
        title: "Primary unavailable",
        message: expect.stringContaining("Configure fallbacks"),
        duration: 12000,
        action: expect.objectContaining(actionMatcher),
      })
    );
  });

  it("includes recovery action onClick that dispatches app.settings.openTab", async () => {
    useAgentSettingsStore.setState({
      settings: {
        agents: {
          testAgent: {
            customPresets: [
              {
                id: "preset-1",
                name: "Primary",
              },
            ],
          },
        },
      },
    });
    setupPanel({
      agentPresetId: "preset-1",
      fallbackChainIndex: 0,
    });

    await handleFallbackTriggered({
      terminalId: "term-1",
      agentId: "testAgent",
      fromPresetId: "preset-1",
      reason: "connection",
    });

    const callArgs = vi.mocked(notify).mock.lastCall?.[0];
    expect(callArgs?.action?.label).toBe("Open agent settings");
    expect(callArgs?.action?.actionId).toBe("app.settings.openTab");
    expect(callArgs?.action?.actionArgs).toEqual({ tab: "agents" });
    (callArgs!.action!.onClick as () => void)();

    expect(dispatchMock).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "agents" },
      { source: "user" }
    );
  });
});

describe("handleFallbackTriggered — guard clauses", () => {
  it("returns early when panel is not found", async () => {
    await handleFallbackTriggered({
      terminalId: "term-1",
      agentId: "testAgent",
      fromPresetId: "preset-1",
      reason: "connection",
    });

    expect(notify).not.toHaveBeenCalled();
  });

  it("returns early when panel is restarting", async () => {
    setupPanel({ isRestarting: true });

    await handleFallbackTriggered({
      terminalId: "term-1",
      agentId: "testAgent",
      fromPresetId: "preset-1",
      reason: "connection",
    });

    expect(notify).not.toHaveBeenCalled();
  });

  it("returns early when preset has already changed (stale event)", async () => {
    setupPanel({
      agentPresetId: "preset-2",
    });

    await handleFallbackTriggered({
      terminalId: "term-1",
      agentId: "testAgent",
      fromPresetId: "preset-1",
      reason: "connection",
    });

    expect(notify).not.toHaveBeenCalled();
  });
});

describe("onRestored — dock popover preservation (#8368)", () => {
  function getRestoredHandler(): (data: { id: string }) => void {
    restoredHandlers.length = 0;
    setupLifecycleListeners();
    const handler = restoredHandlers.at(-1);
    if (!handler) throw new Error("onRestored handler was not registered");
    return handler;
  }

  it("does not clear an unrelated open dock popover when a background terminal restores", () => {
    setupPanel();
    usePanelStore.setState({ activeDockTerminalId: "dock-1", focusedId: "dock-1" });

    getRestoredHandler()({ id: "term-1" });

    // A background terminal waking from hibernation must not dismiss the
    // dock session the user is typing into.
    expect(usePanelStore.getState().activeDockTerminalId).toBe("dock-1");
  });

  it("clears the dock popover when the restored terminal moved out of the dock", () => {
    setupPanel({ location: "grid" });
    usePanelStore.setState({ activeDockTerminalId: "term-1", focusedId: "term-1" });

    getRestoredHandler()({ id: "term-1" });

    expect(usePanelStore.getState().activeDockTerminalId).toBeNull();
  });

  it("keeps the dock popover open when the restored terminal lands back in the dock (#9938)", () => {
    setupPanel({ location: "dock" });
    usePanelStore.setState({ activeDockTerminalId: "term-1", focusedId: "term-1" });

    getRestoredHandler()({ id: "term-1" });

    // A docked terminal restored from trash must keep its popover open so
    // focus and the visible panel agree, rather than the listener nulling the
    // dock pointer the restore wrapper just set.
    expect(usePanelStore.getState().activeDockTerminalId).toBe("term-1");
    expect(usePanelStore.getState().focusedId).toBe("term-1");
  });

  it("is a no-op on dock state when no dock popover is open", () => {
    setupPanel();
    usePanelStore.setState({ activeDockTerminalId: null, focusedId: "other" });

    getRestoredHandler()({ id: "term-1" });

    expect(usePanelStore.getState().activeDockTerminalId).toBeNull();
    expect(usePanelStore.getState().focusedId).toBe("term-1");
  });
});

// Issue #9935: the backend-driven `onTrashed` listener (PTY-host TTL or
// external trash) bypasses the `trashPanel`/`trashPanelGroup` wrappers, so
// it must own the maximize-trio clear itself — otherwise a dangling
// `maximizeTarget` survives into the post-restore render.
describe("onTrashed — maximize trio clear (#9935)", () => {
  function getTrashedHandler(): (data: { id: string; expiresAt: number }) => void {
    trashedHandlers.length = 0;
    setupLifecycleListeners();
    const handler = trashedHandlers.at(-1);
    if (!handler) throw new Error("onTrashed handler was not registered");
    return handler;
  }

  it("clears the maximize trio when the trashed panel was the maximized one", () => {
    setupPanel();
    usePanelStore.setState({
      focusedId: "term-1",
      maximizedId: "term-1",
      maximizeTarget: { type: "panel", id: "term-1" },
      preMaximizeLayout: { gridCols: 2, gridItemCount: 1, worktreeId: undefined },
    });

    getTrashedHandler()({ id: "term-1", expiresAt: Date.now() + 60_000 });

    const state = usePanelStore.getState();
    expect(state.maximizedId).toBeNull();
    expect(state.maximizeTarget).toBeNull();
    expect(state.preMaximizeLayout).toBeNull();
  });

  it("leaves the maximize trio alone when the trashed panel was not the maximized one", () => {
    setupPanel();
    usePanelStore.setState({
      panelsById: {
        "term-1": { id: "term-1", kind: "terminal", location: "grid" as const } as never,
        "term-2": { id: "term-2", kind: "terminal", location: "grid" as const } as never,
      },
      panelIds: ["term-1", "term-2"],
      focusedId: "term-2",
      maximizedId: "term-2",
      maximizeTarget: { type: "panel", id: "term-2" },
      preMaximizeLayout: { gridCols: 2, gridItemCount: 2, worktreeId: undefined },
    });

    getTrashedHandler()({ id: "term-1", expiresAt: Date.now() + 60_000 });

    const state = usePanelStore.getState();
    // Trashing an unrelated panel must not disturb term-2's maximize state.
    expect(state.maximizedId).toBe("term-2");
    expect(state.maximizeTarget).toEqual({ type: "panel", id: "term-2" });
    expect(state.preMaximizeLayout).toEqual({
      gridCols: 2,
      gridItemCount: 2,
      worktreeId: undefined,
    });
  });
});

describe("onReliabilityMetric — pause-duration-gauge routing", () => {
  function getReliabilityHandler(): (payload: {
    metricType: string;
    terminalId?: string;
    perTerminalHeld?: Array<{ terminalId: string; heldDurationMs: number }>;
  }) => void {
    reliabilityMetricHandlers.length = 0;
    setupLifecycleListeners();
    const handler = reliabilityMetricHandlers.at(-1);
    if (!handler) throw new Error("onReliabilityMetric handler was not registered");
    return handler;
  }

  it("routes perTerminalHeld entries to heldDurationMs on matching PTY panels", () => {
    setupPanel();
    const handler = getReliabilityHandler();

    handler({
      metricType: "pause-duration-gauge",
      perTerminalHeld: [{ terminalId: "term-1", heldDurationMs: 4500 }],
    });

    // Flush the RAF-coalesced buffer.
    flushPanelStatusBuffer();

    expect(getPtyHeldDuration("term-1")).toBe(4500);
  });

  it("clears heldDurationMs for terminals on a pause-end (resumed)", () => {
    setupPanel({ heldDurationMs: 5000 });
    const handler = getReliabilityHandler();

    handler({ metricType: "pause-end", terminalId: "term-1" });
    flushPanelStatusBuffer();

    expect(getPtyHeldDuration("term-1")).toBeUndefined();
  });

  it("clears heldDurationMs for terminals on a suspend (dropped-don't-block)", () => {
    setupPanel({ heldDurationMs: 9000 });
    const handler = getReliabilityHandler();

    handler({ metricType: "suspend", terminalId: "term-1" });
    flushPanelStatusBuffer();

    expect(getPtyHeldDuration("term-1")).toBeUndefined();
  });

  it("ignores non-pause-duration-gauge metric types", () => {
    setupPanel();
    const handler = getReliabilityHandler();

    handler({ metricType: "queue-depth-gauge" });
    handler({ metricType: "data-loss-count" });
    handler({ metricType: "throughput-rate" });
    flushPanelStatusBuffer();

    expect(getPtyHeldDuration("term-1")).toBeUndefined();
  });

  it("ignores pause-duration-gauge entries for terminals that don't exist as panels", () => {
    setupPanel();
    const handler = getReliabilityHandler();

    handler({
      metricType: "pause-duration-gauge",
      perTerminalHeld: [{ terminalId: "ghost-terminal", heldDurationMs: 9999 }],
    });
    flushPanelStatusBuffer();

    expect(getPtyHeldDuration("term-1")).toBeUndefined();
    expect(usePanelStore.getState().panelsById["ghost-terminal"]).toBeUndefined();
  });

  it("pause-end clears a buffered (but unflushed) heldDurationMs patch", () => {
    // Locks in the cross-frame race fix: a `pause-duration-gauge`
    // patch enqueues a value into the RAF buffer; a `pause-end` arrives
    // before the RAF flushes; the committed (post-flush) value is still
    // `undefined` so an old guard would skip the clear. With the guard
    // removed, the buffer's null-wins semantics correctly clear the
    // buffered non-null patch before flush.
    setupPanel();
    const handler = getReliabilityHandler();

    // Frame 1: gauge arrives, enqueues non-null into buffer (no flush).
    handler({
      metricType: "pause-duration-gauge",
      perTerminalHeld: [{ terminalId: "term-1", heldDurationMs: 2000 }],
    });
    // Do NOT flush — simulate the in-flight RAF.

    // Frame 1 continued: pause-end arrives synchronously, enqueues null.
    handler({ metricType: "pause-end", terminalId: "term-1" });

    // Now flush — the null-wins behavior must clobber the buffered 2000.
    flushPanelStatusBuffer();

    expect(getPtyHeldDuration("term-1")).toBeUndefined();
  });
});

describe("onExit — stale flow state cleared (#9899)", () => {
  function getExitHandler(): (id: string, exitCode: number) => void {
    exitHandlers.length = 0;
    setupLifecycleListeners();
    const handler = exitHandlers.at(-1);
    if (!handler) throw new Error("onExit handler was not registered");
    return handler;
  }

  function getPanel(id: string) {
    const panel = usePanelStore.getState().panelsById[id];
    if (!panel || !isPtyPanel(panel)) return undefined;
    return panel;
  }

  it("clears flowStatus, flowStatusTimestamp, and heldDurationMs on exit", () => {
    // Non-zero exit code preserves the panel so we can inspect the cleared fields.
    setupPanel({
      flowStatus: "paused-backpressure",
      flowStatusTimestamp: 12345,
      heldDurationMs: 8000,
    });

    getExitHandler()("term-1", 1);

    const panel = getPanel("term-1");
    expect(panel?.flowStatus).toBeUndefined();
    expect(panel?.flowStatusTimestamp).toBeUndefined();
    expect(panel?.heldDurationMs).toBeUndefined();
    expect(panel?.runtimeStatus).toBe("exited");
    expect(panel?.exitCode).toBe(1);
  });

  it("a buffered flow-status patch does not resurrect the pill after exit", () => {
    setupPanel({ flowStatus: "paused-backpressure", flowStatusTimestamp: 1 });

    // Simulate an in-flight RAF: enqueue a flow-status patch that has not yet
    // flushed when the terminal exits.
    enqueueFlowStatusUpdate("term-1", "paused-backpressure", 999);

    getExitHandler()("term-1", 1);

    // The exit handler evicts the buffered patch; flushing must not write it back.
    flushPanelStatusBuffer();

    expect(getPanel("term-1")?.flowStatus).toBeUndefined();
  });

  it("a late flow event after exit does not revive the pill", () => {
    setupPanel();
    getExitHandler()("term-1", 1);
    expect(getPanel("term-1")?.runtimeStatus).toBe("exited");

    // A flow event arrives from the dead PTY after exit was processed.
    enqueueFlowStatusUpdate("term-1", "paused-backpressure", 5000);
    flushPanelStatusBuffer();

    expect(getPanel("term-1")?.flowStatus).toBeUndefined();
    expect(getPanel("term-1")?.runtimeStatus).toBe("exited");
  });

  it("evicting one terminal's buffer leaves another terminal's pending patch intact", () => {
    usePanelStore.setState({
      panelsById: {
        "term-1": {
          id: "term-1",
          kind: "terminal",
          title: "T1",
          cwd: "/tmp",
          cols: 80,
          rows: 24,
          location: "grid",
        },
        "term-2": {
          id: "term-2",
          kind: "terminal",
          title: "T2",
          cwd: "/tmp",
          cols: 80,
          rows: 24,
          location: "grid",
          isVisible: true,
        },
      },
      panelIds: ["term-1", "term-2"],
    });

    // Both terminals have a pending flow patch; only term-1 exits.
    enqueueFlowStatusUpdate("term-1", "paused-backpressure", 100);
    enqueueFlowStatusUpdate("term-2", "paused-backpressure", 100);

    getExitHandler()("term-1", 1);
    flushPanelStatusBuffer();

    // term-1's patch was evicted; term-2's still applies.
    expect(getPanel("term-1")?.flowStatus).toBeUndefined();
    expect(getPanel("term-2")?.flowStatus).toBe("paused-backpressure");
  });
});
