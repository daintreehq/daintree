// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel } from "@shared/types/panel";
import type {
  AgentState,
  AgentStateChangePayload,
  AgentStateChangeTrigger,
  WorktreeSnapshot,
} from "@shared/types";

const dispatchMock = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));

vi.mock("@/lib/notify", () => ({
  notify: vi.fn(),
}));

vi.mock("@/services/TerminalInstanceService", () => {
  const terminalInstanceService = {
    setAgentState: vi.fn(),
    applyAgentPromotion: vi.fn(),
    clearAgentPromotion: vi.fn(),
  };
  return {
    createTerminalPaintPlane: () => terminalInstanceService,
  };
});

const onAgentStateChangedHandlers = vi.hoisted(
  () => new Set<(data: AgentStateChangePayload) => void>()
);
const onAgentDetectedHandlers = vi.hoisted(() => new Set<(data: unknown) => void>());
const onAgentExitedHandlers = vi.hoisted(() => new Set<(data: unknown) => void>());
vi.mock("@/controllers", () => ({
  terminalRegistryController: {
    onAgentStateChanged: (cb: (data: AgentStateChangePayload) => void) => {
      onAgentStateChangedHandlers.add(cb);
      return () => onAgentStateChangedHandlers.delete(cb);
    },
    onAgentDetected: (cb: (data: unknown) => void) => {
      onAgentDetectedHandlers.add(cb);
      return () => onAgentDetectedHandlers.delete(cb);
    },
    onAgentExited: (cb: (data: unknown) => void) => {
      onAgentExitedHandlers.add(cb);
      return () => onAgentExitedHandlers.delete(cb);
    },
  },
}));

let mockChangedFileCount: number | null = 0;
let mockStoreAvailable = true;
vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStoreOrNull: () => {
    if (!mockStoreAvailable) return null;
    return {
      getState: () => ({
        worktrees: new Map<string, WorktreeSnapshot>([
          [
            "wt-1",
            {
              id: "wt-1",
              path: "/tmp/wt-1",
              worktreeChanges:
                mockChangedFileCount === null
                  ? null
                  : ({
                      worktreeId: "wt-1",
                      rootPath: "/tmp/wt-1",
                      changes: [],
                      changedFileCount: mockChangedFileCount,
                    } as WorktreeSnapshot["worktreeChanges"]),
            } as unknown as WorktreeSnapshot,
          ],
        ]),
      }),
    };
  },
}));

const handleAgentEndMock = vi.hoisted(() => vi.fn());
vi.mock("@/services/terminal/agentEndRecovery", () => ({ handleAgentEnd: handleAgentEndMock }));

import { setupIdentityListeners, _resetChangedFileBaseline } from "../identity";
import {
  clearPluginAgentRegistryForTests,
  setPluginAgentRegistry,
} from "@shared/config/pluginAgentRegistry";
import { notify } from "@/lib/notify";

function makePayload(overrides: Partial<AgentStateChangePayload> = {}): AgentStateChangePayload {
  return {
    terminalId: "term-1",
    state: "working",
    previousState: "idle",
    timestamp: Date.now(),
    trigger: "output" as AgentStateChangeTrigger,
    confidence: 1,
    ...overrides,
  };
}

function setupPanel(overrides: Record<string, unknown> = {}) {
  usePanelStore.setState({
    panelsById: {
      "term-1": {
        id: "term-1",
        kind: "terminal",
        title: "Test Terminal",
        cwd: "/tmp/wt-1",
        cols: 80,
        rows: 24,
        location: "grid" as const,
        worktreeId: "wt-1",
        ...overrides,
      } as unknown as ReturnType<typeof usePanelStore.getState>["panelsById"][string],
    },
    panelIds: ["term-1"],
  });
}

function emitState(payload: AgentStateChangePayload): void {
  for (const cb of onAgentStateChangedHandlers) cb(payload);
}

let _ts = 0;
function nextTimestamp(): number {
  _ts += 1;
  return Date.now() + _ts;
}

