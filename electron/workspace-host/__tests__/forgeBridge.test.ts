import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForgeBridge } from "../forgeBridge.js";
import type { WorkspaceHostEvent } from "../../../shared/types/workspace-host.js";
import type { RepoRef } from "../../../shared/types/forge.js";

const repo: RepoRef = { host: "github.com", owner: "owner", repo: "repo", rawData: null };

type ForgeRpcEvent = Extract<WorkspaceHostEvent, { type: "forge:rpc" }>;
type LeaseAcquireEvent = Extract<WorkspaceHostEvent, { type: "forge:poll-lease-acquire" }>;
type LeaseReleaseEvent = Extract<WorkspaceHostEvent, { type: "forge:poll-lease-release" }>;

function isForgeRpc(event: WorkspaceHostEvent): event is ForgeRpcEvent {
  return event.type === "forge:rpc";
}

function isLeaseAcquire(event: WorkspaceHostEvent): event is LeaseAcquireEvent {
  return event.type === "forge:poll-lease-acquire";
}

function isLeaseRelease(event: WorkspaceHostEvent): event is LeaseReleaseEvent {
  return event.type === "forge:poll-lease-release";
}

describe("ForgeBridge in-flight dedup", () => {
  let events: ForgeRpcEvent[];
  let bridge: ForgeBridge;

  beforeEach(() => {
    events = [];
    bridge = new ForgeBridge((event) => {
      if (isForgeRpc(event)) events.push(event);
    });
  });

  afterEach(() => {
    // Reject any still-pending calls so their 30s RPC timers are cleared and
    // don't leak across tests.
    bridge.dispose();
  });

  it("coalesces concurrent identical calls into one forge:rpc event", async () => {
    const a = bridge.getPR("ns", repo, 1);
    const b = bridge.getPR("ns", repo, 1);

    expect(events).toHaveLength(1);

    bridge.handleResult({
      forgeRequestId: events[0].forgeRequestId,
      ok: true,
      value: { number: 1 },
    });

    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual({ number: 1 });
    expect(rb).toEqual({ number: 1 });
  });

  it("sends separate events when args differ", () => {
    // Never settled — afterEach dispose() rejects them, so swallow.
    void bridge.getPR("ns", repo, 1).catch(() => {});
    void bridge.getPR("ns", repo, 2).catch(() => {});

    expect(events).toHaveLength(2);
  });

  it("sends separate events when namespacedId differs", () => {
    void bridge.getPR("ns-a", repo, 1).catch(() => {});
    void bridge.getPR("ns-b", repo, 1).catch(() => {});

    expect(events).toHaveLength(2);
  });

  it("evicts on rejection so a retry sends a fresh event", async () => {
    const first = bridge.getPR("ns", repo, 1);
    expect(events).toHaveLength(1);

    bridge.handleResult({ forgeRequestId: events[0].forgeRequestId, ok: false, error: "boom" });
    await expect(first).rejects.toThrow("boom");

    const retry = bridge.getPR("ns", repo, 1);
    expect(events).toHaveLength(2);

    bridge.handleResult({
      forgeRequestId: events[1].forgeRequestId,
      ok: true,
      value: { number: 1 },
    });
    await expect(retry).resolves.toEqual({ number: 1 });
  });

  it("evicts on success so a later identical call refetches", async () => {
    const first = bridge.getPR("ns", repo, 1);
    bridge.handleResult({
      forgeRequestId: events[0].forgeRequestId,
      ok: true,
      value: { number: 1 },
    });
    await first;

    void bridge.getPR("ns", repo, 1).catch(() => {});
    expect(events).toHaveLength(2);
  });

  it("dispose rejects deduped concurrent callers", async () => {
    const a = bridge.getPR("ns", repo, 1);
    const b = bridge.getPR("ns", repo, 1);
    expect(events).toHaveLength(1);

    bridge.dispose();

    await expect(a).rejects.toThrow(/disposed/);
    await expect(b).rejects.toThrow(/disposed/);
  });
});

describe("ForgeBridge poll-lease IPC (#9055)", () => {
  let events: WorkspaceHostEvent[];
  let bridge: ForgeBridge;

  beforeEach(() => {
    events = [];
    bridge = new ForgeBridge((event) => {
      events.push(event);
    });
  });

  afterEach(() => {
    bridge.dispose();
  });

  it("sends forge:poll-lease-acquire and resolves to acquired=true on a granted result", async () => {
    const p = bridge.acquirePollLease();

    const acquire = events.find(isLeaseAcquire);
    expect(acquire).toBeDefined();
    expect(acquire?.requestId).toMatch(/^lease-/);

    bridge.handleLeaseResult({ requestId: acquire!.requestId, acquired: true });
    await expect(p).resolves.toBe(true);
  });

  it("resolves to acquired=false on a denied result", async () => {
    const p = bridge.acquirePollLease();
    const acquire = events.find(isLeaseAcquire)!;
    bridge.handleLeaseResult({ requestId: acquire.requestId, acquired: false });
    await expect(p).resolves.toBe(false);
  });

  it("fails open (resolves true) when the result never arrives within the timeout", async () => {
    vi.useFakeTimers();
    try {
      const p = bridge.acquirePollLease();
      // Drive past the 5s fail-open ceiling without delivering a result.
      vi.advanceTimersByTime(5_001);
      await expect(p).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("silently drops a late result that arrives after the timeout already fired", async () => {
    vi.useFakeTimers();
    try {
      const p = bridge.acquirePollLease();
      const acquire = events.find(isLeaseAcquire)!;
      vi.advanceTimersByTime(5_001);
      await expect(p).resolves.toBe(true);
      // Now-stale result must not throw or resolve a second time.
      expect(() => bridge.handleLeaseResult({ requestId: acquire.requestId, acquired: false }))
        .not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispose resolves pending acquires to true (fail-open during shutdown)", async () => {
    const p = bridge.acquirePollLease();
    bridge.dispose();
    await expect(p).resolves.toBe(true);
  });

  it("releasePollLease emits a fire-and-forget event with no pending response", () => {
    bridge.releasePollLease();
    expect(events.filter(isLeaseRelease)).toHaveLength(1);
  });

  it("each acquire produces a unique requestId so concurrent calls don't collide", () => {
    void bridge.acquirePollLease();
    void bridge.acquirePollLease();
    const acquires = events.filter(isLeaseAcquire);
    expect(acquires).toHaveLength(2);
    expect(acquires[0].requestId).not.toBe(acquires[1].requestId);
  });
});
