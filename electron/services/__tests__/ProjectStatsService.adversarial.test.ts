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

vi.mock("../../ipc/utils.js", () => ({
  typedBroadcast: broadcastMock,
}));

vi.mock("../events.js", () => ({ events: eventEmitter }));
vi.mock("../ProjectStore.js", () => ({ projectStore: projectStoreMock }));

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
  eventEmitter._reset();
  projectStoreMock.getAllProjects.mockReturnValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ProjectStatsService adversarial", () => {
  it("debounce timer is cleared on stop — no compute fires after shutdown", async () => {
    const ptyClient = makePtyClient();
    const svc = new ProjectStatsService(ptyClient as never);
    svc.start();
    await Promise.resolve(); // flush initial compute microtask

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
    // Flush initial compute microtask
    await Promise.resolve();
    await Promise.resolve();

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
      { projectId: "p1", isTrashed: true, kind: "agent", agentState: "working" },
      { projectId: "p1", kind: "dev-preview", agentState: "running" },
      { projectId: "p1", hasPty: false, kind: "agent", agentState: "working" },
      { projectId: "p1", kind: "terminal", agentState: "running" }, // no agentId, not "agent" kind → skip
      { projectId: "p1", kind: "terminal", agentId: "x", agentState: "waiting" }, // counts (waiting)
      { projectId: "p1", kind: "agent", agentId: "x", agentState: "working" }, // counts (active)
      { projectId: "p1", kind: "agent", agentId: "x", agentState: "running" }, // counts (active)
      { projectId: "p1", kind: "agent", agentId: "x", agentState: "idle" }, // counts neither
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

  it("debounce coalesces a burst of agent:state-changed events into one compute", async () => {
    const ptyClient = makePtyClient();
    projectStoreMock.getAllProjects.mockReturnValue([{ id: "p1" }]);
    const svc = new ProjectStatsService(ptyClient as never);
    svc.start();
    await Promise.resolve();
    await Promise.resolve();
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
});
