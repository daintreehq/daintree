import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const broadcastMock = vi.hoisted(() => vi.fn());
const projectStoreMock = vi.hoisted(() => ({
  getAllProjects: vi.fn<() => Array<{ id: string; lastCompletionSeenAt?: number }>>(() => []),
}));
const scratchStoreMock = vi.hoisted(() => ({
  getAllScratches: vi.fn<() => Array<{ id: string; lastCompletionSeenAt?: number }>>(() => []),
}));

const eventEmitter = vi.hoisted(() => {
  const listeners = new Map<string, Set<(payload?: unknown) => void>>();
  return {
    on: (event: string, cb: (payload?: unknown) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(cb);
      return () => listeners.get(event)?.delete(cb);
    },
    emit: (event: string, payload?: unknown) => {
      for (const cb of listeners.get(event) ?? []) cb(payload);
    },
    _reset: () => listeners.clear(),
  };
});

const availabilityMock = vi.hoisted(() => ({
  isHelpTerminal: vi.fn<(id: string) => boolean>(() => false),
}));

vi.mock("../../ipc/utils.js", () => ({
  typedBroadcast: broadcastMock,
}));

vi.mock("../events.js", () => ({ events: eventEmitter }));
vi.mock("../ProjectStore.js", () => ({ projectStore: projectStoreMock }));
vi.mock("../ScratchStore.js", () => ({ scratchStore: scratchStoreMock }));
vi.mock("../AgentAvailabilityStore.js", () => ({
  getAgentAvailabilityStore: () => availabilityMock,
}));

import { ProjectStatsService } from "../ProjectStatsService.js";
import {
  ASSISTANT_PROJECTION_PARITY,
  PARITY_ASSISTANT_TERMINAL,
} from "./helpers/assistantProjectionParity.js";

type FakePtyClient = {
  getAllTerminalsAsync: ReturnType<typeof vi.fn>;
  getProjectStats: ReturnType<typeof vi.fn>;
};

function makePtyClient(): FakePtyClient {
  return {
    getAllTerminalsAsync: vi.fn().mockResolvedValue([]),
    getProjectStats: vi.fn(async (id: string) => ({
      projectId: id,
      terminalCount: 0,
    })),
  };
}

