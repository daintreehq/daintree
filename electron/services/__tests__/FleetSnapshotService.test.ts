import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const broadcastMock = vi.hoisted(() => vi.fn());

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

vi.mock("../../ipc/utils.js", () => ({ typedBroadcast: broadcastMock }));
vi.mock("../events.js", () => ({ events: eventEmitter }));
vi.mock("../AgentAvailabilityStore.js", () => ({
  getAgentAvailabilityStore: () => availabilityMock,
}));

import { FleetSnapshotService } from "../FleetSnapshotService.js";
import type { FleetSnapshot } from "../../../shared/types/ipc/fleet.js";

const NOW = 1_830_001;

function terminal(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
    projectId: "p1",
    cwd: "/repo",
    spawnedAt: NOW - 60_000,
    detectedAgentId: "claude",
    hasPty: true,
    ...overrides,
  };
}

function makePtyClient(terminals: unknown[] = []) {
  const fn = vi.fn().mockResolvedValue({ terminals, degraded: false });
  return {
    getAllTerminalsWithCompletenessAsync: fn,
    /** Convenience for tests that swap the resolved fleet mid-run. */
    setFleet: (next: unknown[], degraded = false) =>
      fn.mockResolvedValue({ terminals: next, degraded }),
  };
}

function lastSnapshot(): FleetSnapshot {
  const calls = broadcastMock.mock.calls;
  return calls[calls.length - 1][1] as FleetSnapshot;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  eventEmitter._reset();
  availabilityMock.isHelpTerminal.mockReset();
  availabilityMock.isHelpTerminal.mockReturnValue(false);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("FleetSnapshotService", () => {
  it("projects a run per agent terminal, carrying the worktree and the state", async () => {
    const client = makePtyClient([
      terminal({
        id: "t1",
        worktreeId: "wt-9",
        agentState: "waiting",
        waitingReason: "error",
        lastStateChange: NOW - 120_000,
      }),
    ]);
    const service = new FleetSnapshotService(client as never);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();

    const snapshot = lastSnapshot();
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.runs[0]).toMatchObject({
      runId: "t1",
      workspaceId: "p1",
      worktreeId: "wt-9",
      agentState: "waiting",
      waitingReason: "error",
      since: NOW - 120_000,
    });
    service.stop();
  });

  it("excludes the assistant PTY, dev previews, trashed and non-agent terminals", async () => {
    availabilityMock.isHelpTerminal.mockImplementation((id: string) => id === "help");
    const client = makePtyClient([
      terminal({ id: "help" }),
      terminal({ id: "preview", kind: "dev-preview" }),
      terminal({ id: "trashed", isTrashed: true }),
      terminal({ id: "shell", detectedAgentId: undefined }),
      terminal({ id: "dead", hasPty: false }),
      terminal({ id: "real" }),
    ]);
    const service = new FleetSnapshotService(client as never);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();

    expect(lastSnapshot().runs.map((r) => r.runId)).toEqual(["real"]);
    service.stop();
  });

  it("keeps a launch-intent agent only until detection has committed otherwise", async () => {
    const client = makePtyClient([
      terminal({ id: "booting", detectedAgentId: undefined, launchAgentId: "codex" }),
      terminal({
        id: "demoted",
        detectedAgentId: undefined,
        launchAgentId: "codex",
        everDetectedAgent: true,
      }),
    ]);
    const service = new FleetSnapshotService(client as never);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();

    expect(lastSnapshot().runs.map((r) => r.runId)).toEqual(["booting"]);
    service.stop();
  });

  it("drops terminals with no owning workspace", async () => {
    const client = makePtyClient([terminal({ id: "orphan", projectId: undefined })]);
    const service = new FleetSnapshotService(client as never);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();

    expect(lastSnapshot().runs).toEqual([]);
    service.stop();
  });

  it("never publishes a false all-clear when a pty-host shard is unreachable", async () => {
    // PtyClient substitutes [] for a failed shard, so a total outage looks
    // exactly like an idle machine. Broadcasting that would tell every view the
    // fleet is clear because the host stopped answering.
    const client = makePtyClient([terminal({ agentState: "waiting", lastStateChange: NOW })]);
    const service = new FleetSnapshotService(client as never);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();
    expect(lastSnapshot().runs).toHaveLength(1);

    client.setFleet([], true);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();

    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(service.getLastBroadcast()?.runs).toHaveLength(1);
    service.stop();
  });

  it("resumes broadcasting once every shard answers again", async () => {
    const client = makePtyClient([terminal({ agentState: "waiting", lastStateChange: NOW })]);
    const service = new FleetSnapshotService(client as never);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();

    client.setFleet([], true);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();

    client.setFleet([]);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();

    expect(broadcastMock).toHaveBeenCalledTimes(2);
    expect(lastSnapshot().runs).toEqual([]);
    service.stop();
  });

  it("lets a newer compute win when an older one resolves late", async () => {
    let releaseOld: (v: unknown) => void = () => {};
    let releaseNew: (v: unknown) => void = () => {};
    const client = {
      getAllTerminalsWithCompletenessAsync: vi
        .fn()
        .mockImplementationOnce(() => new Promise((r) => (releaseOld = r)))
        .mockImplementationOnce(() => new Promise((r) => (releaseNew = r))),
    };
    const service = new FleetSnapshotService(client as never);

    service.refresh();
    service.refresh();

    releaseNew({
      terminals: [terminal({ agentState: "waiting", lastStateChange: NOW })],
      degraded: false,
    });
    await vi.runOnlyPendingTimersAsync();
    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(lastSnapshot().runs[0].agentState).toBe("waiting");

    // The stale in-flight result must not overwrite the newer fleet.
    releaseOld({
      terminals: [terminal({ agentState: "working", lastStateChange: NOW - 1000 })],
      degraded: false,
    });
    await vi.runOnlyPendingTimersAsync();

    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(service.getLastBroadcast()?.runs[0].agentState).toBe("waiting");
    service.stop();
  });

  it("polls on its own interval without any external trigger", async () => {
    const client = makePtyClient([terminal({ agentState: "working" })]);
    const service = new FleetSnapshotService(client as never);
    service.start();

    await vi.advanceTimersByTimeAsync(5_000);
    const afterFirst = client.getAllTerminalsWithCompletenessAsync.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(afterFirst).toBeGreaterThan(0);
    expect(client.getAllTerminalsWithCompletenessAsync.mock.calls.length).toBeGreaterThan(
      afterFirst
    );
    service.stop();
  });

  it("stops polling after stop and resumes after a restart", async () => {
    const client = makePtyClient([terminal({ agentState: "working" })]);
    const service = new FleetSnapshotService(client as never);
    service.start();
    await vi.advanceTimersByTimeAsync(15_000);
    service.stop();

    const afterStop = client.getAllTerminalsWithCompletenessAsync.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.getAllTerminalsWithCompletenessAsync.mock.calls.length).toBe(afterStop);

    service.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.getAllTerminalsWithCompletenessAsync.mock.calls.length).toBeGreaterThan(
      afterStop
    );
    service.stop();
  });

  it("re-arms on the new cadence when the poll interval changes", async () => {
    // setAlignedInterval fires on wall-clock multiples, so the first tick after
    // a re-arm lands at an offset that depends on the current time. Compare
    // call COUNTS over identical windows rather than asserting on one boundary.
    const WINDOW_MS = 300_000;
    const client = makePtyClient([terminal({ agentState: "working" })]);
    const service = new FleetSnapshotService(client as never);
    service.start();

    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    const fastCalls = client.getAllTerminalsWithCompletenessAsync.mock.calls.length;

    service.updatePollInterval(60_000);
    client.getAllTerminalsWithCompletenessAsync.mockClear();
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    const slowCalls = client.getAllTerminalsWithCompletenessAsync.mock.calls.length;

    expect(fastCalls).toBeGreaterThan(slowCalls * 5);
    expect(slowCalls).toBeGreaterThan(0);
    service.stop();
  });

  it("cancels a scheduled debounce when stopped before it fires", async () => {
    const client = makePtyClient([terminal({ agentState: "working" })]);
    const service = new FleetSnapshotService(client as never);
    service.start();
    client.getAllTerminalsWithCompletenessAsync.mockClear();

    eventEmitter.emit("agent:state-changed");
    service.stop();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(client.getAllTerminalsWithCompletenessAsync).not.toHaveBeenCalled();
  });

  it("coalesces an event burst into a single fetch", async () => {
    const client = makePtyClient([terminal({ agentState: "working" })]);
    const service = new FleetSnapshotService(client as never);
    service.start();
    client.getAllTerminalsWithCompletenessAsync.mockClear();

    eventEmitter.emit("agent:state-changed");
    eventEmitter.emit("terminal:trashed");
    eventEmitter.emit("terminal:restored");
    await vi.advanceTimersByTimeAsync(250);

    expect(client.getAllTerminalsWithCompletenessAsync).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it("replays over the same channel the live broadcast uses", async () => {
    const client = makePtyClient([terminal({ agentState: "waiting", lastStateChange: NOW })]);
    const service = new FleetSnapshotService(client as never);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();

    const [liveChannel, livePayload] = broadcastMock.mock.calls[0] as [string, FleetSnapshot];
    const wc = { isDestroyed: () => false, send: vi.fn() };
    service.pushSnapshotTo(wc as never);

    expect(wc.send).toHaveBeenCalledWith(liveChannel, livePayload);
    service.stop();
  });

  it("sends nothing to a destroyed view", async () => {
    const client = makePtyClient([terminal({ agentState: "waiting", lastStateChange: NOW })]);
    const service = new FleetSnapshotService(client as never);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();

    const wc = { isDestroyed: () => true, send: vi.fn() };
    service.pushSnapshotTo(wc as never);

    expect(wc.send).not.toHaveBeenCalled();
    service.stop();
  });

  it("swallows a send that races view disposal", async () => {
    const client = makePtyClient([terminal({ agentState: "waiting", lastStateChange: NOW })]);
    const service = new FleetSnapshotService(client as never);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();

    const wc = {
      isDestroyed: () => false,
      send: vi.fn(() => {
        throw new Error("Object has been destroyed");
      }),
    };

    expect(() => service.pushSnapshotTo(wc as never)).not.toThrow();
    service.stop();
  });

  it("suppresses an unchanged fleet even though the stamp would differ", async () => {
    const client = makePtyClient([terminal({ agentState: "working" })]);
    const service = new FleetSnapshotService(client as never);

    service.refresh();
    await vi.runOnlyPendingTimersAsync();
    expect(broadcastMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NOW + 30_000);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();
    expect(broadcastMock).toHaveBeenCalledTimes(1);

    service.stop();
  });

  it("stays suppressed while a working agent floods output", async () => {
    // `lastOutputTime` is rewritten on every PTY data chunk, so a working agent
    // changes the host's terminal record many times a second. If the projection
    // ever carries a field like that, suppression dies exactly when the fleet is
    // busiest and every view eats a full run list on every poll.
    let outputAt = NOW;
    const client = {
      getAllTerminalsWithCompletenessAsync: vi.fn(async () => {
        outputAt += 250;
        return {
          terminals: [
            terminal({ agentState: "working", lastStateChange: NOW, lastOutputTime: outputAt }),
          ],
          degraded: false,
        };
      }),
    };
    const service = new FleetSnapshotService(client as never);

    for (let i = 0; i < 5; i++) {
      service.refresh();
      await vi.runOnlyPendingTimersAsync();
      vi.setSystemTime(NOW + (i + 1) * 5_000);
    }

    expect(client.getAllTerminalsWithCompletenessAsync).toHaveBeenCalledTimes(5);
    expect(broadcastMock).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it("broadcasts again once a run actually changes state", async () => {
    const client = makePtyClient([terminal({ agentState: "working" })]);
    const service = new FleetSnapshotService(client as never);

    service.refresh();
    await vi.runOnlyPendingTimersAsync();
    expect(broadcastMock).toHaveBeenCalledTimes(1);

    client.setFleet([terminal({ agentState: "waiting", lastStateChange: NOW })]);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();

    expect(broadcastMock).toHaveBeenCalledTimes(2);
    expect(lastSnapshot().runs[0].agentState).toBe("waiting");
    service.stop();
  });

  it("recomputes on agent state transitions after the debounce", async () => {
    const client = makePtyClient([terminal({ agentState: "working" })]);
    const service = new FleetSnapshotService(client as never);
    service.start();
    service.refresh();
    await vi.runOnlyPendingTimersAsync();
    broadcastMock.mockClear();

    client.setFleet([terminal({ agentState: "completed", lastStateChange: NOW })]);
    eventEmitter.emit("agent:state-changed");
    await vi.advanceTimersByTimeAsync(250);

    expect(broadcastMock).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it("does not broadcast after stop, even for a compute already in flight", async () => {
    const client = makePtyClient([terminal({ agentState: "working" })]);
    const service = new FleetSnapshotService(client as never);
    service.start();

    service.refresh();
    service.stop();
    await vi.runOnlyPendingTimersAsync();

    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it("replays the retained snapshot to a freshly loaded view", async () => {
    const client = makePtyClient([terminal({ agentState: "waiting", lastStateChange: NOW })]);
    const service = new FleetSnapshotService(client as never);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();

    const wc = { isDestroyed: () => false, send: vi.fn() };
    service.pushSnapshotTo(wc as never);

    expect(wc.send).toHaveBeenCalledTimes(1);
    expect((wc.send.mock.calls[0][1] as FleetSnapshot).runs[0].runId).toBe("t1");
    service.stop();
  });

  it("sends nothing to a new view before the first compute", () => {
    const service = new FleetSnapshotService(makePtyClient() as never);
    const wc = { isDestroyed: () => false, send: vi.fn() };

    // "Nothing computed yet" must not render as an empty fleet — only a real
    // empty result may claim the fleet is clear.
    service.pushSnapshotTo(wc as never);

    expect(wc.send).not.toHaveBeenCalled();
  });

  it("broadcasts a genuinely empty fleet so a cleared queue reaches every view", async () => {
    const client = makePtyClient([terminal({ agentState: "waiting", lastStateChange: NOW })]);
    const service = new FleetSnapshotService(client as never);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();

    client.setFleet([]);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();

    expect(lastSnapshot().runs).toEqual([]);
    service.stop();
  });
});
