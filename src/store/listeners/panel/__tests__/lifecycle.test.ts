// @vitest-environment jsdom
import { useUIStore } from "@/store/uiStore";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
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
type ExitHandler = (id: string, exitCode: number, context?: { preserveSession?: boolean }) => void;
const exitHandlers = vi.hoisted(() => [] as Array<ExitHandler>);
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
const reduceScrollbackHandlers = vi.hoisted(
  () => [] as Array<(data: { targetLines: number }) => void>
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
      onExit: vi.fn((handler: ExitHandler) => {
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
      onReduceScrollback: vi.fn((handler: (data: { targetLines: number }) => void) => {
        reduceScrollbackHandlers.push(handler);
        return () => {};
      }),
      onRestoreScrollback: vi.fn(noopSub),
    },
  };
});

import { handleFallbackTriggered, setupLifecycleListeners } from "../lifecycle";
import { notify } from "@/lib/notify";
import { flushPanelStatusBuffer, enqueueFlowStatusUpdate } from "@/store/panelStatusBuffer";
import { isPtyPanel } from "@shared/types/panel";
import { load as loadTerminalService } from "@/services/terminal/terminalInstanceServiceAccessor";
import { panelPersistence } from "@/store/persistence/panelPersistence";
import {
  beginBatch,
  resetBatchState,
  takeDeferredPersist,
} from "@/store/slices/panelRegistry/hydrationBatch";

const terminalInstanceService = await loadTerminalService();

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
});

describe("handleFallbackTriggered — activation failure", () => {
  function setupChain(): void {
    useAgentSettingsStore.setState({
      settings: {
        agents: {
          testAgent: {
            customPresets: [
              { id: "preset-1", name: "Primary", fallbacks: ["preset-2"] },
              { id: "preset-2", name: "Fallback" },
            ],
          },
        },
      },
    });
    setupPanel({ agentPresetId: "preset-1", fallbackChainIndex: 0, worktreeId: "/repo/wt-a" });
  }

  const original = usePanelStore.getState().activateFallbackPreset;
  afterEach(() => {
    usePanelStore.setState({ activateFallbackPreset: original });
  });

  it("opts into origin suppression when the spawn failure is shown on the pane", async () => {
    setupChain();
    usePanelStore.setState({
      activateFallbackPreset: vi.fn(async () => {
        const panel = usePanelStore.getState().panelsById["term-1"]!;
        usePanelStore.setState({
          panelsById: {
            "term-1": { ...panel, restartError: { message: "spawn failed" } } as typeof panel,
          },
        });
        return { success: false, error: "spawn failed" };
      }),
    });

    await handleFallbackTriggered({
      terminalId: "term-1",
      agentId: "testAgent",
      fromPresetId: "preset-1",
      reason: "connection",
    });

    const payload = vi.mocked(notify).mock.lastCall![0];
    expect(payload.title).toBe("Fallback activation failed");
    expect(payload.context).toEqual({
      eventKind: "agent",
      panelId: "term-1",
      worktreeId: "/repo/wt-a",
    });
    expect(payload.suppressWhenOriginVisible).toBe(true);
  });

  it("does not suppress a refusal that leaves nothing on the pane", async () => {
    setupChain();
    usePanelStore.setState({
      activateFallbackPreset: vi.fn(async () => ({
        success: false,
        error: "already restarting",
      })),
    });

    await handleFallbackTriggered({
      terminalId: "term-1",
      agentId: "testAgent",
      fromPresetId: "preset-1",
      reason: "connection",
    });

    const payload = vi.mocked(notify).mock.lastCall![0];
    expect(payload.title).toBe("Fallback activation failed");
    expect(payload.suppressWhenOriginVisible).toBe(false);
  });
});