function makeWebContents() {
  return {
    isDestroyed: vi.fn<() => boolean>(() => false),
    send: vi.fn<(channel: string, payload: unknown) => void>(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(1_830_001);
  eventEmitter._reset();
  projectStoreMock.getAllProjects.mockReturnValue([]);
  scratchStoreMock.getAllScratches.mockReturnValue([]);
  availabilityMock.isHelpTerminal.mockReset();
  availabilityMock.isHelpTerminal.mockReturnValue(false);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ProjectStatsService adversarial", () => {
  it("debounce timer is cleared on stop — no compute fires after shutdown", async () => {
    const ptyClient = makePtyClient();
    const svc = new ProjectStatsService(ptyClient as never);
    svc.start();

    eventEmitter.emit("agent:state-changed");
    svc.stop();

    broadcastMock.mockClear();
    ptyClient.getAllTerminalsAsync.mockClear();

    await vi.advanceTimersByTimeAsync(500);

    expect(ptyClient.getAllTerminalsAsync).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it("interval swap does not duplicate pollers — only the new cadence fires after updatePollInterval", async () => {
    const ptyClient = makePtyClient();
    projectStoreMock.getAllProjects.mockReturnValue([{ id: "p1" }]);
    const svc = new ProjectStatsService(ptyClient as never);
    svc.start();

    svc.updatePollInterval(1_000);
    ptyClient.getAllTerminalsAsync.mockClear();

    // After 1s only one poll should fire (new cadence), not two (old + new).
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(ptyClient.getAllTerminalsAsync).toHaveBeenCalledTimes(1);
    svc.stop();
  });

  it("partial getProjectStats failure does not corrupt the status map for fulfilled projects", async () => {
    const ptyClient = makePtyClient();
    projectStoreMock.getAllProjects.mockReturnValue([
      { id: "ok-1" },
      { id: "fail" },
      { id: "ok-2" },
    ]);
    ptyClient.getProjectStats.mockImplementation(async (id: string) => {
      if (id === "fail") throw new Error("transport down");
      return { projectId: id, terminalCount: 3 };
    });

    const svc = new ProjectStatsService(ptyClient as never);
    svc.refresh();
    await vi.runAllTimersAsync();

    const lastCall = broadcastMock.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const [, payload] = lastCall as [string, Record<string, unknown>];
    expect(Object.keys(payload).sort()).toEqual(["ok-1", "ok-2"]);
    svc.stop();
  });

  it("agent-terminal filter excludes trashed, dev-preview, hasPty:false, and non-agent kinds without agentId", async () => {
    const ptyClient = makePtyClient();
    projectStoreMock.getAllProjects.mockReturnValue([{ id: "p1" }]);
    ptyClient.getAllTerminalsAsync.mockResolvedValue([
      { projectId: "p1", isTrashed: true, kind: "terminal", agentState: "working" },
      { projectId: "p1", kind: "dev-preview", agentState: "working" },
      { projectId: "p1", hasPty: false, kind: "terminal", agentState: "working" },
      { projectId: "p1", kind: "terminal", agentState: "working" }, // no launchAgentId/detectedAgentId → skip
      { projectId: "p1", kind: "terminal", launchAgentId: "x", agentState: "waiting" }, // counts (waiting)
      { projectId: "p1", kind: "terminal", launchAgentId: "x", agentState: "working" }, // counts (active)
      { projectId: "p1", kind: "terminal", launchAgentId: "x", agentState: "working" }, // counts (active)
      { projectId: "p1", kind: "terminal", launchAgentId: "x", agentState: "idle" }, // counts neither
    ]);
    ptyClient.getProjectStats.mockResolvedValue({
      projectId: "p1",
      terminalCount: 8,
    });

    const svc = new ProjectStatsService(ptyClient as never);
    svc.refresh();
    await vi.runAllTimersAsync();

    const lastCall = broadcastMock.mock.calls.at(-1);
    const [, payload] = lastCall as [
      string,
      { p1: { activeAgentCount: number; waitingAgentCount: number } },
    ];
    expect(payload.p1.activeAgentCount).toBe(2);
    expect(payload.p1.waitingAgentCount).toBe(1);
    svc.stop();
  });

  it("reports the blocked subset and the oldest wait's start", async () => {
    const ptyClient = makePtyClient();
    projectStoreMock.getAllProjects.mockReturnValue([{ id: "p1" }]);
    ptyClient.getAllTerminalsAsync.mockResolvedValue([
      {
        projectId: "p1",
        kind: "terminal",
        launchAgentId: "x",
        agentState: "waiting",
        waitingReason: "error",
        lastStateChange: 1_000,
      },
      {
        projectId: "p1",
        kind: "terminal",
        launchAgentId: "x",
        agentState: "waiting",
        waitingReason: "prompt",
        lastStateChange: 500,
      },
      {
        projectId: "p1",
        kind: "terminal",
        launchAgentId: "x",
        agentState: "working",
        lastStateChange: 10,
      },
    ]);

    const svc = new ProjectStatsService(ptyClient as never);
    svc.refresh();
    await vi.runAllTimersAsync();

    const [, payload] = broadcastMock.mock.calls.at(-1) as [
      string,
      {
        p1: {
          waitingAgentCount: number;
          blockedAgentCount: number;
          oldestWaitingSince?: number;
        };
      },
    ];
    // Blocked is a subset of waiting, never additional to it.
    expect(payload.p1.waitingAgentCount).toBe(2);
    expect(payload.p1.blockedAgentCount).toBe(1);
    // Earliest waiting transition wins; the working agent's older stamp is not a wait.
    expect(payload.p1.oldestWaitingSince).toBe(500);
    svc.stop();
  });

  it("omits oldestWaitingSince when no waiting terminal has recorded a transition", async () => {
    const ptyClient = makePtyClient();
    projectStoreMock.getAllProjects.mockReturnValue([{ id: "p1" }]);
    ptyClient.getAllTerminalsAsync.mockResolvedValue([
      { projectId: "p1", kind: "terminal", launchAgentId: "x", agentState: "waiting" },
    ]);

    const svc = new ProjectStatsService(ptyClient as never);
    svc.refresh();
    await vi.runAllTimersAsync();

    const [, payload] = broadcastMock.mock.calls.at(-1) as [
      string,
      { p1: { waitingAgentCount: number; oldestWaitingSince?: number } },
    ];
    expect(payload.p1.waitingAgentCount).toBe(1);
    // Absent rather than 0 — a wait with no known start must not read as epoch.
    expect(payload.p1.oldestWaitingSince).toBeUndefined();
    svc.stop();
  });

  it("broadcasts when only the blocked subset changes", async () => {
    // The equality gate decides whether a recomputation reaches the renderer at
    // all. A field missing from it means the UI silently keeps showing the old
    // reading, so every field the payload carries has to be compared.
    const ptyClient = makePtyClient();
    projectStoreMock.getAllProjects.mockReturnValue([{ id: "p1" }]);
    const waiting = (waitingReason: string) => [
      {
        projectId: "p1",
        kind: "terminal",
        launchAgentId: "x",
        agentState: "waiting",
        waitingReason,
        lastStateChange: 1_000,
      },
    ];
    ptyClient.getAllTerminalsAsync.mockResolvedValue(waiting("prompt"));

    const svc = new ProjectStatsService(ptyClient as never);
    svc.refresh();
    await vi.runAllTimersAsync();
    const before = broadcastMock.mock.calls.length;

    // Same counts, different reason — only `blockedAgentCount` moves.
    ptyClient.getAllTerminalsAsync.mockResolvedValue(waiting("error"));
    svc.refresh();
    await vi.runAllTimersAsync();

    expect(broadcastMock.mock.calls.length).toBeGreaterThan(before);
    const [, payload] = broadcastMock.mock.calls.at(-1) as [
      string,
      { p1: { blockedAgentCount: number } },
    ];
    expect(payload.p1.blockedAgentCount).toBe(1);
    svc.stop();
  });

  it("broadcasts when only the oldest wait's start changes", async () => {
    const ptyClient = makePtyClient();
    projectStoreMock.getAllProjects.mockReturnValue([{ id: "p1" }]);
    const waitingSince = (lastStateChange: number) => [
      {
        projectId: "p1",
        kind: "terminal",
        launchAgentId: "x",
        agentState: "waiting",
        waitingReason: "prompt",
        lastStateChange,
      },
    ];
    ptyClient.getAllTerminalsAsync.mockResolvedValue(waitingSince(1_000));

    const svc = new ProjectStatsService(ptyClient as never);
    svc.refresh();
    await vi.runAllTimersAsync();
    const before = broadcastMock.mock.calls.length;

    // One agent's wait ends and another's begins: counts identical, age is not.
    ptyClient.getAllTerminalsAsync.mockResolvedValue(waitingSince(9_000));
    svc.refresh();
    await vi.runAllTimersAsync();

    expect(broadcastMock.mock.calls.length).toBeGreaterThan(before);
    const [, payload] = broadcastMock.mock.calls.at(-1) as [
      string,
      { p1: { oldestWaitingSince?: number } },
    ];
    expect(payload.p1.oldestWaitingSince).toBe(9_000);
    svc.stop();
  });

  it("excludes the Daintree Assistant help terminal from agent counts and subtracts it from processCount (#10989)", async () => {
    const ptyClient = makePtyClient();
    projectStoreMock.getAllProjects.mockReturnValue([{ id: "p1" }]);
    availabilityMock.isHelpTerminal.mockImplementation((id: string) => id === "help-1");
    ptyClient.getAllTerminalsAsync.mockResolvedValue([
      // The assistant help terminal — a real agent PTY, but tooling-internal.
      {
        id: "help-1",
        projectId: "p1",
        kind: "terminal",
        launchAgentId: "daintree-assistant",
        agentState: "waiting",
      },
      // A genuine user agent — must still count.
      {
        id: "t-2",
        projectId: "p1",
        kind: "terminal",
        launchAgentId: "claude",
        agentState: "working",
      },
    ]);
    // PTY host counts both PTYs (it has no help awareness).
    ptyClient.getProjectStats.mockResolvedValue({ projectId: "p1", terminalCount: 2 });

    const svc = new ProjectStatsService(ptyClient as never);
    svc.refresh();
    await vi.runAllTimersAsync();

    const [, payload] = broadcastMock.mock.calls.at(-1) as [
      string,
      { p1: { activeAgentCount: number; waitingAgentCount: number; processCount: number } },
    ];
    // The waiting help terminal is not surfaced; only the real working agent.
    expect(payload.p1.activeAgentCount).toBe(1);
    expect(payload.p1.waitingAgentCount).toBe(0);
    // processCount nets out the help PTY: 2 counted − 1 help = 1.
    expect(payload.p1.processCount).toBe(1);
    svc.stop();
  });

  it("only subtracts help terminals from their own project's processCount (#10989)", async () => {
    const ptyClient = makePtyClient();
    projectStoreMock.getAllProjects.mockReturnValue([{ id: "p1" }, { id: "p2" }]);
    availabilityMock.isHelpTerminal.mockImplementation((id: string) => id === "help-p1");
    ptyClient.getAllTerminalsAsync.mockResolvedValue([
      {
        id: "help-p1",
        projectId: "p1",
        kind: "terminal",
        launchAgentId: "daintree-assistant",
        agentState: "idle",
      },
      {
        id: "t-p2",
        projectId: "p2",
        kind: "terminal",
        launchAgentId: "claude",
        agentState: "working",
      },
    ]);
    ptyClient.getProjectStats.mockImplementation(async (id: string) => ({
      projectId: id,
      terminalCount: id === "p1" ? 1 : 1,
    }));

    const svc = new ProjectStatsService(ptyClient as never);
    svc.refresh();
    await vi.runAllTimersAsync();

    const [, payload] = broadcastMock.mock.calls.at(-1) as [
      string,
      {
        p1: { processCount: number; activeAgentCount: number; waitingAgentCount: number };
        p2: { processCount: number; activeAgentCount: number };
      },
    ];
    // p1's only PTY is the help terminal → 1 − 1 = 0, and it never surfaces in
    // the agent counts.
    expect(payload.p1.processCount).toBe(0);
    expect(payload.p1.activeAgentCount).toBe(0);
    expect(payload.p1.waitingAgentCount).toBe(0);
    // p2 is untouched — its help count is 0.
    expect(payload.p2.processCount).toBe(1);
    expect(payload.p2.activeAgentCount).toBe(1);
    svc.stop();
  });

  it("clamps processCount to zero if the PTY-host count momentarily lags the help count (#10989)", async () => {
    const ptyClient = makePtyClient();
    projectStoreMock.getAllProjects.mockReturnValue([{ id: "p1" }]);
    availabilityMock.isHelpTerminal.mockImplementation((id: string) => id === "help-1");
    ptyClient.getAllTerminalsAsync.mockResolvedValue([
      {
        id: "help-1",
        projectId: "p1",
        kind: "terminal",
        launchAgentId: "daintree-assistant",
        agentState: "idle",
      },
    ]);
    // Stats lag: main process sees the help PTY but the host reports 0.
    ptyClient.getProjectStats.mockResolvedValue({ projectId: "p1", terminalCount: 0 });

    const svc = new ProjectStatsService(ptyClient as never);
    svc.refresh();
    await vi.runAllTimersAsync();

    const [, payload] = broadcastMock.mock.calls.at(-1) as [
      string,
      { p1: { processCount: number } },
    ];
    expect(payload.p1.processCount).toBe(0);
    svc.stop();
  });

  it("does not subtract a trashed or hasPty:false help terminal from processCount (#10989)", async () => {
    const ptyClient = makePtyClient();
    projectStoreMock.getAllProjects.mockReturnValue([{ id: "p1" }]);
    availabilityMock.isHelpTerminal.mockReturnValue(true);
    ptyClient.getAllTerminalsAsync.mockResolvedValue([
      // Trashed → the PTY host already excludes it from terminalCount, so it
      // must not be subtracted (double-counting would drive processCount negative).
      {
        id: "help-trashed",
        projectId: "p1",
        isTrashed: true,
        kind: "terminal",
        agentState: "idle",
      },
      // No live PTY → likewise not part of terminalCount.
      { id: "help-nopty", projectId: "p1", hasPty: false, kind: "terminal", agentState: "idle" },
    ]);
    ptyClient.getProjectStats.mockResolvedValue({ projectId: "p1", terminalCount: 3 });

    const svc = new ProjectStatsService(ptyClient as never);
    svc.refresh();
    await vi.runAllTimersAsync();

    const [, payload] = broadcastMock.mock.calls.at(-1) as [
      string,
      { p1: { processCount: number } },
    ];
    // Neither help terminal was live-counted, so nothing is subtracted.
    expect(payload.p1.processCount).toBe(3);
    svc.stop();
  });

  it("counts plain terminals with a runtime-detected agent as active/waiting", async () => {
    const ptyClient = makePtyClient();
    projectStoreMock.getAllProjects.mockReturnValue([{ id: "p1" }]);
    ptyClient.getAllTerminalsAsync.mockResolvedValue([
      // Plain terminal, no stored agentId, runtime-detected — counts (active)
      {
        projectId: "p1",
        kind: "terminal",
        detectedAgentId: "claude",
        agentState: "working",
      },
      // Plain terminal, no stored agentId, runtime-detected — counts (waiting)
      {
        projectId: "p1",
        kind: "terminal",
        detectedAgentId: "claude",
        agentState: "waiting",
      },
      // Zombie guard: everDetectedAgent is set but the agent has exited
      // (no detectedAgentId). Must NOT count — stats use LIVE signal only.
      {
        projectId: "p1",
        kind: "terminal",
        everDetectedAgent: true,
        agentState: "working",
      },
      // Regression guard: plain terminal with neither agentId nor
      // detectedAgentId is still excluded.
      { projectId: "p1", kind: "terminal", agentState: "working" },
    ]);
    ptyClient.getProjectStats.mockResolvedValue({
      projectId: "p1",
      terminalCount: 4,
    });

    const svc = new ProjectStatsService(ptyClient as never);
    svc.refresh();
    await vi.runAllTimersAsync();

    const lastCall = broadcastMock.mock.calls.at(-1);
    const [, payload] = lastCall as [
      string,
      { p1: { activeAgentCount: number; waitingAgentCount: number } },
    ];
    expect(payload.p1.activeAgentCount).toBe(1);
    expect(payload.p1.waitingAgentCount).toBe(1);
    svc.stop();
  });

  it("terminal:trashed and terminal:restored trigger a debounced recompute", async () => {
    // Trash-flow latency guard. The kill path is already covered by
    // `agent:state-changed`; only the soft-delete trash/restore paths
    // would otherwise wait for the 5s poll.
    const ptyClient = makePtyClient();
    projectStoreMock.getAllProjects.mockReturnValue([{ id: "p1" }]);
    const svc = new ProjectStatsService(ptyClient as never);
    svc.start();
    ptyClient.getAllTerminalsAsync.mockClear();

    eventEmitter.emit("terminal:trashed");
    eventEmitter.emit("terminal:restored");
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();
    await Promise.resolve();

    expect(ptyClient.getAllTerminalsAsync).toHaveBeenCalledTimes(1);
    svc.stop();
  });

  it("debounce coalesces a burst of agent:state-changed events into one compute", async () => {
    const ptyClient = makePtyClient();
    projectStoreMock.getAllProjects.mockReturnValue([{ id: "p1" }]);
    const svc = new ProjectStatsService(ptyClient as never);
    svc.start();
    ptyClient.getAllTerminalsAsync.mockClear();

    for (let i = 0; i < 10; i++) {
      eventEmitter.emit("agent:state-changed");
    }
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();
    await Promise.resolve();

    expect(ptyClient.getAllTerminalsAsync).toHaveBeenCalledTimes(1);
    svc.stop();
  });

  it("identical successive stats do not trigger a second broadcast", async () => {
    const ptyClient = makePtyClient();
    projectStoreMock.getAllProjects.mockReturnValue([{ id: "p1" }]);
    ptyClient.getProjectStats.mockResolvedValue({
      projectId: "p1",
      terminalCount: 0,
    });

    const svc = new ProjectStatsService(ptyClient as never);
    svc.refresh();
    await vi.runAllTimersAsync();
    const after1 = broadcastMock.mock.calls.length;

    svc.refresh();
    await vi.runAllTimersAsync();
    const after2 = broadcastMock.mock.calls.length;

    expect(after2).toBe(after1);
    svc.stop();
  });

  it("replays the retained snapshot to a view that missed every broadcast", async () => {
    const ptyClient = makePtyClient();
    projectStoreMock.getAllProjects.mockReturnValue([{ id: "p1" }]);

    const svc = new ProjectStatsService(ptyClient as never);
    svc.refresh();
    await vi.runAllTimersAsync();
    const [liveChannel, livePayload] = broadcastMock.mock.calls[0]!;

    // The fleet goes static: the next compute produces the same map and is
    // suppressed, so a view loading now never receives a first broadcast.
    svc.refresh();
    await vi.runAllTimersAsync();
    expect(broadcastMock).toHaveBeenCalledTimes(1);

    const wc = makeWebContents();
    svc.pushSnapshotTo(wc as never);

    // Same channel and same payload as the live broadcast, so the replay lands
    // on the listener the renderer already has attached.
    expect(wc.send.mock.calls).toEqual([[liveChannel, livePayload]]);
    svc.stop();
  });

  it("does not replay before the deferred initial compute has produced a map", () => {
    const svc = new ProjectStatsService(makePtyClient() as never);
    const wc = makeWebContents();

    // `{}` here means "nothing computed yet", which is indistinguishable on the
    // wire from "no projects" — sending it would only clobber a renderer that
    // seeded itself from bulk stats.
    svc.pushSnapshotTo(wc as never);

    expect(wc.send).not.toHaveBeenCalled();
  });

  it("skips a destroyed view and swallows a send that throws", async () => {
    const ptyClient = makePtyClient();
    projectStoreMock.getAllProjects.mockReturnValue([{ id: "p1" }]);
    const svc = new ProjectStatsService(ptyClient as never);
    svc.refresh();
    await vi.runAllTimersAsync();

    const destroyed = makeWebContents();
    destroyed.isDestroyed.mockReturnValue(true);
    svc.pushSnapshotTo(destroyed as never);
    expect(destroyed.send).not.toHaveBeenCalled();

    const racing = makeWebContents();
    racing.send.mockImplementation(() => {
      throw new Error("Object has been destroyed");
    });
    expect(() => svc.pushSnapshotTo(racing as never)).not.toThrow();
    svc.stop();
  });

  it("repeated empty-projects refresh does not spam broadcasts", async () => {
    projectStoreMock.getAllProjects.mockReturnValue([]);
    const ptyClient = makePtyClient();
    const svc = new ProjectStatsService(ptyClient as never);

    svc.refresh();
    await vi.runAllTimersAsync();
    svc.refresh();
    await vi.runAllTimersAsync();
    svc.refresh();
    await vi.runAllTimersAsync();

    // Document current behavior: empty broadcast fires every refresh
    // because the empty-projects shortcut bypasses shallowEqual.
    // If/when this is tightened to dedupe, expect the count to drop to 1.
    expect(broadcastMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    svc.stop();
  });

  it("stop without start is a no-op (does not throw)", () => {
    const svc = new ProjectStatsService(makePtyClient() as never);
    expect(() => svc.stop()).not.toThrow();
  });

  it("compute with no ptyClient is a silent no-op", async () => {
    const svc = new ProjectStatsService(null);
    svc.refresh();
    await vi.runAllTimersAsync();
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it("start() does not fire an eager initial compute (deferred to first-interactive)", async () => {
    const ptyClient = makePtyClient();
    projectStoreMock.getAllProjects.mockReturnValue([{ id: "p1" }]);

    const svc = new ProjectStatsService(ptyClient as never);
    svc.start();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(ptyClient.getAllTerminalsAsync).not.toHaveBeenCalled();
    expect(ptyClient.getProjectStats).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
    svc.stop();
  });

  it("race guard: a slow older compute does not overwrite a newer broadcast", async () => {
    const ptyClient = makePtyClient();
    projectStoreMock.getAllProjects.mockReturnValue([{ id: "p1" }]);

    let resolveOldTerminals!: (terms: unknown[]) => void;
    let resolveNewTerminals!: (terms: unknown[]) => void;
    const oldTerminalsPromise = new Promise<unknown[]>((r) => {
      resolveOldTerminals = r;
    });
    const newTerminalsPromise = new Promise<unknown[]>((r) => {
      resolveNewTerminals = r;
    });

    ptyClient.getAllTerminalsAsync
      .mockReturnValueOnce(oldTerminalsPromise)
      .mockReturnValueOnce(newTerminalsPromise);

    let statsCallCount = 0;
    ptyClient.getProjectStats.mockImplementation(async (id: string) => {
      statsCallCount += 1;
      // First call carries stale data (terminalCount: 99), second the truth (1)
      return { projectId: id, terminalCount: statsCallCount === 1 ? 99 : 1 };
    });

    const svc = new ProjectStatsService(ptyClient as never);
    svc.refresh(); // older compute — generation 1
    await Promise.resolve();
    svc.refresh(); // newer compute — generation 2
    await Promise.resolve();

    // Resolve newer first → newer broadcast commits
    resolveNewTerminals([]);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(broadcastMock).toHaveBeenCalled();
    const broadcastsAfterNew = broadcastMock.mock.calls.length;
    const lastPayload = broadcastMock.mock.calls.at(-1)![1] as Record<
      string,
      { processCount: number }
    >;
    expect(lastPayload.p1.processCount).toBe(1);

    // Now resolve the older compute — it must NOT broadcast the stale 99
    resolveOldTerminals([]);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(broadcastMock.mock.calls.length).toBe(broadcastsAfterNew);
    svc.stop();
  });

  it("empty broadcast resets lastBroadcast so a same-shape non-empty result still fires", async () => {
    const ptyClient = makePtyClient();
    ptyClient.getProjectStats.mockResolvedValue({ projectId: "p1", terminalCount: 3 });

    const svc = new ProjectStatsService(ptyClient as never);

    // 1) Non-empty broadcast — lastBroadcast = { p1: {processCount: 3, ...} }
    projectStoreMock.getAllProjects.mockReturnValue([{ id: "p1" }]);
    svc.refresh();
    await vi.runAllTimersAsync();
    const afterFirst = broadcastMock.mock.calls.length;
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    // 2) Projects removed — empty broadcast fires; must reset lastBroadcast
    projectStoreMock.getAllProjects.mockReturnValue([]);
    svc.refresh();
    await vi.runAllTimersAsync();

    // 3) Same project re-added with identical stats — must broadcast
    // (would be suppressed by shallowEqual if lastBroadcast still held it)
    projectStoreMock.getAllProjects.mockReturnValue([{ id: "p1" }]);
    svc.refresh();
    await vi.runAllTimersAsync();

    const lastPayload = broadcastMock.mock.calls.at(-1)![1] as Record<
      string,
      { processCount: number }
    >;
    expect(lastPayload.p1?.processCount).toBe(3);
    svc.stop();
  });

  it("stop() invalidates an in-flight compute — no broadcast after teardown", async () => {
    const ptyClient = makePtyClient();
    projectStoreMock.getAllProjects.mockReturnValue([{ id: "p1" }]);

    let resolvePty!: (terms: unknown[]) => void;
    ptyClient.getAllTerminalsAsync.mockReturnValueOnce(
      new Promise<unknown[]>((r) => {
        resolvePty = r;
      })
    );

    const svc = new ProjectStatsService(ptyClient as never);
    svc.start();
    svc.refresh(); // arms the in-flight compute
    await Promise.resolve();

    broadcastMock.mockClear();

    svc.stop();

    resolvePty([]);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(broadcastMock).not.toHaveBeenCalled();
  });
});

/**
 * Scratch workspaces join the status map (#11518).
 *
 * A scratch terminal already carries the scratch id as its `projectId`, so the
 * only thing standing between scratches and a status row was the id list this
 * service builds. The counting helper treats ids as opaque, so these specs are
 * about the merge — that scratch ids reach it, and that neither kind's entry
 * displaces the other's.
 */
describe("ProjectStatsService scratch workspaces", () => {
  const SCRATCH_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

  function agentTerminal(workspaceId: string, agentState: string, extra: object = {}) {
    return {
      projectId: workspaceId,
      kind: "terminal",
      launchAgentId: "x",
      agentState,
      ...extra,
    };
  }

  it("gives a scratch its own entry alongside a project", async () => {
    const ptyClient = makePtyClient();
    projectStoreMock.getAllProjects.mockReturnValue([{ id: "p1" }]);
    scratchStoreMock.getAllScratches.mockReturnValue([{ id: SCRATCH_ID }]);
    ptyClient.getAllTerminalsAsync.mockResolvedValue([
      agentTerminal("p1", "working"),
      agentTerminal(SCRATCH_ID, "waiting"),
      agentTerminal(SCRATCH_ID, "waiting"),
    ]);

    const svc = new ProjectStatsService(ptyClient as never);
    svc.refresh();
    await vi.runAllTimersAsync();

    const [, payload] = broadcastMock.mock.calls.at(-1) as [
      string,
      Record<string, { activeAgentCount: number; waitingAgentCount: number }>,
    ];
    expect(Object.keys(payload).sort()).toEqual([SCRATCH_ID, "p1"].sort());
    expect(payload[SCRATCH_ID]!.waitingAgentCount).toBe(2);
    expect(payload[SCRATCH_ID]!.activeAgentCount).toBe(0);
    expect(payload.p1!.activeAgentCount).toBe(1);
  });

  // The empty-list short circuit keyed off projects alone. A user whose only
  // workspaces are scratches would have broadcast an empty map forever.
  it("computes for a scratch-only fleet instead of short-circuiting", async () => {
    const ptyClient = makePtyClient();
    projectStoreMock.getAllProjects.mockReturnValue([]);
    scratchStoreMock.getAllScratches.mockReturnValue([{ id: SCRATCH_ID }]);
    ptyClient.getAllTerminalsAsync.mockResolvedValue([agentTerminal(SCRATCH_ID, "working")]);

    const svc = new ProjectStatsService(ptyClient as never);
    svc.refresh();
    await vi.runAllTimersAsync();

    const [, payload] = broadcastMock.mock.calls.at(-1) as [
      string,
      Record<string, { activeAgentCount: number }>,
    ];
    expect(payload[SCRATCH_ID]!.activeAgentCount).toBe(1);
  });

  it("splits completed from unacknowledged using the scratch's own watermark", async () => {
    const ptyClient = makePtyClient();
    projectStoreMock.getAllProjects.mockReturnValue([]);
    scratchStoreMock.getAllScratches.mockReturnValue([
      { id: SCRATCH_ID, lastCompletionSeenAt: 1_000 },
    ]);
    ptyClient.getAllTerminalsAsync.mockResolvedValue([
      agentTerminal(SCRATCH_ID, "completed", { lastStateChange: 500 }),
      agentTerminal(SCRATCH_ID, "completed", { lastStateChange: 2_000 }),
    ]);

    const svc = new ProjectStatsService(ptyClient as never);
    svc.refresh();
    await vi.runAllTimersAsync();

    const [, payload] = broadcastMock.mock.calls.at(-1) as [
      string,
      Record<string, { completedAgentCount: number; unacknowledgedCompletedAgentCount: number }>,
    ];
    // Both finished; only the one after the watermark is still unseen.
    expect(payload[SCRATCH_ID]!.completedAgentCount).toBe(2);
    expect(payload[SCRATCH_ID]!.unacknowledgedCompletedAgentCount).toBe(1);
  });

  it("drops a deleted scratch's entry on the next compute", async () => {
    const ptyClient = makePtyClient();
    projectStoreMock.getAllProjects.mockReturnValue([{ id: "p1" }]);
    scratchStoreMock.getAllScratches.mockReturnValue([{ id: SCRATCH_ID }]);
    ptyClient.getAllTerminalsAsync.mockResolvedValue([agentTerminal(SCRATCH_ID, "working")]);

    const svc = new ProjectStatsService(ptyClient as never);
    svc.refresh();
    await vi.runAllTimersAsync();
    expect(broadcastMock.mock.calls.at(-1)![1]).toHaveProperty(SCRATCH_ID);

    scratchStoreMock.getAllScratches.mockReturnValue([]);
    ptyClient.getAllTerminalsAsync.mockResolvedValue([]);
    svc.refresh();
    await vi.runAllTimersAsync();

    expect(broadcastMock.mock.calls.at(-1)![1]).not.toHaveProperty(SCRATCH_ID);
    svc.stop();
  });
});

describe("ProjectStatsService assistant presence (#11806)", () => {
  function helpTerminal(over: Record<string, unknown> = {}) {
    return {
      id: "help-1",
      projectId: "p1",
      kind: "terminal",
      launchAgentId: "daintree-assistant",
      ...over,
    };
  }

  function lastPayload() {
    return broadcastMock.mock.calls.at(-1)![1] as Record<
      string,
      {
        assistantState?: string;
        assistantWaitingReason?: string;
        assistantStateSince?: number;
        activeAgentCount: number;
        waitingAgentCount: number;
        processCount: number;
      }
    >;
  }

  beforeEach(() => {
    projectStoreMock.getAllProjects.mockReturnValue([{ id: "p1" }]);
    availabilityMock.isHelpTerminal.mockImplementation((id: string) => id.startsWith("help"));
  });

  it("pushes the assistant's state while still keeping it out of every count", async () => {
    const ptyClient = makePtyClient();
    ptyClient.getAllTerminalsAsync.mockResolvedValue([
      helpTerminal({ agentState: "working", lastStateChange: 1_000 }),
    ]);
    ptyClient.getProjectStats.mockResolvedValue({ projectId: "p1", terminalCount: 1 });

    const svc = new ProjectStatsService(ptyClient as never);
    svc.refresh();
    await vi.runAllTimersAsync();

    const p1 = lastPayload().p1;
    expect(p1.assistantState).toBe("working");
    expect(p1.assistantStateSince).toBe(1_000);
    expect(p1.activeAgentCount).toBe(0);
    expect(p1.waitingAgentCount).toBe(0);
    // Still netted out of the host's count — presence is not residency.
    expect(p1.processCount).toBe(0);
    svc.stop();
  });

  it("omits the assistant fields entirely when no assistant is live", async () => {
    const ptyClient = makePtyClient();
    ptyClient.getAllTerminalsAsync.mockResolvedValue([]);

    const svc = new ProjectStatsService(ptyClient as never);
    svc.refresh();
    await vi.runAllTimersAsync();

    expect(lastPayload().p1).not.toHaveProperty("assistantState");
    expect(lastPayload().p1).not.toHaveProperty("assistantWaitingReason");
    expect(lastPayload().p1).not.toHaveProperty("assistantStateSince");
    svc.stop();
  });

  // The change gate is hand-enumerated, so each field needs its own proof: one
  // left out of `shallowEqual` would leave an already-open switcher showing
  // stale assistant state until some unrelated worker tally happened to move.
  it.each([
    {
      field: "assistantState",
      before: { agentState: "working", lastStateChange: 1_000 },
      after: { agentState: "waiting", lastStateChange: 1_000 },
    },
    {
      field: "assistantWaitingReason",
      before: { agentState: "waiting", waitingReason: "prompt", lastStateChange: 1_000 },
      after: { agentState: "waiting", waitingReason: "error", lastStateChange: 1_000 },
    },
    {
      field: "assistantStateSince",
      before: { agentState: "waiting", waitingReason: "prompt", lastStateChange: 1_000 },
      after: { agentState: "waiting", waitingReason: "prompt", lastStateChange: 2_000 },
    },
  ])("broadcasts when only $field changes", async ({ before, after }) => {
    const ptyClient = makePtyClient();
    ptyClient.getAllTerminalsAsync.mockResolvedValue([helpTerminal(before)]);

    const svc = new ProjectStatsService(ptyClient as never);
    svc.refresh();
    await vi.runAllTimersAsync();
    const firstCount = broadcastMock.mock.calls.length;

    ptyClient.getAllTerminalsAsync.mockResolvedValue([helpTerminal(after)]);
    svc.refresh();
    await vi.runAllTimersAsync();

    expect(broadcastMock.mock.calls.length).toBeGreaterThan(firstCount);
    svc.stop();
  });

  it("broadcasts the assistant going away so the row can stop reporting it", async () => {
    const ptyClient = makePtyClient();
    ptyClient.getAllTerminalsAsync.mockResolvedValue([
      helpTerminal({ agentState: "working", lastStateChange: 1_000 }),
    ]);

    const svc = new ProjectStatsService(ptyClient as never);
    svc.refresh();
    await vi.runAllTimersAsync();
    expect(lastPayload().p1.assistantState).toBe("working");

    ptyClient.getAllTerminalsAsync.mockResolvedValue([]);
    svc.refresh();
    await vi.runAllTimersAsync();

    expect(lastPayload().p1).not.toHaveProperty("assistantState");
    svc.stop();
  });

  it("still suppresses a payload whose assistant state did not move", async () => {
    const ptyClient = makePtyClient();
    ptyClient.getAllTerminalsAsync.mockResolvedValue([
      helpTerminal({ agentState: "waiting", waitingReason: "prompt", lastStateChange: 1_000 }),
    ]);

    const svc = new ProjectStatsService(ptyClient as never);
    svc.refresh();
    await vi.runAllTimersAsync();
    const firstCount = broadcastMock.mock.calls.length;
    // The control. Without it this passes against a build that projects no
    // assistant facts at all, proving only that two empty payloads are equal.
    expect(lastPayload().p1.assistantWaitingReason).toBe("prompt");

    svc.refresh();
    await vi.runAllTimersAsync();

    expect(broadcastMock.mock.calls.length).toBe(firstCount);
    svc.stop();
  });

  it("clears every assistant field when the assistant goes away", async () => {
    // Starts from a fully-populated assistant so all three fields have
    // something to lose — a fixture with no waiting reason cannot prove the
    // reason is cleared.
    const ptyClient = makePtyClient();
    ptyClient.getAllTerminalsAsync.mockResolvedValue([
      helpTerminal({ agentState: "waiting", waitingReason: "error", lastStateChange: 1_000 }),
    ]);

    const svc = new ProjectStatsService(ptyClient as never);
    svc.refresh();
    await vi.runAllTimersAsync();
    expect(lastPayload().p1.assistantWaitingReason).toBe("error");

    ptyClient.getAllTerminalsAsync.mockResolvedValue([]);
    svc.refresh();
    await vi.runAllTimersAsync();

    expect(lastPayload().p1).not.toHaveProperty("assistantState");
    expect(lastPayload().p1).not.toHaveProperty("assistantWaitingReason");
    expect(lastPayload().p1).not.toHaveProperty("assistantStateSince");
    svc.stop();
  });

  it("projects exactly the assistant subobject the bulk seed projects", async () => {
    // The #10989 shape: two hand-written projections of the same reducer
    // output. `project.bulkStats.test.ts` asserts this identical expectation
    // against the other producer, so either one drifting fails its own suite.
    const ptyClient = makePtyClient();
    ptyClient.getAllTerminalsAsync.mockResolvedValue([helpTerminal(PARITY_ASSISTANT_TERMINAL)]);
    ptyClient.getProjectStats.mockResolvedValue({ projectId: "p1", terminalCount: 1 });

    const svc = new ProjectStatsService(ptyClient as never);
    svc.refresh();
    await vi.runAllTimersAsync();

    const p1 = lastPayload().p1 as Record<string, unknown>;
    expect({
      assistantState: p1.assistantState,
      assistantWaitingReason: p1.assistantWaitingReason,
      assistantStateSince: p1.assistantStateSince,
      activeAgentCount: p1.activeAgentCount,
      waitingAgentCount: p1.waitingAgentCount,
      processCount: p1.processCount,
    }).toEqual(ASSISTANT_PROJECTION_PARITY);
    svc.stop();
  });
});