beforeEach(() => {
  onAgentStateChangedHandlers.clear();
  onAgentDetectedHandlers.clear();
  onAgentExitedHandlers.clear();
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
  _resetChangedFileBaseline();
  vi.mocked(notify).mockClear();
  dispatchMock.mockClear();
  mockChangedFileCount = 0;
  mockStoreAvailable = true;
  _ts = 0;
});

function transition(state: AgentState, previousState: AgentState, terminalId = "term-1"): void {
  emitState(makePayload({ terminalId, state, previousState, timestamp: nextTimestamp() }));
}

describe("identity listener — completed-with-changes notification", () => {
  it("fires a low-priority inbox notification when changed-file count grew", () => {
    setupPanel();
    const d = setupIdentityListeners();

    mockChangedFileCount = 0;
    transition("working", "idle");

    mockChangedFileCount = 3;
    transition("completed", "working");

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "info",
        priority: "low",
        title: "Agent finished with changes",
        // panelId drives the notification center's "Go to source" affordance;
        // the supersede key retires the prior completion row per worktree.
        context: { worktreeId: "wt-1", panelId: "term-1", eventKind: "completed" },
        supersedeKey: "agent-completed:wt-1",
        action: expect.objectContaining({
          label: "Open Review Hub",
          actionId: "worktree.openReviewHub",
          actionArgs: { worktreeId: "wt-1" },
        }),
      })
    );

    d.dispose();
  });

  it("does not fire when changed-file count did not grow", () => {
    setupPanel();
    const d = setupIdentityListeners();

    mockChangedFileCount = 2;
    transition("working", "idle");
    transition("completed", "working");

    expect(notify).not.toHaveBeenCalled();

    d.dispose();
  });

  it("does not fire when no working state was captured (no baseline)", () => {
    setupPanel();
    const d = setupIdentityListeners();

    // No baseline captured — agent jumps straight to completed. Without a
    // "started" anchor, pre-existing dirty files cannot be distinguished
    // from agent-produced changes, so we suppress the notification.
    mockChangedFileCount = 5;
    transition("completed", "idle");

    expect(notify).not.toHaveBeenCalled();

    d.dispose();
  });

  it("does not double-fire on duplicate completed events", () => {
    setupPanel();
    const d = setupIdentityListeners();

    mockChangedFileCount = 0;
    transition("working", "idle");

    mockChangedFileCount = 3;
    transition("completed", "working");
    expect(notify).toHaveBeenCalledTimes(1);

    // Repeat completed → completed transition should not refire.
    transition("completed", "completed");
    expect(notify).toHaveBeenCalledTimes(1);

    d.dispose();
  });

  it("retains the initial baseline across working↔waiting cycles", () => {
    setupPanel();
    const d = setupIdentityListeners();

    mockChangedFileCount = 5;
    transition("working", "idle");

    mockChangedFileCount = 7;
    transition("waiting", "working");

    mockChangedFileCount = 7;
    transition("working", "waiting");

    // Final count grew beyond initial 5 → notify must fire.
    mockChangedFileCount = 9;
    transition("completed", "working");

    expect(notify).toHaveBeenCalledTimes(1);

    d.dispose();
  });

  it("clears baseline on exited so a fresh session starts from a clean baseline", () => {
    setupPanel();
    const d = setupIdentityListeners();

    mockChangedFileCount = 4;
    transition("working", "idle");
    transition("exited", "working");

    // Next agent run starts — baseline must be re-captured from the
    // current count (4), so a same-count completion does NOT fire.
    mockChangedFileCount = 4;
    transition("working", "idle");
    transition("completed", "working");

    expect(notify).not.toHaveBeenCalled();

    d.dispose();
  });

  it("does not fire when panel has no worktreeId", () => {
    setupPanel({ worktreeId: undefined });
    const d = setupIdentityListeners();

    mockChangedFileCount = 5;
    transition("working", "idle");
    transition("completed", "working");

    expect(notify).not.toHaveBeenCalled();

    d.dispose();
  });

  it("does not fire when the worktree store is unavailable", () => {
    setupPanel();
    mockStoreAvailable = false;
    const d = setupIdentityListeners();

    transition("working", "idle");
    transition("completed", "working");

    expect(notify).not.toHaveBeenCalled();

    d.dispose();
  });

  it("coalesces parallel completions on the same worktree into one inbox entry", () => {
    // Two panels on the same worktree both complete inside the coalesce
    // window — the spec wants one rolled-up entry per worktree.
    usePanelStore.setState({
      panelsById: {
        "term-1": {
          id: "term-1",
          kind: "terminal",
          title: "Terminal 1",
          cwd: "/tmp/wt-1",
          cols: 80,
          rows: 24,
          location: "grid" as const,
          worktreeId: "wt-1",
        } as unknown as ReturnType<typeof usePanelStore.getState>["panelsById"][string],
        "term-2": {
          id: "term-2",
          kind: "terminal",
          title: "Terminal 2",
          cwd: "/tmp/wt-1",
          cols: 80,
          rows: 24,
          location: "grid" as const,
          worktreeId: "wt-1",
        } as unknown as ReturnType<typeof usePanelStore.getState>["panelsById"][string],
      },
      panelIds: ["term-1", "term-2"],
    });
    const d = setupIdentityListeners();

    mockChangedFileCount = 0;
    transition("working", "idle", "term-1");
    transition("working", "idle", "term-2");

    mockChangedFileCount = 3;
    transition("completed", "working", "term-1");
    transition("completed", "working", "term-2");

    expect(notify).toHaveBeenCalledTimes(1);

    d.dispose();
  });

  it("writes lastCheckResult from the payload onto the panel (#10682)", () => {
    setupPanel({ agentState: "working" });
    const d = setupIdentityListeners();

    const checkResult = {
      command: "npm run check",
      passed: false,
      ranAt: nextTimestamp(),
      failureSummary: "Found 2 errors.",
      truncated: false,
    };
    emitState(
      makePayload({
        state: "waiting",
        previousState: "working",
        timestamp: nextTimestamp(),
        lastCheckResult: checkResult,
      })
    );

    const panel = usePanelStore.getState().panelsById["term-1"] as unknown as {
      lastCheckResult?: typeof checkResult;
    };
    expect(panel.lastCheckResult).toEqual(checkResult);

    d.dispose();
  });

  it("leaves lastCheckResult untouched when the payload omits it (#10682)", () => {
    const existing = {
      command: "npm test",
      passed: true,
      ranAt: 123,
      failureSummary: null,
      truncated: false,
    };
    setupPanel({ agentState: "working", lastCheckResult: existing });
    const d = setupIdentityListeners();

    emitState(
      makePayload({ state: "waiting", previousState: "working", timestamp: nextTimestamp() })
    );

    const panel = usePanelStore.getState().panelsById["term-1"] as unknown as {
      lastCheckResult?: typeof existing;
    };
    expect(panel.lastCheckResult).toEqual(existing);

    d.dispose();
  });

  it("writes lastHandback from the payload onto the panel and keeps it on later settles (#12488)", () => {
    setupPanel({ agentState: "working" });
    const d = setupIdentityListeners();

    const handback = {
      message: "rebased onto develop",
      observedAt: nextTimestamp(),
      submissionToken: "tok-1",
      truncated: false,
    };
    emitState(
      makePayload({
        state: "waiting",
        previousState: "working",
        timestamp: nextTimestamp(),
        lastHandback: handback,
      })
    );
    emitState(
      makePayload({ state: "working", previousState: "waiting", timestamp: nextTimestamp() })
    );

    expect(usePanelStore.getState().panelsById["term-1"]).toMatchObject({
      lastHandback: handback,
    });

    d.dispose();
  });

  it("drops lastHandback when the pane leaves exited for a new session (#12488)", () => {
    setupPanel({
      agentState: "exited",
      lastHandback: { message: "old session", observedAt: 1, truncated: false },
    });
    const d = setupIdentityListeners();

    emitState(makePayload({ state: "idle", previousState: "exited", timestamp: nextTimestamp() }));

    expect(usePanelStore.getState().panelsById["term-1"]).toMatchObject({
      agentState: "idle",
      lastHandback: undefined,
    });

    d.dispose();
  });

  it("dispatches worktree.openReviewHub when the action onClick fires", () => {
    setupPanel();
    const d = setupIdentityListeners();

    mockChangedFileCount = 0;
    transition("working", "idle");

    mockChangedFileCount = 2;
    transition("completed", "working");

    const callArgs = vi.mocked(notify).mock.lastCall?.[0];
    expect(callArgs?.action?.onClick).toBeTypeOf("function");
    callArgs?.action?.onClick?.();
    expect(dispatchMock).toHaveBeenCalledWith(
      "worktree.openReviewHub",
      { worktreeId: "wt-1" },
      { source: "user" }
    );

    d.dispose();
  });
});

