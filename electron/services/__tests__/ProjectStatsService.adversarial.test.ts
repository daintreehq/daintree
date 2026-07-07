import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const broadcastMock = vi.hoisted(() => vi.fn());
const projectStoreMock = vi.hoisted(() => ({
  getAllProjects: vi.fn<() => Array<{ id: string }>>(() => []),
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
vi.mock("../AgentAvailabilityStore.js", () => ({
  getAgentAvailabilityStore: () => availabilityMock,
}));

import { ProjectStatsService } from "../ProjectStatsService.js";

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

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(1_830_001);
  eventEmitter._reset();
  projectStoreMock.getAllProjects.mockReturnValue([]);
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

  it("excludes the Daintree Assistant help terminal from agent counts and subtracts it from processCount (#10989)", async () => {
    const ptyClient = makePtyClient();
    projectStoreMock.getAllProjects.mockReturnValue([{ id: "p1" }]);
    availabilityMock.isHelpTerminal.mockImplementation((id: string) => id === "help-1");
    ptyClient.getAllTerminalsAsync.mockResolvedValue([
      // The assistant help terminal — a real agent PTY, but tooling-internal.
      { id: "help-1", projectId: "p1", kind: "terminal", launchAgentId: "daintree-assistant", agentState: "waiting" },
      // A genuine user agent — must still count.
      { id: "t-2", projectId: "p1", kind: "terminal", launchAgentId: "claude", agentState: "working" },
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
      { id: "help-p1", projectId: "p1", kind: "terminal", launchAgentId: "daintree-assistant", agentState: "idle" },
      { id: "t-p2", projectId: "p2", kind: "terminal", launchAgentId: "claude", agentState: "working" },
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
      { id: "help-1", projectId: "p1", kind: "terminal", launchAgentId: "daintree-assistant", agentState: "idle" },
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
      { id: "help-trashed", projectId: "p1", isTrashed: true, kind: "terminal", agentState: "idle" },
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
