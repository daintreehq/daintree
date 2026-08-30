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

import { FleetSnapshotService, STALL_QUIET_MS } from "../FleetSnapshotService.js";
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

  it("retains the last known runs, marked stale, when a pty-host shard is unreachable", async () => {
    // PtyClient substitutes [] for a failed shard, so a total outage looks
    // exactly like an idle machine. Publishing that as the run list would tell
    // every view the fleet is clear because the host stopped answering.
    const client = makePtyClient([terminal({ agentState: "waiting", lastStateChange: NOW })]);
    const service = new FleetSnapshotService(client as never);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();
    expect(lastSnapshot().runs).toHaveLength(1);
    expect(lastSnapshot().degraded).toBe(false);

    client.setFleet([], true);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();

    const stale = lastSnapshot();
    expect(stale.degraded).toBe(true);
    expect(stale.runs).toHaveLength(1);
    expect(stale.lastSuccessfulAt).toBe(NOW);
    service.stop();
  });

  it("reports degradation once, not on every poll", async () => {
    const client = makePtyClient([terminal({ agentState: "waiting", lastStateChange: NOW })]);
    const service = new FleetSnapshotService(client as never);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();

    client.setFleet([], true);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();
    const afterFirstDegraded = broadcastMock.mock.calls.length;

    service.refresh();
    await vi.runOnlyPendingTimersAsync();

    // The state is "stale since X", which does not change while it persists.
    expect(broadcastMock).toHaveBeenCalledTimes(afterFirstDegraded);
    service.stop();
  });

  it("says it has never seen the fleet when the very first read is degraded", async () => {
    const client = makePtyClient();
    client.setFleet([], true);
    const service = new FleetSnapshotService(client as never);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();

    // Empty runs AND a null last-success is the "cannot tell you" state, which
    // a renderer must not confuse with an idle fleet.
    const snapshot = lastSnapshot();
    expect(snapshot.degraded).toBe(true);
    expect(snapshot.runs).toEqual([]);
    expect(snapshot.lastSuccessfulAt).toBeNull();
    service.stop();
  });

  it("re-broadcasts on recovery even when the runs are unchanged", async () => {
    const client = makePtyClient([terminal({ agentState: "waiting", lastStateChange: NOW })]);
    const service = new FleetSnapshotService(client as never);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();
    const afterHealthy = broadcastMock.mock.calls.length;

    client.setFleet([], true);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();
    const afterDegraded = broadcastMock.mock.calls.length;
    // Asserted as a TRANSITION, not just as a final state: checking only that
    // the last snapshot is healthy-with-one-run passes even if both the
    // degradation and the recovery were suppressed and this is still the very
    // first broadcast.
    expect(afterDegraded).toBe(afterHealthy + 1);

    // Same fleet as the first healthy read: suppression would normally drop it,
    // but the renderer is currently captioning those rows as stale.
    client.setFleet([terminal({ agentState: "waiting", lastStateChange: NOW })]);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();

    expect(broadcastMock).toHaveBeenCalledTimes(afterDegraded + 1);
    expect(lastSnapshot().degraded).toBe(false);
    expect(lastSnapshot().runs).toHaveLength(1);
    // An unchanged fleet keeps its original change time — recovery is news
    // about reachability, not about the fleet having moved.
    expect(lastSnapshot().changedAt).toBe(NOW);
    service.stop();
  });

  it("dates staleness from the last successful read, not the last broadcast", async () => {
    // The healthy poll that changes nothing is suppressed, but it still proves
    // the fleet was readable. Stamping degradation from the last BROADCAST
    // instead would report data as far older than it is — and the whole point
    // of the caption is telling the user how much to trust what they see.
    const client = makePtyClient([terminal({ agentState: "waiting", lastStateChange: NOW })]);
    const service = new FleetSnapshotService(client as never);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();

    vi.setSystemTime(NOW + 60_000);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();

    vi.setSystemTime(NOW + 120_000);
    client.setFleet([], true);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();

    expect(lastSnapshot().degraded).toBe(true);
    expect(lastSnapshot().lastSuccessfulAt).toBe(NOW + 60_000);
    service.stop();
  });

  it("reports degraded when there is no pty client at all", async () => {
    const service = new FleetSnapshotService(null);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();

    // No client is not "no agents" — it is the same inability to see the fleet,
    // and staying silent strands a boot-time renderer on the loading path.
    expect(lastSnapshot().degraded).toBe(true);
    expect(lastSnapshot().lastSuccessfulAt).toBeNull();
    service.stop();
  });

  it("reports degraded when the read rejects outright", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("host gone"));
    const service = new FleetSnapshotService({
      getAllTerminalsWithCompletenessAsync: fn,
    } as never);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();

    expect(lastSnapshot().degraded).toBe(true);
    service.stop();
  });

  it("does not broadcast from a rejection that settles after stop()", async () => {
    let reject: (e: unknown) => void = () => {};
    const fn = vi.fn().mockImplementation(() => new Promise((_r, rj) => (reject = rj)));
    const service = new FleetSnapshotService({
      getAllTerminalsWithCompletenessAsync: fn,
    } as never);

    service.refresh();
    service.stop();
    reject(new Error("host gone"));
    await vi.runOnlyPendingTimersAsync();

    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it("coalesces triggers that arrive while a read is outstanding", async () => {
    let release: (v: unknown) => void = () => {};
    const fn = vi
      .fn()
      .mockImplementationOnce(() => new Promise((r) => (release = r)))
      .mockResolvedValue({ terminals: [], degraded: false });
    const service = new FleetSnapshotService({
      getAllTerminalsWithCompletenessAsync: fn,
    } as never);

    service.refresh();
    service.refresh();
    service.refresh();
    service.refresh();
    // Every read fans out to every PTY shard, so overlapping them multiplies
    // the most expensive call in the service.
    expect(fn).toHaveBeenCalledTimes(1);

    release({
      terminals: [terminal({ agentState: "waiting", lastStateChange: NOW })],
      degraded: false,
    });
    await vi.runOnlyPendingTimersAsync();

    // Three coalesced triggers become exactly one more read, and the healthy
    // result that was already outstanding still published.
    expect(fn).toHaveBeenCalledTimes(2);
    expect(broadcastMock.mock.calls[0][1].runs[0].agentState).toBe("waiting");
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

  it("re-broadcasts a rename rather than suppressing the run into its old title", async () => {
    // The pty-host record is what carries a rename to this service (#11830).
    // Suppression compares projected rows, so if it ignored the title fields a
    // renamed run would keep broadcasting its launch title until some unrelated
    // state moved.
    // Only the title moves — the mode is held constant so a passing run cannot
    // be explained by the mode comparison alone.
    const client = makePtyClient([
      terminal({ title: "Document GSC access method", titleMode: "user" }),
    ]);
    const service = new FleetSnapshotService(client as never);

    service.refresh();
    await vi.runOnlyPendingTimersAsync();
    expect(broadcastMock).toHaveBeenCalledTimes(1);

    client.setFleet([terminal({ title: "Add Website Valuation tool", titleMode: "user" })]);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();

    expect(broadcastMock).toHaveBeenCalledTimes(2);
    expect(lastSnapshot().runs[0]).toMatchObject({
      title: "Add Website Valuation tool",
      titleMode: "user",
    });

    service.stop();
  });

  it("carries a mode-only unlock, so clearing a rename is not mistaken for no change", async () => {
    // An empty rename resets the title to the identity default and drops the
    // lock. Title and mode move together (#10794): a projection that carried
    // only the title would leave the row claiming a user lock it no longer has.
    const client = makePtyClient([terminal({ title: "Claude", titleMode: "user" })]);
    const service = new FleetSnapshotService(client as never);

    service.refresh();
    await vi.runOnlyPendingTimersAsync();
    expect(broadcastMock).toHaveBeenCalledTimes(1);

    client.setFleet([terminal({ title: "Claude", titleMode: "default" })]);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();

    expect(broadcastMock).toHaveBeenCalledTimes(2);
    expect(lastSnapshot().runs[0].titleMode).toBe("default");

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

  it("recomputes on a rename, which moves no agent state of its own", async () => {
    // Nothing else in the fleet feed reports a rename, so if this event were
    // not subscribed the overview would hold the old title for a full poll.
    const client = makePtyClient([terminal({ title: "Document GSC access method" })]);
    const service = new FleetSnapshotService(client as never);
    service.start();
    service.refresh();
    await vi.runOnlyPendingTimersAsync();
    broadcastMock.mockClear();

    client.setFleet([terminal({ title: "Add Website Valuation tool", titleMode: "user" })]);
    eventEmitter.emit("terminal:title-changed", { id: "t1", timestamp: NOW });
    await vi.advanceTimersByTimeAsync(250);

    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(lastSnapshot().runs[0]?.title).toBe("Add Website Valuation tool");
    service.stop();
  });

  it("recomputes on a cross-worktree move, which moves no agent state either", async () => {
    // The palette groups by `worktreeId`; without this subscription a drag would
    // keep the run under its old heading until the next aligned poll (#12060).
    const client = makePtyClient([terminal({ worktreeId: "/repo" })]);
    const service = new FleetSnapshotService(client as never);
    service.start();
    service.refresh();
    await vi.runOnlyPendingTimersAsync();
    broadcastMock.mockClear();

    client.setFleet([terminal({ worktreeId: "/repo/.worktrees/feature" })]);
    eventEmitter.emit("terminal:worktree-changed", { id: "t1", timestamp: NOW });
    await vi.advanceTimersByTimeAsync(250);

    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(lastSnapshot().runs[0]?.worktreeId).toBe("/repo/.worktrees/feature");
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

  it("decorates a run with its park record", async () => {
    const client = makePtyClient([terminal({ agentState: "waiting", lastStateChange: NOW })]);
    const park = { parkedAt: NOW - 5_000, note: "after the migration", gateRunId: "t9" };
    const attention = { getAll: () => new Map([["t1", park]]), getActiveSnoozes: () => new Map() };
    const service = new FleetSnapshotService(client as never, attention as never);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();

    expect(lastSnapshot().runs[0].park).toEqual(park);
    service.stop();
  });

  it("treats a park change as a fleet change even though no agent state moved", async () => {
    const client = makePtyClient([terminal({ agentState: "waiting", lastStateChange: NOW })]);
    let parks = new Map();
    const attention = { getAll: () => parks, getActiveSnoozes: () => new Map() };
    const service = new FleetSnapshotService(client as never, attention as never);
    service.start();
    service.refresh();
    await vi.runOnlyPendingTimersAsync();
    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(lastSnapshot().runs[0].park).toBeUndefined();

    parks = new Map([["t1", { parkedAt: NOW }]]);
    eventEmitter.emit("terminal:park-changed", { id: "t1", parked: true, timestamp: NOW });
    await vi.advanceTimersByTimeAsync(250);

    expect(broadcastMock).toHaveBeenCalledTimes(2);
    expect(lastSnapshot().runs[0].park).toEqual({ parkedAt: NOW });
    service.stop();
  });

  it("re-broadcasts on a note-only park change, advancing changedAt", async () => {
    const client = makePtyClient([terminal({ agentState: "waiting", lastStateChange: NOW })]);
    let parks = new Map([["t1", { parkedAt: NOW - 10_000, note: "before" }]]);
    const attention = { getAll: () => parks, getActiveSnoozes: () => new Map() };
    const service = new FleetSnapshotService(client as never, attention as never);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();
    const firstChangedAt = lastSnapshot().changedAt;

    // An unchanged park is not a fleet change — suppression must hold.
    vi.setSystemTime(NOW + 5_000);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();
    expect(broadcastMock).toHaveBeenCalledTimes(1);

    // The note is the row's user-facing intent, so editing it alone is news.
    parks = new Map([["t1", { parkedAt: NOW - 10_000, note: "after" }]]);
    vi.setSystemTime(NOW + 10_000);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();

    expect(broadcastMock).toHaveBeenCalledTimes(2);
    expect(lastSnapshot().runs[0].park?.note).toBe("after");
    expect(lastSnapshot().changedAt).toBeGreaterThan(firstChangedAt);
    service.stop();
  });

  it("decorates a run with its snooze record", async () => {
    const client = makePtyClient([terminal({ agentState: "waiting", lastStateChange: NOW })]);
    const snooze = { snoozedAt: NOW - 5_000, snoozedUntil: NOW + 900_000 };
    const attention = {
      getAll: () => new Map(),
      getActiveSnoozes: () => new Map([["t1", snooze]]),
    };
    const service = new FleetSnapshotService(client as never, attention as never);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();

    expect(lastSnapshot().runs[0].snooze).toEqual(snooze);
    service.stop();
  });

  it("treats a snooze change as a fleet change even though no agent state moved", async () => {
    const client = makePtyClient([terminal({ agentState: "waiting", lastStateChange: NOW })]);
    let snoozes = new Map();
    const attention = { getAll: () => new Map(), getActiveSnoozes: () => snoozes };
    const service = new FleetSnapshotService(client as never, attention as never);
    service.start();
    service.refresh();
    await vi.runOnlyPendingTimersAsync();
    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(lastSnapshot().runs[0].snooze).toBeUndefined();

    snoozes = new Map([["t1", { snoozedAt: NOW }]]);
    eventEmitter.emit("terminal:snooze-changed", { id: "t1", snoozed: true, timestamp: NOW });
    await vi.advanceTimersByTimeAsync(250);

    expect(broadcastMock).toHaveBeenCalledTimes(2);
    expect(lastSnapshot().runs[0].snooze).toEqual({ snoozedAt: NOW });
    service.stop();
  });

  it("drops the snooze off the row when it lapses, with no event to announce it", async () => {
    // Expiry owns no timer and emits nothing: the service simply stops being
    // handed the record, and the next poll ships a row without it. This is the
    // whole mechanism by which a lapsed snooze reaches the renderer.
    const client = makePtyClient([terminal({ agentState: "waiting", lastStateChange: NOW })]);
    let snoozes = new Map([["t1", { snoozedAt: NOW - 1_000, snoozedUntil: NOW + 1_000 }]]);
    const attention = { getAll: () => new Map(), getActiveSnoozes: () => snoozes };
    const service = new FleetSnapshotService(client as never, attention as never);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();
    expect(lastSnapshot().runs[0].snooze).toBeDefined();

    // What `getActiveSnoozes` does once the wake time passes.
    snoozes = new Map();
    vi.setSystemTime(NOW + 5_000);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();

    expect(broadcastMock).toHaveBeenCalledTimes(2);
    expect(lastSnapshot().runs[0].snooze).toBeUndefined();
    service.stop();
  });

  it("reports a working run as quiet only past the stall threshold", async () => {
    const longAgo = NOW - 2 * STALL_QUIET_MS;
    const stalledAt = NOW - STALL_QUIET_MS - 60_000;
    const client = makePtyClient([
      terminal({
        id: "stalled",
        agentState: "working",
        spawnedAt: longAgo,
        lastStateChange: stalledAt,
        lastOutputTime: stalledAt,
      }),
      terminal({
        id: "busy",
        agentState: "working",
        spawnedAt: longAgo,
        lastStateChange: longAgo,
        lastOutputTime: NOW - 1_000,
      }),
      // Silence is only a symptom while the agent claims to be WORKING — a
      // waiting run is supposed to be quiet.
      terminal({
        id: "waiting",
        agentState: "waiting",
        spawnedAt: longAgo,
        lastStateChange: stalledAt,
        lastOutputTime: stalledAt,
      }),
    ]);
    const service = new FleetSnapshotService(client as never);
    service.refresh();
    await vi.runOnlyPendingTimersAsync();

    const byId = new Map(lastSnapshot().runs.map((r) => [r.runId, r]));
    expect(byId.get("stalled")?.quietSince).toBe(stalledAt);
    expect(byId.get("busy")?.quietSince).toBeUndefined();
    expect(byId.get("waiting")?.quietSince).toBeUndefined();
    service.stop();
  });

  it("anchors the stall on the working stint, not on output alone", async () => {
    // A run resumed after waiting quietly for twenty minutes enters `working`
    // with an ancient lastOutputTime. Judging by output alone would stamp it
    // "quiet 20m" before it had a chance to make a sound.
    const ancientOutput = NOW - 2 * STALL_QUIET_MS;
    const client = makePtyClient([
      terminal({
        agentState: "working",
        spawnedAt: ancientOutput,
        lastStateChange: NOW - 5_000,
        lastOutputTime: ancientOutput,
      }),
    ]);
    const service = new FleetSnapshotService(client as never);
    service.start();
    service.refresh();
    await vi.runOnlyPendingTimersAsync();
    expect(lastSnapshot().runs[0].quietSince).toBeUndefined();

    // The stint itself going silent past the threshold IS the stall, and the
    // armed poll notices the crossing without any event.
    await vi.advanceTimersByTimeAsync(STALL_QUIET_MS + 30_000);
    expect(lastSnapshot().runs[0].quietSince).toBe(NOW - 5_000);
    service.stop();
  });

  it("stays suppressed while a stall persists — the cue costs one broadcast, not one per poll", async () => {
    const longAgo = NOW - 2 * STALL_QUIET_MS;
    const stalledAt = NOW - STALL_QUIET_MS - 60_000;
    const client = makePtyClient([
      terminal({
        agentState: "working",
        spawnedAt: longAgo,
        lastStateChange: stalledAt,
        lastOutputTime: stalledAt,
      }),
    ]);
    const service = new FleetSnapshotService(client as never);

    for (let i = 0; i < 4; i++) {
      service.refresh();
      await vi.runOnlyPendingTimersAsync();
      vi.setSystemTime(NOW + (i + 1) * 5_000);
    }

    // The wire value is a constant anchor while the silence lasts — a
    // "quiet for Nms" duration would re-broadcast every poll.
    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(lastSnapshot().runs[0].quietSince).toBe(stalledAt);
    service.stop();
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