describe("identity listener — map eviction on panel removal (#10842)", () => {
  function setupTwoPanels() {
    const makePanel = (id: string) =>
      ({
        id,
        kind: "terminal",
        title: id,
        cwd: "/tmp/wt-1",
        cols: 80,
        rows: 24,
        location: "grid" as const,
        worktreeId: "wt-1",
      }) as unknown as ReturnType<typeof usePanelStore.getState>["panelsById"][string];
    usePanelStore.setState({
      panelsById: { "term-1": makePanel("term-1"), "term-2": makePanel("term-2") },
      panelIds: ["term-1", "term-2"],
    });
  }

  it("prunes _changedFileBaseline when a panel disappears without an exit event", () => {
    setupPanel();
    const d = setupIdentityListeners();

    // Capture a baseline of 0 for term-1.
    mockChangedFileCount = 0;
    transition("working", "idle");

    // Force-kill: the panel vanishes from the store with no completed/exited
    // event (the gap this fix closes). The panelIds subscriber must evict the
    // stale baseline.
    usePanelStore.setState({ panelsById: {}, panelIds: [] });

    // A reused-id panel completes without a fresh working event. A surviving
    // baseline (0) would make the grown count (5) fire; a correct prune leaves
    // no baseline, so nothing fires.
    setupPanel();
    mockChangedFileCount = 5;
    transition("completed", "idle");

    expect(notify).not.toHaveBeenCalled();

    d.dispose();
  });

  it("prunes _lastReviewInboxAt when the last PTY panel for a worktree is removed", () => {
    setupPanel();
    const d = setupIdentityListeners();

    mockChangedFileCount = 0;
    transition("working", "idle");
    mockChangedFileCount = 3;
    transition("completed", "working");
    expect(notify).toHaveBeenCalledTimes(1); // records _lastReviewInboxAt[wt-1]

    // The worktree's last panel goes away → its coalesce timestamp must evict.
    usePanelStore.setState({ panelsById: {}, panelIds: [] });

    // A brand-new agent on wt-1 completing within the 5s coalesce window must
    // still notify; a surviving stale timestamp would suppress it.
    setupPanel();
    mockChangedFileCount = 3;
    transition("working", "idle");
    mockChangedFileCount = 6;
    transition("completed", "working");
    expect(notify).toHaveBeenCalledTimes(2);

    d.dispose();
  });

  it("retains _lastReviewInboxAt while another PTY panel for the worktree survives", () => {
    setupTwoPanels();
    const d = setupIdentityListeners();

    mockChangedFileCount = 0;
    transition("working", "idle", "term-1");
    transition("working", "idle", "term-2");

    mockChangedFileCount = 3;
    transition("completed", "working", "term-1");
    expect(notify).toHaveBeenCalledTimes(1); // records _lastReviewInboxAt[wt-1]

    // Remove only term-1; term-2 keeps wt-1 alive, so the coalesce timestamp
    // must be retained (no over-pruning).
    const survivor = usePanelStore.getState().panelsById["term-2"]!;
    usePanelStore.setState({ panelsById: { "term-2": survivor }, panelIds: ["term-2"] });

    // term-2 completes within the window → coalesced, no second notify.
    mockChangedFileCount = 6;
    transition("completed", "working", "term-2");
    expect(notify).toHaveBeenCalledTimes(1);

    d.dispose();
  });
});

