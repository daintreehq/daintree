import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSharedTerminalSnapshot,
  invalidateSharedTerminalSnapshot,
} from "../sharedTerminalSnapshot.js";

type Snapshot = {
  terminals: unknown[];
  degraded: boolean;
  shardsTotal: number;
  shardsFailed: number;
};

function snapshot(terminals: unknown[] = [], degraded = false): Snapshot {
  return { terminals, degraded, shardsTotal: 1, shardsFailed: degraded ? 1 : 0 };
}

function makeClient() {
  return { getAllTerminalsWithCompletenessAsync: vi.fn(async () => snapshot()) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_830_000_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getSharedTerminalSnapshot", () => {
  it("serves concurrent callers from one request", async () => {
    const client = makeClient();
    const [a, b] = await Promise.all([
      getSharedTerminalSnapshot(client as never),
      getSharedTerminalSnapshot(client as never),
    ]);
    expect(client.getAllTerminalsWithCompletenessAsync).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it("reuses a settled read within the TTL and re-reads after it", async () => {
    const client = makeClient();
    await getSharedTerminalSnapshot(client as never);
    vi.advanceTimersByTime(1_000);
    await getSharedTerminalSnapshot(client as never);
    expect(client.getAllTerminalsWithCompletenessAsync).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    await getSharedTerminalSnapshot(client as never);
    expect(client.getAllTerminalsWithCompletenessAsync).toHaveBeenCalledTimes(2);
  });

  it("re-reads after invalidation, even inside the TTL", async () => {
    const client = makeClient();
    await getSharedTerminalSnapshot(client as never);
    invalidateSharedTerminalSnapshot(client as never);
    await getSharedTerminalSnapshot(client as never);
    expect(client.getAllTerminalsWithCompletenessAsync).toHaveBeenCalledTimes(2);
  });

  it("never hands a post-invalidation caller a read that left before it", async () => {
    let releaseFirst!: (value: Snapshot) => void;
    const client = {
      getAllTerminalsWithCompletenessAsync: vi
        .fn()
        .mockImplementationOnce(() => new Promise<Snapshot>((r) => (releaseFirst = r)))
        .mockResolvedValue(snapshot([{ id: "fresh" }])),
    };

    const early = getSharedTerminalSnapshot(client as never);
    invalidateSharedTerminalSnapshot(client as never);
    const late = getSharedTerminalSnapshot(client as never);
    expect(client.getAllTerminalsWithCompletenessAsync).toHaveBeenCalledTimes(2);

    releaseFirst(snapshot([{ id: "stale" }]));
    expect((await early).terminals).toEqual([{ id: "stale" }]);
    expect((await late).terminals).toEqual([{ id: "fresh" }]);

    // The detached read must not have been cached over the fresh one.
    expect((await getSharedTerminalSnapshot(client as never)).terminals).toEqual([{ id: "fresh" }]);
    expect(client.getAllTerminalsWithCompletenessAsync).toHaveBeenCalledTimes(2);
  });

  it("does not cache a degraded read", async () => {
    const client = makeClient();
    client.getAllTerminalsWithCompletenessAsync.mockResolvedValueOnce(snapshot([], true));
    expect((await getSharedTerminalSnapshot(client as never)).degraded).toBe(true);
    expect((await getSharedTerminalSnapshot(client as never)).degraded).toBe(false);
    expect(client.getAllTerminalsWithCompletenessAsync).toHaveBeenCalledTimes(2);
  });

  it("keeps each client's cache separate", async () => {
    const a = makeClient();
    const b = makeClient();
    await getSharedTerminalSnapshot(a as never);
    await getSharedTerminalSnapshot(b as never);
    expect(a.getAllTerminalsWithCompletenessAsync).toHaveBeenCalledTimes(1);
    expect(b.getAllTerminalsWithCompletenessAsync).toHaveBeenCalledTimes(1);
  });

  it("starts its own read rather than joining one sent longer ago than the TTL", async () => {
    // A slow shard holds the fan-out open; a poll arriving seconds later must
    // not inherit the sample that left before it.
    let releaseSlow!: (value: Snapshot) => void;
    const client = {
      getAllTerminalsWithCompletenessAsync: vi
        .fn()
        .mockImplementationOnce(() => new Promise<Snapshot>((r) => (releaseSlow = r)))
        .mockResolvedValue(snapshot([{ id: "fresh" }])),
    };

    const slow = getSharedTerminalSnapshot(client as never);
    vi.advanceTimersByTime(4_000);
    const late = getSharedTerminalSnapshot(client as never);
    expect(client.getAllTerminalsWithCompletenessAsync).toHaveBeenCalledTimes(2);
    expect((await late).terminals).toEqual([{ id: "fresh" }]);

    // The slow read lands last but was sampled first: it must not be cached.
    releaseSlow(snapshot([{ id: "stale" }]));
    await slow;
    expect((await getSharedTerminalSnapshot(client as never)).terminals).toEqual([{ id: "fresh" }]);
    expect(client.getAllTerminalsWithCompletenessAsync).toHaveBeenCalledTimes(2);
  });

  it("ages a slow read from when it was sent, not when it arrived", async () => {
    let release!: (value: Snapshot) => void;
    const client = makeClient();
    client.getAllTerminalsWithCompletenessAsync.mockImplementationOnce(
      () => new Promise<Snapshot>((r) => (release = r))
    );
    const first = getSharedTerminalSnapshot(client as never);
    vi.advanceTimersByTime(900);
    release(snapshot());
    await first;

    vi.advanceTimersByTime(200);
    await getSharedTerminalSnapshot(client as never);
    expect(client.getAllTerminalsWithCompletenessAsync).toHaveBeenCalledTimes(2);
  });

  it("treats a clock that moved backwards as stale", async () => {
    const client = makeClient();
    await getSharedTerminalSnapshot(client as never);
    vi.setSystemTime(Date.now() - 60_000);
    await getSharedTerminalSnapshot(client as never);
    expect(client.getAllTerminalsWithCompletenessAsync).toHaveBeenCalledTimes(2);
  });

  it("retries after a rejected read instead of replaying the rejection", async () => {
    const client = makeClient();
    client.getAllTerminalsWithCompletenessAsync.mockRejectedValueOnce(new Error("host gone"));
    await expect(getSharedTerminalSnapshot(client as never)).rejects.toThrow("host gone");
    await expect(getSharedTerminalSnapshot(client as never)).resolves.toMatchObject({
      degraded: false,
    });
    expect(client.getAllTerminalsWithCompletenessAsync).toHaveBeenCalledTimes(2);
  });
});
