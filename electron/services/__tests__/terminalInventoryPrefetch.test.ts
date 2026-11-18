import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../AgentAvailabilityStore.js", () => ({
  getAgentAvailabilityStore: () => ({ isHelpTerminal: (id: string) => id === "help-1" }),
}));
vi.mock("../../utils/logger.js", () => ({ logInfo: vi.fn() }));

import {
  _pendingTerminalInventoryPrefetchesForTests,
  _resetTerminalInventoryPrefetchForTests,
  buildTerminalInventory,
  consumeTerminalInventoryPrefetch,
  invalidateTerminalInventoryPrefetch,
  prefetchTerminalInventory,
} from "../terminalInventoryPrefetch.js";

function terminal(id: string, kind = "terminal", extra: Record<string, unknown> = {}) {
  return { id, projectId: "p1", kind, title: id, hasPty: true, ...extra } as never;
}

describe("buildTerminalInventory", () => {
  it("lists the project's terminals in host order and drops dev-preview and help PTYs", async () => {
    const ptyClient = {
      getProjectTerminalsAsync: vi.fn(async () => [
        terminal("t2"),
        terminal("dp", "dev-preview"),
        terminal("help-1"),
        terminal("t1"),
      ]),
    };
    const inventory = await buildTerminalInventory(ptyClient, "p1");
    expect(inventory.map((t) => t.id)).toEqual(["t2", "t1"]);
    expect(ptyClient.getProjectTerminalsAsync).toHaveBeenCalledTimes(1);
    expect(ptyClient.getProjectTerminalsAsync).toHaveBeenCalledWith("p1");
  });

  it("drops an assistant PTY the renderer has not marked yet", async () => {
    // #12183: the availability-store mark arrives on a fire-and-forget renderer
    // round trip that lands AFTER the spawn IPC returned, so between "PTY
    // exists" and "help.markTerminal processed" this inventory used to report
    // the assistant — and `restorePanelsPhase` appends anything here with no
    // saved panel as a grid orphan. The spawn-time record stamp closes that
    // window, since it is on the record before the PTY is reachable at all.
    const ptyClient = {
      getProjectTerminalsAsync: vi.fn(async () => [
        terminal("t1"),
        terminal("assistant", "terminal", { isAssistantTerminal: true }),
      ]),
    };
    const inventory = await buildTerminalInventory(ptyClient, "p1");
    expect(inventory.map((t) => t.id)).toEqual(["t1"]);
  });

  it("keeps each pane's live grid, and an exited terminal without one", async () => {
    const ptyClient = {
      getProjectTerminalsAsync: vi.fn(async () => [
        terminal("live", "terminal", { ptyCols: 203, ptyRows: 51 }),
        terminal("exited", "terminal", { hasPty: false }),
      ]),
    };
    const [live, exited] = await buildTerminalInventory(ptyClient, "p1");
    expect(live).toMatchObject({ id: "live", ptyCols: 203, ptyRows: 51, hasPty: true });
    expect(exited).toMatchObject({ id: "exited", hasPty: false });
    expect(exited?.ptyCols).toBeUndefined();
    expect(exited?.ptyRows).toBeUndefined();
  });
});