describe("identity listener — agentIncarnation sync (#12535)", () => {
  it("follows the host downward after a pty-host replay restarts the count", () => {
    setupPanel({ agentState: "idle", agentIncarnation: 2 });
    const d = setupIdentityListeners();
    const written: string[] = [];
    const off = usePanelStore.subscribe((state) => {
      const panel = state.panelsById["term-1"];
      if (panel && isPtyPanel(panel)) written.push(`${panel.agentState}:${panel.agentIncarnation}`);
    });

    // The replacement record starts at zero. A panel that held 2 forward would
    // go on naming a session that no longer exists.
    emitState(
      makePayload({
        state: "working",
        previousState: "idle",
        timestamp: nextTimestamp(),
        agentIncarnation: 0,
      })
    );
    off();

    expect(usePanelStore.getState().panelsById["term-1"]).toMatchObject({
      agentIncarnation: 0,
    });
    // The new state is never readable beside its predecessor's count.
    expect(written).not.toContain("working:2");

    d.dispose();
  });

  it("leaves the existing count untouched when the event carries none", () => {
    setupPanel({ agentState: "idle", agentIncarnation: 2 });
    const d = setupIdentityListeners();

    emitState(makePayload({ state: "working", previousState: "idle", timestamp: nextTimestamp() }));

    expect(usePanelStore.getState().panelsById["term-1"]).toMatchObject({
      agentIncarnation: 2,
    });

    d.dispose();
  });
});

