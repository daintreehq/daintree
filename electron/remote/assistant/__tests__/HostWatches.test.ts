import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HOST_WATCHES_PER_RUN_MAX,
  HOST_WATCH_CONNECTION_SETTLE_MS,
  type HostWatchArgs,
} from "../../../../shared/types/hostControl.js";
import type { HostConnectionState, HostMetricsSummary } from "../../../../shared/types/remoteHosts.js";
import type { LaneWake } from "../../../services/mcp-server/terminalNotify.js";
import { formatHostWatchLine } from "../../../services/mcp-server/noticeFormat.js";
import type { ObservedHost, OpenRun } from "../HostCallRuntime.js";
import { HostWatches, type HostWatchListener } from "../HostWatches.js";

const RUN: OpenRun = {
  projectId: "proj-1",
  slot: 0,
  sessionId: "a",
  terminalId: "t-a",
  launchGeneration: 1,
};

const CONNECTED: HostConnectionState = {
  status: "connected",
  rttMs: 12,
  handshake: {
    version: "1.0.0",
    commit: "abc",
    protocolVersion: 1,
    platform: "linux",
    arch: "x64",
  } as never,
};

const GIB = 1024 ** 3;

describe("HostWatches (#14463)", () => {
  let now: number;
  let hosts: ObservedHost[];
  let control: Set<string>;
  let running: Set<string>;
  let listener: HostWatchListener | null;
  let subscriptions: number;
  let queued: Array<{ lane: { helpSessionId: string; terminalId: string }; wake: LaneWake }>;
  let ids: number;
  let watches: HostWatches;

  const summary = (overrides: Partial<HostMetricsSummary> = {}): HostMetricsSummary =>
    ({
      hostId: "studio",
      sampledAt: now,
      platform: "linux",
      cpuPercent: 50,
      cpuLogicalCoreCount: 8,
      memoryPressure: "normal",
      memoryUsedBytes: 12 * GIB,
      memoryTotalBytes: 16 * GIB,
      swapUsedBytes: null,
      thermal: null,
      ...overrides,
    }) as HostMetricsSummary;

  const studio = (overrides: Partial<ObservedHost> = {}): ObservedHost => ({
    hostId: "studio",
    name: "studio-01",
    connection: { status: "disconnected" },
    lastSeenAt: null,
    summary: null,
    ...overrides,
  });

  const setStudio = (overrides: Partial<ObservedHost>): void => {
    hosts = [studio({ ...hosts.find((h) => h.hostId === "studio"), ...overrides })];
  };

  const runKey = (run: OpenRun) => `${run.sessionId}:${run.launchGeneration}`;

  const make = (opts: { observe?: boolean; queue?: boolean } = {}) =>
    new HostWatches({
      hosts: () => hosts,
      controlOn: (hostId) => control.has(hostId),
      stillRunning: (run) => running.has(runKey(run)),
      ...(opts.observe === false
        ? {}
        : {
            observe: (next: HostWatchListener) => {
              listener = next;
              subscriptions += 1;
              return () => {
                listener = null;
                subscriptions -= 1;
              };
            },
          }),
      ...(opts.queue === false
        ? {}
        : { queueNotice: (lane, wake) => queued.push({ lane, wake }) }),
      now: () => now,
      newId: () => `id-${++ids}`,
    });

  const arm = (args: Partial<HostWatchArgs> = {}, run: OpenRun = RUN) =>
    watches.run(run, { operation: "arm", hostId: "studio", connection: "connected", ...args });

  const advance = (ms: number) => {
    now += ms;
    vi.advanceTimersByTime(ms);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    now = Date.parse("2026-10-25T10:00:00Z");
    vi.setSystemTime(now);
    hosts = [studio()];
    control = new Set(["studio"]);
    running = new Set([runKey(RUN)]);
    listener = null;
    subscriptions = 0;
    queued = [];
    ids = 0;
    watches = make();
  });

  afterEach(() => {
    watches.dispose();
    vi.useRealTimers();
  });

  it("holds no listener and no timer while nothing is armed", () => {
    expect(watches.isActive()).toBe(false);
    expect(subscriptions).toBe(0);
    watches.run(RUN, { operation: "list" });
    expect(watches.isActive()).toBe(false);
  });

  it("returns what it armed, its expiry and how to cancel it", () => {
    const result = arm({ note: "place the backlog", expiresInSeconds: 600 });
    expect(result.outcome).toBe("ok");
    expect(result.armed).toBe(true);
    expect(result.watches[0]).toMatchObject({
      watchId: "hw-id-1",
      hostId: "studio",
      hostName: "studio-01",
      status: "armed",
      armedAt: now,
      expiresAt: now + 600_000,
      note: "place the backlog",
      delivery: "none",
    });
    expect(result.detail).toMatch(/operation cancel/);
    expect(result.observed).toMatchObject({ observedAt: now, link: "disconnected", sampledAt: null });
    expect(subscriptions).toBe(1);
  });

  it("fires once on a reconnect that holds through the settle, then lets go of everything", () => {
    arm({ note: "place it" });
    setStudio({ connection: CONNECTED, lastSeenAt: now });
    listener?.changed();
    expect(queued).toHaveLength(0);
    advance(HOST_WATCH_CONNECTION_SETTLE_MS);
    expect(queued).toHaveLength(1);
    const { lane, wake } = queued[0];
    expect(lane).toMatchObject({ helpSessionId: "a", terminalId: "t-a" });
    expect(wake.kind).toBe("watch");
    expect(wake.hostWatch).toMatchObject({ event: "fired", watchId: "hw-id-1", note: "place it" });
    expect(wake.recheck()).toEqual({ kind: "ready" });
    expect(watches.isActive()).toBe(false);
    expect(subscriptions).toBe(0);

    const line = formatHostWatchLine(wake.hostWatch!);
    expect(line).toContain('host "studio-01" watch hw-id-1');
    expect(line).toContain("link connected");
    expect(line).toMatch(/not a promise/);
    expect(line).toMatch(/host\.list/);

    // Later flaps after the fire are nobody's business.
    setStudio({ connection: { status: "disconnected" } });
    setStudio({ connection: CONNECTED });
    advance(HOST_WATCH_CONNECTION_SETTLE_MS * 3);
    expect(queued).toHaveLength(1);
  });

  it("does not fire on a link that flaps back inside the settle", () => {
    arm();
    setStudio({ connection: CONNECTED });
    listener?.changed();
    advance(HOST_WATCH_CONNECTION_SETTLE_MS - 1_000);
    setStudio({ connection: { status: "connecting", attempt: 1 } });
    listener?.changed();
    advance(2_000);
    expect(queued).toHaveLength(0);
    setStudio({ connection: CONNECTED });
    listener?.changed();
    advance(HOST_WATCH_CONNECTION_SETTLE_MS);
    expect(queued).toHaveLength(1);
  });

  it("arms nothing for a condition already observed", () => {
    setStudio({ connection: CONNECTED });
    const result = arm();
    expect(result).toMatchObject({ outcome: "ok", armed: false, watches: [] });
    expect(result.observed?.link).toBe("connected");
    expect(subscriptions).toBe(0);
  });

  it("watches a link go down: neither connected nor still connecting", () => {
    setStudio({ connection: CONNECTED });
    arm({ connection: "disconnected" });
    setStudio({ connection: { status: "connecting", attempt: 1 } });
    listener?.changed();
    advance(HOST_WATCH_CONNECTION_SETTLE_MS * 2);
    expect(queued).toHaveLength(0);
    setStudio({ connection: { status: "unreachable", lastSeenAt: now, detail: null } });
    listener?.changed();
    advance(HOST_WATCH_CONNECTION_SETTLE_MS);
    expect(queued[0]?.wake.hostWatch?.observed?.link).toBe("unreachable");
  });

  describe("capacity", () => {
    const capacity = { connection: undefined, memoryAvailableBytesAtLeast: 8 * GIB };

    it("fires on a fresh sample that crosses every figure named", () => {
      setStudio({ connection: CONNECTED, summary: summary() });
      expect(arm({ ...capacity, cpuIdleCoresAtLeast: 2 }).armed).toBe(true);
      // 4 GiB available: not yet.
      listener?.summary("studio");
      expect(queued).toHaveLength(0);
      setStudio({ summary: summary({ memoryUsedBytes: 6 * GIB, cpuPercent: 90 }) });
      listener?.summary("studio");
      // Memory is there, idle cores aren't.
      expect(queued).toHaveLength(0);
      setStudio({ summary: summary({ memoryUsedBytes: 6 * GIB, cpuPercent: 25 }) });
      listener?.summary("studio");
      expect(queued).toHaveLength(1);
      const observed = queued[0].wake.hostWatch?.observed;
      expect(observed?.memoryAvailableBytes).toBe(10 * GIB);
      expect(observed?.cpuIdleCores).toBe(6);
      expect(subscriptions).toBe(0);
    });

    it("never fires on a cached sample: only a summary that arrives after arming counts", () => {
      setStudio({ summary: summary({ memoryUsedBytes: 2 * GIB }) });
      arm(capacity);
      // The link comes back with the old summary still cached.
      setStudio({ connection: CONNECTED });
      listener?.changed();
      advance(HOST_WATCH_CONNECTION_SETTLE_MS);
      expect(queued).toHaveLength(0);
    });

    it("never fires on a stale sample, nor on an unmeasured figure", () => {
      setStudio({ connection: CONNECTED, summary: summary() });
      arm({ ...capacity, memoryPressureAtMost: "normal" });
      setStudio({ summary: summary({ memoryUsedBytes: 2 * GIB, sampledAt: now - 60_000 }) });
      listener?.summary("studio");
      setStudio({ summary: summary({ memoryUsedBytes: 2 * GIB, memoryPressure: null }) });
      listener?.summary("studio");
      setStudio({ summary: summary({ memoryUsedBytes: 2 * GIB, memoryPressure: "warn" }) });
      listener?.summary("studio");
      expect(queued).toHaveLength(0);
    });

    it("never fires for a sample from a host whose link is down", () => {
      setStudio({ summary: summary() });
      arm(capacity);
      setStudio({ summary: summary({ memoryUsedBytes: 2 * GIB }) });
      listener?.summary("studio");
      expect(queued).toHaveLength(0);
    });
  });

  it("says it expired, with the last thing it saw, then lets go", () => {
    arm({ expiresInSeconds: 60 });
    setStudio({ connection: { status: "unreachable", lastSeenAt: now - 1000, detail: null } });
    advance(60_000);
    expect(queued).toHaveLength(1);
    const notice = queued[0].wake.hostWatch!;
    expect(notice.event).toBe("expired");
    expect(formatHostWatchLine(notice)).toMatch(/expired without seeing its link connected/);
    expect(watches.isActive()).toBe(false);
    expect(watches.run(RUN, { operation: "list" }).watches[0]).toMatchObject({
      status: "expired",
      delivery: "queued",
    });
  });

  it("ends a watch when control is turned off or the host is removed, and says so", () => {
    arm();
    watches.run(RUN, { operation: "arm", hostId: "studio", connection: "disconnected" });
    // Already disconnected: that second one arms nothing.
    control.delete("studio");
    listener?.changed();
    expect(queued.map((q) => q.wake.hostWatch?.lostReason)).toEqual(["control-off"]);
    expect(formatHostWatchLine(queued[0].wake.hostWatch!)).toMatch(/assistant control/);

    control.add("studio");
    arm();
    hosts = [];
    listener?.changed();
    expect(queued[1].wake.hostWatch).toMatchObject({ event: "lost", lostReason: "host-removed" });
    expect(subscriptions).toBe(0);
  });

  it("refuses a host with control off, an unknown host and this machine", () => {
    control.clear();
    expect(arm().outcome).toBe("opted_out");
    expect(arm({ hostId: "nope" }).outcome).toBe("not_found");
    expect(arm({ hostId: "local" }).outcome).toBe("unsupported");
    expect(subscriptions).toBe(0);
  });

  it("arms nothing where it couldn't hear hosts or tell the run", () => {
    watches.dispose();
    watches = make({ observe: false });
    expect(arm().outcome).toBe("unsupported");
    watches = make({ queue: false });
    expect(arm().outcome).toBe("unsupported");
  });

  it("cancels an armed watch silently, and withdraws a notice not yet typed", () => {
    const first = arm().watches[0]!;
    const cancelled = watches.run(RUN, { operation: "cancel", watchId: first.watchId });
    expect(cancelled.watches[0]?.status).toBe("cancelled");
    expect(subscriptions).toBe(0);
    advance(60 * 60_000);
    expect(queued).toHaveLength(0);

    const second = arm().watches[0]!;
    setStudio({ connection: CONNECTED });
    listener?.changed();
    advance(HOST_WATCH_CONNECTION_SETTLE_MS);
    const { wake } = queued[0];
    const withdrawn = watches.run(RUN, { operation: "cancel", watchId: second.watchId });
    expect(withdrawn.watches[0]?.delivery).toBe("withdrawn");
    expect(wake.recheck()).toEqual({ kind: "unavailable", reason: "cancelled" });
    expect(wake.beforeType()).toBe(false);
    wake.report({ kind: "unavailable", reason: "cancelled" });
    expect(watches.run(RUN, { operation: "list" }).watches[0].delivery).toBe("withdrawn");
  });

  it("records what became of the notice and never claims to recall a typed one", () => {
    const watch = arm().watches[0]!;
    setStudio({ connection: CONNECTED });
    listener?.changed();
    advance(HOST_WATCH_CONNECTION_SETTLE_MS);
    const { wake } = queued[0];
    wake.report({ kind: "held", reason: "working" });
    expect(watches.run(RUN, { operation: "list" }).watches[0].delivery).toBe("held");
    wake.report({ kind: "ambiguous", reason: "unconfirmed" });
    const after = watches.run(RUN, { operation: "cancel", watchId: watch.watchId });
    expect(after.detail).toMatch(/already ended/);
    expect(after.watches[0]?.delivery).toBe("ambiguous");
  });

  it("belongs to the run that armed it: a relaunch neither sees, cancels nor hears it", () => {
    const watch = arm().watches[0]!;
    const next: OpenRun = { ...RUN, launchGeneration: 2 };
    running = new Set([runKey(next)]);
    expect(watches.run(next, { operation: "list" }).watches).toEqual([]);
    expect(watches.run(next, { operation: "cancel", watchId: watch.watchId }).outcome).toBe(
      "not_found"
    );
    expect(subscriptions).toBe(0);
    setStudio({ connection: CONNECTED });
    advance(60 * 60_000);
    expect(queued).toHaveLength(0);
  });

  it("drops a fired notice whose run was replaced before it was typed", () => {
    arm();
    setStudio({ connection: CONNECTED });
    listener?.changed();
    advance(HOST_WATCH_CONNECTION_SETTLE_MS);
    running.clear();
    expect(queued[0].wake.recheck()).toEqual({ kind: "unavailable", reason: "relaunched" });
    expect(queued[0].wake.beforeType()).toBe(false);
  });

  it("forgets a session's watches when it ends, and lets go of the listener", () => {
    arm();
    watches.endSession("a");
    expect(subscriptions).toBe(0);
    expect(watches.isActive()).toBe(false);
    expect(watches.run(RUN, { operation: "list" }).watches).toEqual([]);
  });

  it("keeps one watch per condition, and a budget of armed plus unsettled notices", () => {
    const first = arm();
    const again = arm();
    expect(again.watches[0]?.watchId).toBe(first.watches[0]?.watchId);
    expect(again.detail).toMatch(/already armed/);

    for (let i = 1; i < HOST_WATCHES_PER_RUN_MAX; i++) {
      expect(arm({ expiresInSeconds: 60 + i }).watches[0]?.watchId).toBe(first.watches[0]?.watchId);
    }
    // Those all matched the first: one watch. Distinct conditions count.
    for (let i = 1; i < HOST_WATCHES_PER_RUN_MAX; i++) {
      const result = arm({
        connection: undefined,
        memoryAvailableBytesAtLeast: i * GIB,
      });
      expect(result.armed).toBe(true);
    }
    const over = arm({ connection: undefined, cpuIdleCoresAtLeast: 1 });
    expect(over.outcome).toBe("conflict");
    expect(watches.run(RUN, { operation: "list" }).watches).toHaveLength(HOST_WATCHES_PER_RUN_MAX);
  });

  it("forgets everything on dispose and holds nothing after", () => {
    arm();
    setStudio({ connection: CONNECTED });
    listener?.changed();
    advance(HOST_WATCH_CONNECTION_SETTLE_MS);
    const { wake } = queued[0];
    watches.dispose();
    expect(subscriptions).toBe(0);
    expect(wake.beforeType()).toBe(false);
    expect(() => wake.report({ kind: "delivered" })).not.toThrow();
  });
});