describe("handleFallbackTriggered — rate limits (#14370)", () => {
  const original = usePanelStore.getState().activateFallbackPreset;
  afterEach(() => {
    usePanelStore.setState({ activateFallbackPreset: original });
  });

  function setupChain(
    primary: Record<string, unknown>,
    panel: Record<string, unknown> = {}
  ): ReturnType<typeof vi.fn> {
    useAgentSettingsStore.setState({
      settings: {
        agents: {
          testAgent: {
            customPresets: [
              { id: "preset-1", name: "Primary", fallbacks: ["preset-2", "preset-3"], ...primary },
              { id: "preset-2", name: "Second account" },
              { id: "preset-3", name: "Third account" },
            ],
          },
        },
      },
    });
    setupPanel({ agentPresetId: "preset-1", fallbackChainIndex: 0, ...panel });
    const activate = vi.fn().mockResolvedValue({ success: true });
    usePanelStore.setState({ activateFallbackPreset: activate });
    return activate;
  }

  function trigger(fromPresetId = "preset-1") {
    return handleFallbackTriggered({
      terminalId: "term-1",
      agentId: "testAgent",
      fromPresetId,
      reason: "rate-limit",
    });
  }

  it("hops without asking when the original preset opted in", async () => {
    const activate = setupChain({ fallbackOnRateLimit: true });

    await trigger();

    expect(activate).toHaveBeenCalledWith("term-1", "preset-2", "preset-1");
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Switched to fallback preset",
        message: expect.stringContaining("usage limit"),
        supersedeKey: "terminal.term-1.fallback",
      })
    );
  });

  it("leaves a pane whose preset did not opt in alone, and says nothing", async () => {
    const activate = setupChain({});

    await trigger();

    expect(activate).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("says nothing for an opted-in preset with no chain to walk", async () => {
    const activate = setupChain({ fallbackOnRateLimit: true, fallbacks: undefined });

    await trigger();

    expect(activate).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("walks on from where the pane is, reading the opt-in from the original preset", async () => {
    const activate = setupChain(
      { fallbackOnRateLimit: true },
      { agentPresetId: "preset-2", fallbackChainIndex: 1 }
    );

    await trigger("preset-2");

    expect(activate).toHaveBeenCalledWith("term-1", "preset-3", "preset-1");
  });

  it("stays quiet when the last fallback hits its limit too", async () => {
    const activate = setupChain(
      { fallbackOnRateLimit: true },
      { agentPresetId: "preset-3", fallbackChainIndex: 2 }
    );

    await trigger("preset-3");

    expect(activate).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("ignores an opt-in that came from a team-shared project preset", async () => {
    const activate = setupChain({});
    useProjectPresetsStore.setState({
      presetsByAgent: {
        testAgent: [
          { id: "preset-1", name: "Shared", fallbacks: ["preset-2"], fallbackOnRateLimit: true },
        ],
      },
    });
    useAgentSettingsStore.setState({
      settings: {
        agents: { testAgent: { customPresets: [{ id: "preset-2", name: "Second account" }] } },
      },
    });

    await trigger();

    expect(activate).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("ignores an opt-in on a custom entry the preset merge rejected", async () => {
    const activate = setupChain({});
    useProjectPresetsStore.setState({
      presetsByAgent: {
        testAgent: [{ id: "preset-1", name: "Shared", fallbacks: ["preset-2"] }],
      },
    });
    useAgentSettingsStore.setState({
      settings: {
        agents: {
          testAgent: {
            customPresets: [
              { id: "preset-1", name: "  ", fallbackOnRateLimit: true },
              { id: "preset-2", name: "Second account" },
            ],
          },
        },
      },
    });

    await trigger();

    expect(activate).not.toHaveBeenCalled();
  });

  it("does not hold the in-flight guard after declining", async () => {
    setupChain({});
    await trigger();

    const activate = setupChain({ fallbackOnRateLimit: true });
    await trigger();
    expect(activate).toHaveBeenCalledTimes(1);
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

  it("returns early when the panel is held for recovery", async () => {
    useAgentSettingsStore.setState({
      settings: {
        agents: {
          testAgent: { customPresets: [{ id: "preset-1", name: "Primary", fallbacks: ["gone"] }] },
        },
      },
    });
    setupPanel({ restoreRecovery: { reason: "sibling-owns-session-id" } });

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

  it("leaves focus where it is while an overlay holds the keyboard", () => {
    setupPanel({ location: "grid" });
    usePanelStore.setState({ focusedId: "other" });
    useUIStore.setState({ overlayStack: ["canopy"] });
    try {
      getRestoredHandler()({ id: "term-1" });
      // Focusing the pane would send the keys behind Canopy.
      expect(usePanelStore.getState().focusedId).toBe("other");
    } finally {
      useUIStore.setState({ overlayStack: [] });
    }
  });

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

// Canopy trashes a terminal from main. The host's own trashed event is dropped
// for a pane not already in the trash, so the owning view moves it itself.
describe("onTrashRequested — Canopy trash", () => {
  afterEach(() => {
    delete (window as { electron?: unknown }).electron;
  });

  function getTrashRequestHandler() {
    const handlers: Array<(request: { runId: string }) => void> = [];
    const trash = vi.fn(async () => {});
    Object.defineProperty(window, "electron", {
      value: {
        canopy: {
          onTrashRequested: (handler: (request: { runId: string }) => void) => {
            handlers.push(handler);
            return () => {};
          },
        },
        terminal: { trash },
      },
      configurable: true,
      writable: true,
    });
    setupLifecycleListeners();
    const handler = handlers.at(-1);
    if (!handler) throw new Error("onTrashRequested handler was not registered");
    return { handler, trash };
  }

  it("moves the pane to the trash the way closing it in place would", () => {
    setupPanel();
    usePanelStore.setState({ focusedId: "term-1" });
    const { handler, trash } = getTrashRequestHandler();

    handler({ runId: "term-1" });

    const state = usePanelStore.getState();
    expect(state.panelsById["term-1"]?.location).toBe("trash");
    // Main has trashed it on the host; a second host trash would land after
    // an Undo elsewhere and trash the restored terminal again.
    expect(trash).not.toHaveBeenCalled();
    expect(state.trashedTerminals.has("term-1")).toBe(true);
    expect(state.focusedId).not.toBe("term-1");
  });

  it("hands the grid's focus on only once Canopy, in front of it, has closed", () => {
    setupPanel();
    const first = usePanelStore.getState().panelsById["term-1"]!;
    usePanelStore.setState({
      panelsById: { "term-1": first, "term-2": { ...first, id: "term-2" } },
      panelIds: ["term-1", "term-2"],
      focusedId: "term-1",
    });
    useUIStore.setState({ overlayStack: ["canopy"] });
    try {
      const { handler } = getTrashRequestHandler();
      handler({ runId: "term-1" });
      // No pane behind the panel takes the keyboard from it.
      expect(usePanelStore.getState().focusedId).toBeNull();
      useUIStore.setState({ overlayStack: [] });
      expect(usePanelStore.getState().focusedId).toBe("term-2");
    } finally {
      useUIStore.setState({ overlayStack: [] });
    }
  });

  it("hands focus to a pane still there when the one picked was trashed too before Canopy closed", () => {
    setupPanel();
    const first = usePanelStore.getState().panelsById["term-1"]!;
    usePanelStore.setState({
      panelsById: {
        "term-1": first,
        "term-2": { ...first, id: "term-2" },
        "term-3": { ...first, id: "term-3" },
      },
      panelIds: ["term-1", "term-2", "term-3"],
      focusedId: "term-1",
    });
    useUIStore.setState({ overlayStack: ["canopy"] });
    try {
      const { handler } = getTrashRequestHandler();
      handler({ runId: "term-1" });
      handler({ runId: "term-2" });
      useUIStore.setState({ overlayStack: [] });
      expect(usePanelStore.getState().focusedId).toBe("term-3");
    } finally {
      useUIStore.setState({ overlayStack: [] });
    }
  });

  it("ignores a terminal this view does not hold, or one already in the trash", () => {
    setupPanel({ location: "trash" });
    const before = usePanelStore.getState();
    const { handler } = getTrashRequestHandler();
    handler({ runId: "term-1" });
    handler({ runId: "elsewhere" });
    expect(usePanelStore.getState().trashedTerminals).toBe(before.trashedTerminals);
    expect(usePanelStore.getState().panelsById).toBe(before.panelsById);
  });
});

// Canopy takes back its own trash: main restores it on the host, and the view
// holding the pane brings it out of the trash without restoring it again.
describe("onRestoreRequested — Canopy trash undone", () => {
  afterEach(() => {
    delete (window as { electron?: unknown }).electron;
  });

  function getHandlers() {
    const trashHandlers: Array<(request: { runId: string }) => void> = [];
    const restoreHandlers: Array<(request: { runId: string }) => void> = [];
    const restore = vi.fn(async () => {});
    Object.defineProperty(window, "electron", {
      value: {
        canopy: {
          onTrashRequested: (handler: (request: { runId: string }) => void) => {
            trashHandlers.push(handler);
            return () => {};
          },
          onRestoreRequested: (handler: (request: { runId: string }) => void) => {
            restoreHandlers.push(handler);
            return () => {};
          },
        },
        terminal: { trash: vi.fn(async () => {}), restore },
      },
      configurable: true,
      writable: true,
    });
    setupLifecycleListeners();
    return { trash: trashHandlers.at(-1)!, restoreRequest: restoreHandlers.at(-1)!, restore };
  }

  it("brings a pane Canopy trashed back out of the trash", () => {
    setupPanel();
    const { trash, restoreRequest, restore } = getHandlers();
    trash({ runId: "term-1" });
    expect(usePanelStore.getState().panelsById["term-1"]?.location).toBe("trash");
    restoreRequest({ runId: "term-1" });
    expect(usePanelStore.getState().panelsById["term-1"]?.location).not.toBe("trash");
    // Main restored it on the host already: a second restore could undo a
    // trash another window made in between.
    expect(restore).not.toHaveBeenCalled();
  });

  it("brings the pane back without taking the keyboard from behind Canopy", () => {
    setupPanel();
    usePanelStore.setState({ focusedId: "other" });
    const { trash, restoreRequest } = getHandlers();
    trash({ runId: "term-1" });
    usePanelStore.setState({ focusedId: "other" });
    useUIStore.setState({ overlayStack: ["canopy"] });
    try {
      restoreRequest({ runId: "term-1" });
      expect(usePanelStore.getState().panelsById["term-1"]?.location).not.toBe("trash");
      expect(usePanelStore.getState().focusedId).toBe("other");
    } finally {
      useUIStore.setState({ overlayStack: [] });
    }
  });

  it("keeps a newer trash through the host's late word on Canopy's restore", () => {
    setupPanel();
    restoredHandlers.length = 0;
    const { trash, restoreRequest } = getHandlers();
    const hostRestored = restoredHandlers.at(-1)!;
    trash({ runId: "term-1" });
    restoreRequest({ runId: "term-1" });
    // Trashed again in the grid before the host's restored event arrives.
    usePanelStore.getState().trashPanel("term-1");
    expect(usePanelStore.getState().panelsById["term-1"]?.location).toBe("trash");
    hostRestored({ id: "term-1" });
    expect(usePanelStore.getState().panelsById["term-1"]?.location).toBe("trash");
    expect(usePanelStore.getState().trashedTerminals.has("term-1")).toBe(true);
  });

  it("ignores a pane that isn't in the trash, or one it does not hold", () => {
    setupPanel();
    const { restoreRequest, restore } = getHandlers();
    const before = usePanelStore.getState().panelsById;
    restoreRequest({ runId: "term-1" });
    restoreRequest({ runId: "elsewhere" });
    expect(usePanelStore.getState().panelsById).toBe(before);
    expect(restore).not.toHaveBeenCalled();
  });
});

describe("onRemoveRequested — removed from Canopy's Trash", () => {
  afterEach(() => {
    delete (window as { electron?: unknown }).electron;
  });

  function getHandlers() {
    const removeHandlers: Array<(request: { runId: string }) => void> = [];
    const kill = vi.fn(async () => {});
    Object.defineProperty(window, "electron", {
      value: {
        canopy: {
          onRemoveRequested: (handler: (request: { runId: string }) => void) => {
            removeHandlers.push(handler);
            return () => {};
          },
        },
        terminal: { trash: vi.fn(async () => {}), restore: vi.fn(async () => {}), kill },
      },
      configurable: true,
      writable: true,
    });
    setupLifecycleListeners();
    return { removeRequest: removeHandlers.at(-1)!, kill };
  }

  it("removes the trashed pane for good, ending it as the dock's own Remove does", () => {
    setupPanel();
    const { removeRequest, kill } = getHandlers();
    usePanelStore.getState().trashPanel("term-1");
    removeRequest({ runId: "term-1" });
    expect(usePanelStore.getState().panelsById["term-1"]).toBeUndefined();
    expect(usePanelStore.getState().trashedTerminals.has("term-1")).toBe(false);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("leaves a pane that is out of the trash, and one it does not hold", () => {
    setupPanel();
    const { removeRequest, kill } = getHandlers();
    removeRequest({ runId: "term-1" });
    removeRequest({ runId: "elsewhere" });
    expect(usePanelStore.getState().panelsById["term-1"]).toBeDefined();
    expect(kill).not.toHaveBeenCalled();
  });
});

// Canopy renames a terminal from main, which writes the host and the saved
// state; the view holding the pane renames it as the user's own rename would.
describe("onRenameRequested — Canopy rename", () => {
  afterEach(() => {
    delete (window as { electron?: unknown }).electron;
  });

  function getRenameRequestHandler() {
    const handlers: Array<(request: { runId: string; title: string }) => void> = [];
    Object.defineProperty(window, "electron", {
      value: {
        canopy: {
          onRenameRequested: (handler: (request: { runId: string; title: string }) => void) => {
            handlers.push(handler);
            return () => {};
          },
        },
      },
      configurable: true,
      writable: true,
    });
    setupLifecycleListeners();
    const handler = handlers.at(-1);
    if (!handler) throw new Error("onRenameRequested handler was not registered");
    return handler;
  }

  it("renames the pane, locked against automation like a hand rename", () => {
    setupPanel();
    const handler = getRenameRequestHandler();
    handler({ runId: "term-1", title: "auth fix" });
    expect(usePanelStore.getState().panelsById["term-1"]).toMatchObject({
      title: "auth fix",
      titleMode: "user",
    });
  });

  it("puts back the default for an empty title, and ignores a pane it does not hold", () => {
    setupPanel();
    const handler = getRenameRequestHandler();
    handler({ runId: "term-1", title: "auth fix" });
    handler({ runId: "term-1", title: "" });
    expect(usePanelStore.getState().panelsById["term-1"]?.titleMode).toBe("default");
    const before = usePanelStore.getState().panelsById;
    handler({ runId: "elsewhere", title: "x" });
    expect(usePanelStore.getState().panelsById).toBe(before);
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

  it("does not clear heldDurationMs on an ipc-cap-drop (terminal still paused, #9902)", () => {
    // The hard-cap drop pulse is a data-path telemetry signal, not a
    // resume: the IPC backpressure pause is still held when it fires.
    setupPanel({ heldDurationMs: 7000 });
    const handler = getReliabilityHandler();

    handler({ metricType: "ipc-cap-drop", terminalId: "term-1" });
    flushPanelStatusBuffer();

    expect(getPtyHeldDuration("term-1")).toBe(7000);
  });

  it("ipc-cap-drop followed by a genuine pause-end still clears heldDurationMs", () => {
    // The episode's eventual resume must not be masked by an earlier
    // drop pulse — ordering guard for #9902.
    setupPanel({ heldDurationMs: 7000 });
    const handler = getReliabilityHandler();

    handler({ metricType: "ipc-cap-drop", terminalId: "term-1" });
    flushPanelStatusBuffer();
    expect(getPtyHeldDuration("term-1")).toBe(7000);

    handler({ metricType: "pause-end", terminalId: "term-1" });
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
  function getExitHandler(): ExitHandler {
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

// Sleep, hibernation, idle close and quit signal-kill plain shells, which
// node-pty reports as exit code 0. Main tags those exits so the pane keeps its
// place in the layout it will be restored into, instead of auto-trashing like a
// shell the user typed `exit` in (#13841).
describe("onExit — session-preserving teardown (#13841)", () => {
  beforeEach(() => {
    Object.defineProperty(window, "electron", {
      value: {
        terminal: {
          trash: vi.fn(async () => {}),
          kill: vi.fn(async () => {}),
        },
      },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    delete (window as { electron?: unknown }).electron;
  });

  function getExitHandler(): ExitHandler {
    exitHandlers.length = 0;
    setupLifecycleListeners();
    const handler = exitHandlers.at(-1);
    if (!handler) throw new Error("onExit handler was not registered");
    return handler;
  }

  function setupShell(overrides: Record<string, unknown> = {}) {
    usePanelStore.setState({
      panelsById: {
        shell: {
          id: "shell",
          kind: "terminal",
          title: "Shell",
          cwd: "/tmp",
          cols: 80,
          rows: 24,
          location: "grid" as const,
          ...overrides,
        },
      },
      panelIds: ["shell"],
    });
  }

  function getShell() {
    const panel = usePanelStore.getState().panelsById.shell;
    if (!panel || !isPtyPanel(panel)) return undefined;
    return panel;
  }

  it("keeps a plain shell in place, marked exited, when its exit came from a session-preserving teardown", () => {
    setupShell();

    getExitHandler()("shell", 0, { preserveSession: true });

    const shell = getShell();
    expect(shell?.location).toBe("grid");
    expect(usePanelStore.getState().trashedTerminals.has("shell")).toBe(false);
    expect(shell?.runtimeStatus).toBe("exited");
    expect(shell?.exitCode).toBe(0);
    expect(shell?.sessionPreservingExit).toBe(true);
  });

  it("still trashes a plain shell whose exit carried no teardown context", () => {
    setupShell();

    getExitHandler()("shell", 0);

    expect(getShell()?.location).toBe("trash");
    expect(getShell()?.sessionPreservingExit).toBeUndefined();
  });

  it.each(["trash", "remove", "restart"] as const)(
    "overrides exitBehavior %s so the pane survives into the restored layout",
    (exitBehavior) => {
      setupShell({ location: "dock", exitBehavior });

      getExitHandler()("shell", 0, { preserveSession: true });

      expect(getShell()?.location).toBe("dock");
      expect(getShell()?.sessionPreservingExit).toBe(true);
    }
  );

  it.each([
    ["an agent", { launchAgentId: "claude" }, 0],
    ["a failed shell", {}, 1],
  ])("keeps %s in place and marks it", (_label, overrides, exitCode) => {
    setupShell(overrides);

    getExitHandler()("shell", exitCode, { preserveSession: true });

    expect(getShell()?.location).toBe("grid");
    expect(getShell()?.sessionPreservingExit).toBe(true);
  });

  it("ignores a teardown exit for a pane this view does not hold", () => {
    setupShell();
    const before = usePanelStore.getState().panelsById;

    getExitHandler()("elsewhere", 0, { preserveSession: true });

    expect(usePanelStore.getState().panelsById).toBe(before);
  });

  it("still removes a pane that was already in the trash", () => {
    setupShell({ location: "trash" });

    getExitHandler()("shell", 0, { preserveSession: true });

    expect(usePanelStore.getState().panelsById.shell).toBeUndefined();
  });

  it("still removes a remove-on-exit pane", () => {
    setupShell({ removeOnExit: true });

    getExitHandler()("shell", 0, { preserveSession: true });

    expect(usePanelStore.getState().panelsById.shell).toBeUndefined();
  });

  it("clears the mark when a later exit is not a teardown", () => {
    setupShell({ exitBehavior: "keep" });
    const onExit = getExitHandler();

    onExit("shell", 0, { preserveSession: true });
    expect(getShell()?.sessionPreservingExit).toBe(true);

    onExit("shell", 0);
    expect(getShell()?.sessionPreservingExit).toBeUndefined();
  });
});

describe("onExit — the shown exit is saved with the layout (#15941)", () => {
  function getExitHandler(): ExitHandler {
    exitHandlers.length = 0;
    setupLifecycleListeners();
    const handler = exitHandlers.at(-1);
    if (!handler) throw new Error("onExit handler was not registered");
    return handler;
  }

  function savedShell(save: ReturnType<typeof vi.spyOn>) {
    const terminals = save.mock.lastCall?.[0] as Array<Record<string, unknown>> | undefined;
    return terminals?.find((t) => t.id === "shell");
  }

  function setupShell(overrides: Record<string, unknown> = {}) {
    usePanelStore.setState({
      panelsById: {
        shell: {
          id: "shell",
          kind: "terminal",
          title: "Shell",
          cwd: "/tmp",
          cols: 80,
          rows: 24,
          location: "grid" as const,
          ...overrides,
        },
      },
      panelIds: ["shell"],
    });
  }

  it("saves a kept pane with its exit, so a reload restores the exit", () => {
    const save = vi.spyOn(panelPersistence, "save").mockImplementation(() => {});
    try {
      setupShell();

      getExitHandler()("shell", 3);

      expect(savedShell(save)).toMatchObject({ runtimeStatus: "exited", exitCode: 3 });
    } finally {
      save.mockRestore();
    }
  });

  it("leaves the save to the end of a hydration batch, whose panel list is still partial", () => {
    const save = vi.spyOn(panelPersistence, "save").mockImplementation(() => {});
    beginBatch();
    try {
      setupShell();

      getExitHandler()("shell", 3);

      expect(save).not.toHaveBeenCalled();
      expect(takeDeferredPersist()).toBe(true);
    } finally {
      resetBatchState();
      save.mockRestore();
    }
  });

  it("saves nothing for a session-preserving teardown, which restores a new process", () => {
    const save = vi.spyOn(panelPersistence, "save").mockImplementation(() => {});
    try {
      setupShell();

      getExitHandler()("shell", 1, { preserveSession: true });

      expect(save).not.toHaveBeenCalled();
    } finally {
      save.mockRestore();
    }
  });
});

describe("memory-pressure scrollback reduce (#14215)", () => {
  it("hands the target to the view-wide hidden-terminal reduce", () => {
    const reduceHidden = vi
      .spyOn(terminalInstanceService, "reduceScrollbackHidden")
      .mockImplementation(() => {});
    try {
      reduceScrollbackHandlers.length = 0;
      setupLifecycleListeners();
      const handler = reduceScrollbackHandlers.at(-1);
      if (!handler) throw new Error("onReduceScrollback handler was not registered");

      handler({ targetLines: 500 });

      expect(reduceHidden).toHaveBeenCalledTimes(1);
      expect(reduceHidden).toHaveBeenCalledWith(500);
    } finally {
      reduceHidden.mockRestore();
    }
  });
});