describe("identity listener — a host whose clock runs behind this machine's (#16062)", () => {
  const HOST_LAG_MS = 60_000;

  it("takes the host's working report after this machine stamped its own overlay", () => {
    const hostNow = Date.now() - HOST_LAG_MS;
    setupPanel();
    const d = setupIdentityListeners();
    emitState(makePayload({ state: "waiting", previousState: "working", timestamp: hostNow }));

    // A composer draft puts the pane in directing and leaving it reverts to the
    // last reported state, both stamped with this machine's clock.
    usePanelStore.getState().updateAgentState("term-1", "directing");
    usePanelStore.getState().updateAgentState("term-1", "waiting");

    emitState(
      makePayload({ state: "working", previousState: "waiting", timestamp: hostNow + 5_000 })
    );

    expect(usePanelStore.getState().panelsById["term-1"]).toMatchObject({
      agentState: "working",
      lastStateChange: hostNow + 5_000,
    });
    d.dispose();
  });

  it("records a waiting report it keeps off a directing pane, so nothing older follows it", () => {
    const hostNow = Date.now() - HOST_LAG_MS;
    setupPanel({ agentState: "directing" });
    const d = setupIdentityListeners();

    emitState(
      makePayload({ state: "waiting", previousState: "working", timestamp: hostNow + 10_000 })
    );
    expect(usePanelStore.getState().panelsById["term-1"]).toMatchObject({
      agentState: "directing",
      lastAgentObservation: { agentState: "waiting", at: hostNow + 10_000 },
    });

    emitState(
      makePayload({ state: "working", previousState: "waiting", timestamp: hostNow + 5_000 })
    );
    expect(usePanelStore.getState().panelsById["term-1"]).toMatchObject({
      agentState: "directing",
    });
    d.dispose();
  });

  it("still drops a report from before the state the host last reported", () => {
    const hostNow = Date.now() - HOST_LAG_MS;
    setupPanel();
    const d = setupIdentityListeners();
    emitState(
      makePayload({ state: "waiting", previousState: "working", timestamp: hostNow + 10_000 })
    );
    emitState(
      makePayload({ state: "working", previousState: "waiting", timestamp: hostNow + 5_000 })
    );

    expect(usePanelStore.getState().panelsById["term-1"]).toMatchObject({
      agentState: "waiting",
    });
    d.dispose();
  });
});