describe("prefetchTerminalInventory", () => {
  beforeEach(() => {
    _resetTerminalInventoryPrefetchForTests();
    vi.useFakeTimers();
  });
  afterEach(() => {
    // Clears the sweep's fake timer while fake timers are still installed.
    _resetTerminalInventoryPrefetchForTests();
    vi.useRealTimers();
  });

  it("shares one in-flight fetch and hands it out exactly once", async () => {
    const build = vi.fn(async () => [terminal("t1")]);
    const first = prefetchTerminalInventory("p1", build);
    const second = prefetchTerminalInventory("p1", build);
    expect(second).toBe(first);
    expect(build).toHaveBeenCalledTimes(1);

    expect(consumeTerminalInventoryPrefetch("p1")).toBe(first);
    expect(consumeTerminalInventoryPrefetch("p1")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await expect(first).resolves.toHaveLength(1);
  });

  it("does not serve an inventory older than its TTL", () => {
    // Registered before the prefetch, so at t=5s it runs ahead of the sweep and
    // the consume itself has to refuse the expired entry.
    let consumed: unknown = "not run";
    setTimeout(() => {
      consumed = consumeTerminalInventoryPrefetch("p1");
    }, 5_000);
    prefetchTerminalInventory("p1", async () => []);
    vi.advanceTimersByTime(5_000);
    expect(consumed).toBeNull();
  });

  it("does not serve an inventory taken before a system sleep", () => {
    // The monotonic clock stands still across a sleep; the wall clock does not.
    prefetchTerminalInventory("p1", async () => []);
    vi.setSystemTime(Date.now() + 60 * 60 * 1_000);
    expect(consumeTerminalInventoryPrefetch("p1")).toBeNull();
  });

  it("drops a rejected prefetch so the handler fetches live", async () => {
    const failed = prefetchTerminalInventory("p1", async () => {
      throw new Error("pty-host down");
    });
    await expect(failed).rejects.toThrow("pty-host down");
    await Promise.resolve();
    expect(consumeTerminalInventoryPrefetch("p1")).toBeNull();
  });

  it("invalidates per project and globally", () => {
    prefetchTerminalInventory("p1", async () => []);
    prefetchTerminalInventory("p2", async () => []);
    invalidateTerminalInventoryPrefetch("p1");
    expect(consumeTerminalInventoryPrefetch("p1")).toBeNull();
    expect(consumeTerminalInventoryPrefetch("p2")).not.toBeNull();
    prefetchTerminalInventory("p3", async () => []);
    invalidateTerminalInventoryPrefetch();
    expect(consumeTerminalInventoryPrefetch("p3")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("evicts abandoned prefetches once their TTL passes, with no consumer asking", async () => {
    // #17793: a switch whose swap fails, or whose view never hydrates, never
    // consumes its prefetch; the settled inventory must not stay reachable.
    prefetchTerminalInventory("p1", async () => [terminal("t1")]);
    vi.advanceTimersByTime(1_000);
    prefetchTerminalInventory("p2", async () => [terminal("t2")]);
    vi.advanceTimersByTime(1_000);
    prefetchTerminalInventory("p3", async () => [terminal("t3")]);
    await Promise.resolve();
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1);

    vi.advanceTimersByTime(3_000);
    expect(_pendingTerminalInventoryPrefetchesForTests()).toEqual(["p2", "p3"]);
    vi.advanceTimersByTime(1_000);
    expect(_pendingTerminalInventoryPrefetchesForTests()).toEqual(["p3"]);
    vi.advanceTimersByTime(1_000);
    expect(_pendingTerminalInventoryPrefetchesForTests()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never lets an older entry's expiry evict its replacement", () => {
    // p2 keeps the first sweep armed, so it fires while p1's replacement is live.
    prefetchTerminalInventory("p1", async () => []);
    prefetchTerminalInventory("p2", async () => []);
    vi.advanceTimersByTime(4_000);
    expect(consumeTerminalInventoryPrefetch("p1")).not.toBeNull();
    const replacement = prefetchTerminalInventory("p1", async () => [terminal("t2")]);

    vi.advanceTimersByTime(1_500);
    expect(_pendingTerminalInventoryPrefetchesForTests()).toEqual(["p1"]);
    expect(consumeTerminalInventoryPrefetch("p1")).toBe(replacement);
  });

  it("keeps an entry that replaced an expired one at its sweep's deadline", async () => {
    let rejectOriginal!: (error: Error) => void;
    const original = new Promise<never>((_, reject) => {
      rejectOriginal = reject;
    });
    original.catch(() => {});
    let replacement: Promise<unknown> | null = null;
    let pendingAtDeadline: string[] = [];
    // Registered before the prefetch, so at t=5s it runs ahead of the sweep and
    // finds the original expired but not yet evicted.
    setTimeout(() => {
      pendingAtDeadline = _pendingTerminalInventoryPrefetchesForTests();
      replacement = prefetchTerminalInventory("p1", async () => [terminal("t2")]);
    }, 5_000);
    const build = vi.fn(() => original);
    prefetchTerminalInventory("p1", build);

    vi.advanceTimersByTime(5_000);
    expect(pendingAtDeadline).toEqual(["p1"]);
    expect(replacement).not.toBeNull();
    expect(replacement).not.toBe(original);
    expect(_pendingTerminalInventoryPrefetchesForTests()).toEqual(["p1"]);

    // The original's late rejection must not drop the entry that replaced it.
    rejectOriginal(new Error("pty-host down"));
    await Promise.resolve();
    await Promise.resolve();
    expect(_pendingTerminalInventoryPrefetchesForTests()).toEqual(["p1"]);

    vi.advanceTimersByTime(5_000);
    expect(_pendingTerminalInventoryPrefetchesForTests()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("evicts on time when the wall clock jumps backward", () => {
    prefetchTerminalInventory("p1", async () => []);
    vi.setSystemTime(Date.now() - 60 * 60 * 1_000);
    vi.advanceTimersByTime(5_000);
    expect(_pendingTerminalInventoryPrefetchesForTests()).toEqual([]);
    expect(consumeTerminalInventoryPrefetch("p1")).toBeNull();
  });
});