describe("identity listener — a launched run's end (#16045)", () => {
  it.each([
    ["a pane never restarted", undefined, 0],
    ["a restarted pane", 3, 3],
  ])(
    "hands recovery the restart count the run ended on, for %s",
    async (_label, restartKey, expected) => {
      handleAgentEndMock.mockClear();
      setupPanel({ launchAgentId: "codex", detectedAgentId: "codex", restartKey });
      const d = setupIdentityListeners();

      const payload = {
        terminalId: "term-1",
        agentType: "codex",
        timestamp: nextTimestamp(),
        exitKind: "subcommand",
        agentEnd: {
          launchedRun: true,
          resumeHintSeen: false,
          selfUpdateSucceeded: false,
          resumeRefused: true,
        },
      };
      for (const cb of onAgentExitedHandlers) cb(payload);
      // A switch lands while recovery loads.
      const panel = usePanelStore.getState().panelsById["term-1"];
      if (!panel || !isPtyPanel(panel)) throw new Error("pane missing");
      usePanelStore.setState({ panelsById: { "term-1": { ...panel, restartKey: expected + 1 } } });

      await vi.waitFor(() => expect(handleAgentEndMock).toHaveBeenCalledTimes(1));
      expect(handleAgentEndMock).toHaveBeenCalledWith(payload, expected);
      d.dispose();
    }
  );
});

describe("identity listener — plugin agent in a plain terminal (#16469)", () => {
  const PI = {
    id: "pi",
    name: "Pi",
    command: "pi",
    color: "#3366ff",
    iconId: "terminal",
    supportsContextInjection: false,
    executableNames: ["pi"],
  };

  function detect(agentType: string): void {
    for (const cb of onAgentDetectedHandlers) {
      cb({ terminalId: "term-1", agentType, processName: agentType, timestamp: nextTimestamp() });
    }
  }

  function pane() {
    const panel = usePanelStore.getState().panelsById["term-1"];
    if (!panel || !isPtyPanel(panel)) throw new Error("pane missing");
    return panel;
  }

  beforeEach(() => {
    clearPluginAgentRegistryForTests();
  });
  afterEach(() => {
    clearPluginAgentRegistryForTests();
  });

  it("takes the plugin agent's identity and name", () => {
    setPluginAgentRegistry({ pi: PI });
    setupPanel();
    const d = setupIdentityListeners();

    detect("pi");

    expect(pane()).toMatchObject({
      detectedAgentId: "pi",
      everDetectedAgent: true,
      agentState: "idle",
      title: "Pi",
      runtimeIdentity: expect.objectContaining({ kind: "agent", agentId: "pi" }),
    });
    d.dispose();
  });

  it("keeps the host's identity when this view's plugin registry hasn't arrived", () => {
    setupPanel();
    const d = setupIdentityListeners();

    detect("pi");
    expect(pane().detectedAgentId).toBe("pi");

    // The registry lands afterwards and names the pane.
    setPluginAgentRegistry({ pi: PI });
    expect(pane().title).toBe("Pi");

    // A plugin reload that renames its agent renames the pane too.
    setPluginAgentRegistry({ pi: { ...PI, name: "Pi Agent" } });
    expect(pane().title).toBe("Pi Agent");
    d.dispose();
  });

  it("leaves a renamed pane's title alone when the registry changes", () => {
    setupPanel({ titleMode: "user", title: "My pane" });
    const d = setupIdentityListeners();
    detect("pi");

    setPluginAgentRegistry({ pi: PI });

    expect(pane().title).toBe("My pane");
    d.dispose();
  });

  it("goes back to a plain terminal when the host revokes it", () => {
    setPluginAgentRegistry({ pi: PI });
    setupPanel();
    const d = setupIdentityListeners();
    detect("pi");

    // The host revokes once the plugin is gone; this view hears both.
    setPluginAgentRegistry({});
    for (const cb of onAgentExitedHandlers) {
      cb({
        terminalId: "term-1",
        agentType: "pi",
        timestamp: nextTimestamp(),
        exitKind: "subcommand",
      });
    }

    expect(pane()).toMatchObject({ agentState: "exited", title: "Terminal" });
    expect(pane().detectedAgentId).toBeUndefined();
    expect(pane().runtimeIdentity).toBeUndefined();
    d.dispose();
  });
});
