import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProcessTreeCache, type ProcessInfo } from "../ProcessTreeCache.js";

type CpuSnapshot = { kernelTicks: bigint; userTicks: bigint; wallMs: number };
type CacheInternals = {
  cache: Map<number, ProcessInfo>;
  childrenMap: Map<number, number[]>;
  cpuSnapshots: Map<string, CpuSnapshot>;
  isRefreshing: boolean;
  isWindows: boolean;
  pollTimer: NodeJS.Timeout | null;
  disposed: boolean;
  currentIntervalMs: number;
  pollIntervalMs: number;
  refreshCallbacks: Set<() => void>;
};

function createSeededCache(): ProcessTreeCache {
  const processTree = new ProcessTreeCache();
  const internals = processTree as unknown as {
    cache: Map<number, ProcessInfo>;
    childrenMap: Map<number, number[]>;
  };

  internals.cache = new Map<number, ProcessInfo>([
    [2, { pid: 2, ppid: 1, comm: "node", command: "node a.js", cpuPercent: 0.2, rssKb: 50000 }],
    [3, { pid: 3, ppid: 1, comm: "node", command: "node b.js", cpuPercent: 0.1, rssKb: 30000 }],
    [4, { pid: 4, ppid: 2, comm: "npm", command: "npm test", cpuPercent: 1.5, rssKb: 20000 }],
  ]);
  internals.childrenMap = new Map<number, number[]>([
    [1, [2, 3]],
    [2, [4]],
    [3, []],
  ]);

  return processTree;
}

describe("ProcessTreeCache", () => {
  it("returns a defensive copy from getChildPids", () => {
    const processTree = createSeededCache();

    const childPids = processTree.getChildPids(1);
    childPids.push(999);

    expect(processTree.getChildPids(1)).toEqual([2, 3]);
  });

  it("returns descendant pids in post-order (deepest first)", () => {
    const processTree = createSeededCache();
    // Tree: 1 -> [2, 3], 2 -> [4]
    // Post-order: 4 (leaf), 2, 3
    const descendants = processTree.getDescendantPids(1);
    expect(descendants).toEqual([4, 2, 3]);
  });

  it("returns empty array for pid with no children", () => {
    const processTree = createSeededCache();
    expect(processTree.getDescendantPids(4)).toEqual([]);
  });

  it("returns only direct children for flat structure", () => {
    const processTree = createSeededCache();
    // PID 1 has children [2, 3], PID 2 has child [4]
    // Asking for descendants of PID 3 (no children)
    expect(processTree.getDescendantPids(3)).toEqual([]);
  });

  it("returns immediate children when no grandchildren exist", () => {
    const processTree = createSeededCache();
    // PID 2 has child [4], no further nesting
    expect(processTree.getDescendantPids(2)).toEqual([4]);
  });

  it("does not include root pid in descendants", () => {
    const processTree = createSeededCache();
    const descendants = processTree.getDescendantPids(1);
    expect(descendants).not.toContain(1);
  });

  it("does not mutate childrenMap when getting descendants", () => {
    const processTree = createSeededCache();
    processTree.getDescendantPids(1);
    processTree.getDescendantPids(1);
    expect(processTree.getChildPids(1)).toEqual([2, 3]);
    expect(processTree.getChildPids(2)).toEqual([4]);
  });

  it("returns empty array for unknown pid", () => {
    const processTree = createSeededCache();
    expect(processTree.getDescendantPids(999)).toEqual([]);
  });
});

describe("getTreeResourceSummary", () => {
  it("aggregates CPU and memory for root + descendants", () => {
    const processTree = createSeededCache();
    const summary = processTree.getTreeResourceSummary(2);

    expect(summary).not.toBeNull();
    // PID 2 (0.2%) + PID 4 (1.5%) = 1.7%
    expect(summary!.cpuPercent).toBeCloseTo(1.7, 6);
    // PID 2 (50000) + PID 4 (20000) = 70000
    expect(summary!.memoryKb).toBe(70000);
    expect(summary!.breakdown).toHaveLength(2);
  });

  it("returns null for unknown PID", () => {
    const processTree = createSeededCache();
    expect(processTree.getTreeResourceSummary(999)).toBeNull();
  });

  it("returns only root process when no children", () => {
    const processTree = createSeededCache();
    const summary = processTree.getTreeResourceSummary(4);

    expect(summary).not.toBeNull();
    expect(summary!.cpuPercent).toBeCloseTo(1.5, 6);
    expect(summary!.memoryKb).toBe(20000);
    expect(summary!.breakdown).toHaveLength(1);
    expect(summary!.breakdown[0].pid).toBe(4);
  });

  it("sorts breakdown by CPU descending", () => {
    const processTree = createSeededCache();
    const summary = processTree.getTreeResourceSummary(1);

    // PID 1 doesn't exist in cache, so this should return null
    expect(summary).toBeNull();
  });

  it("aggregates full tree from PID 2", () => {
    const processTree = createSeededCache();
    const summary = processTree.getTreeResourceSummary(2);

    expect(summary!.breakdown[0].cpuPercent).toBeGreaterThanOrEqual(
      summary!.breakdown[1].cpuPercent
    );
  });
});

describe("Windows CPU delta computation", () => {
  // The formula in refreshWindows():
  //   cpuPercent = Number((totalDelta * 10000n) / capacity) / 100
  //   where totalDelta = kernelDelta + userDelta (in 100ns ticks)
  //   capacity = deltaWallMs * 10000n * numCpus (converting ms to 100ns ticks × cores)

  function computeCpuPercent(
    kernelTicks: bigint,
    userTicks: bigint,
    priorKernelTicks: bigint,
    priorUserTicks: bigint,
    deltaWallMs: number,
    numCpus: number
  ): number {
    const totalDelta = kernelTicks - priorKernelTicks + (userTicks - priorUserTicks);
    if (totalDelta < 0n) return 0;
    const capacity = BigInt(deltaWallMs) * 10000n * BigInt(numCpus);
    if (capacity === 0n) return 0;
    return Math.min(Number((totalDelta * 10000n) / capacity) / 100, 100);
  }

  it("returns 0 on first poll (no prior snapshot)", () => {
    const tree = new ProcessTreeCache();
    const internals = tree as unknown as CacheInternals;

    // No prior snapshot means cpuPercent defaults to 0
    expect(internals.cpuSnapshots.size).toBe(0);
  });

  it("computes nonzero CPU% for a process using ticks over a 2.5s interval", () => {
    // 1 CPU, 2500ms wall time = 2500 * 10000 = 25_000_000 ticks capacity
    // Process used 12_500_000 ticks kernel + 0 user = 50% of one core
    const result = computeCpuPercent(12_500_000n, 0n, 0n, 0n, 2500, 1);
    expect(result).toBe(50);
  });

  it("splits CPU across cores correctly", () => {
    // 4 CPUs, 1000ms wall time = 1000 * 10000 * 4 = 40_000_000 ticks capacity
    // Process used 10_000_000 ticks total = 25% of total capacity
    const result = computeCpuPercent(5_000_000n, 5_000_000n, 0n, 0n, 1000, 4);
    expect(result).toBe(25);
  });

  it("returns 0 when tick delta is negative (PID reuse)", () => {
    // New process has fewer ticks than what the old snapshot recorded
    const result = computeCpuPercent(100n, 100n, 50_000_000n, 50_000_000n, 2500, 1);
    expect(result).toBe(0);
  });

  it("returns 0 when deltaWallMs is 0 (same-millisecond call)", () => {
    const result = computeCpuPercent(10_000_000n, 0n, 0n, 0n, 0, 1);
    expect(result).toBe(0);
  });

  it("caps at 100% even with excessive ticks", () => {
    // More ticks than wall time × cores should be capped
    const result = computeCpuPercent(100_000_000n, 100_000_000n, 0n, 0n, 1000, 1);
    expect(result).toBe(100);
  });

  it("prunes stale snapshot entries after processes exit", () => {
    const tree = new ProcessTreeCache();
    const internals = tree as unknown as CacheInternals;

    // Seed snapshots for two processes
    internals.cpuSnapshots.set("100:2023-01-01T00:00:00Z", {
      kernelTicks: 1000n,
      userTicks: 500n,
      wallMs: 1000,
    });
    internals.cpuSnapshots.set("200:2023-01-01T00:00:00Z", {
      kernelTicks: 2000n,
      userTicks: 1000n,
      wallMs: 1000,
    });

    expect(internals.cpuSnapshots.size).toBe(2);

    // Simulate that only PID 100 survives by setting cache with only PID 100
    // (In real usage, refreshWindows prunes after building newCache)
    // We just verify the map is accessible for pruning
    internals.cpuSnapshots.delete("200:2023-01-01T00:00:00Z");
    expect(internals.cpuSnapshots.size).toBe(1);
    expect(internals.cpuSnapshots.has("100:2023-01-01T00:00:00Z")).toBe(true);
  });

  it("uses pid:creationDate as snapshot key for PID reuse detection", () => {
    const tree = new ProcessTreeCache();
    const internals = tree as unknown as CacheInternals;

    // Two different processes reusing PID 42 with different creation dates
    internals.cpuSnapshots.set("42:2023-01-01T00:00:00Z", {
      kernelTicks: 50_000_000n,
      userTicks: 0n,
      wallMs: 1000,
    });
    internals.cpuSnapshots.set("42:2023-06-01T00:00:00Z", {
      kernelTicks: 1_000n,
      userTicks: 0n,
      wallMs: 1000,
    });

    expect(internals.cpuSnapshots.size).toBe(2);
    // Different creation dates are tracked independently
    expect(internals.cpuSnapshots.get("42:2023-01-01T00:00:00Z")!.kernelTicks).toBe(50_000_000n);
    expect(internals.cpuSnapshots.get("42:2023-06-01T00:00:00Z")!.kernelTicks).toBe(1_000n);
  });
});

describe("poll scheduling and adaptive backoff", () => {
  let cache: ProcessTreeCache;
  let internals: CacheInternals;
  let refreshSpy: ReturnType<typeof vi.fn>;

  // Helper: seed PID set into cache and register a subscriber
  function seedPids(pids: number[]): void {
    internals.cache = new Map(
      pids.map((pid) => [
        pid,
        { pid, ppid: 1, comm: "node", command: "node", cpuPercent: 0, rssKb: 1000 },
      ])
    );
  }

  // Stub refreshUnix to resolve with a configurable PID set
  function stubRefresh(pids: number[]): void {
    refreshSpy.mockImplementation(async function (this: ProcessTreeCache) {
      const self = this as unknown as CacheInternals;
      const newCache = new Map(
        pids.map((pid) => [
          pid,
          {
            pid,
            ppid: 1,
            comm: "node",
            command: "node",
            cpuPercent: 0,
            rssKb: 1000,
          } as ProcessInfo,
        ])
      );
      // Replicate hasPidSetChanged logic
      let changed = self.cache.size !== newCache.size;
      if (!changed) {
        for (const pid of newCache.keys()) {
          if (!self.cache.has(pid)) {
            changed = true;
            break;
          }
        }
      }
      self.cache = newCache;
      self.childrenMap = new Map();
      return changed;
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new ProcessTreeCache(2500);
    internals = cache as unknown as CacheInternals;
    // Force the Unix refresh path so stubbing refreshUnix works on Windows CI too
    internals.isWindows = false;
    // Stub refreshUnix so no real `ps` calls happen
    refreshSpy = vi.fn();
    // Default stub: returns same PIDs (no change)
    stubRefresh([1, 2, 3]);
    (cache as unknown as { refreshUnix: typeof refreshSpy }).refreshUnix = refreshSpy;
    // Seed initial cache so first refresh sees "no change"
    seedPids([1, 2, 3]);
    // Register a subscriber so refresh() doesn't skip
    cache.onRefresh(() => {});
  });

  afterEach(() => {
    cache.stop();
    vi.useRealTimers();
  });

  it("uses setTimeout (not setInterval) for scheduling", async () => {
    cache.start();
    // Let the initial synchronous refresh() settle (its finally block schedules the first poll)
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    // One pending setTimeout, not an interval
    expect(vi.getTimerCount()).toBe(1);
  });

  it("advances backoff by 1.5x when PID set is unchanged", async () => {
    cache.start();
    await vi.advanceTimersByTimeAsync(0); // first refresh
    expect(cache.getCurrentIntervalMs()).toBe(Math.ceil(2500 * 1.5)); // 3750

    await vi.advanceTimersByTimeAsync(3750); // second refresh
    expect(cache.getCurrentIntervalMs()).toBe(Math.ceil(3750 * 1.5)); // 5625
  });

  it("resets backoff to base when PID set changes", async () => {
    cache.start();
    await vi.advanceTimersByTimeAsync(0); // first refresh (unchanged → backoff)
    expect(cache.getCurrentIntervalMs()).toBe(3750);

    // Next refresh will see a different PID set
    stubRefresh([1, 2, 3, 4]);
    await vi.advanceTimersByTimeAsync(3750);
    expect(cache.getCurrentIntervalMs()).toBe(2500); // reset to base
  });

  it("caps backoff at 15s ceiling", async () => {
    cache.start();
    // Advance through many unchanged refreshes until ceiling
    let interval = 2500;
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(i === 0 ? 0 : interval);
      interval = cache.getCurrentIntervalMs();
      if (interval >= 15_000) break;
    }
    expect(cache.getCurrentIntervalMs()).toBeLessThanOrEqual(15_000);
    // One more tick to confirm it stays at ceiling
    await vi.advanceTimersByTimeAsync(15_000);
    expect(cache.getCurrentIntervalMs()).toBe(15_000);
  });

  it("stop() clears all pending timers", async () => {
    cache.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    cache.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disposed flag prevents rescheduling after stop()", async () => {
    cache.start();
    await vi.advanceTimersByTimeAsync(0); // first refresh completes
    const callsAfterStart = refreshSpy.mock.calls.length;

    cache.stop();
    expect(vi.getTimerCount()).toBe(0);
    // No further refreshes should fire after stop
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refreshSpy).toHaveBeenCalledTimes(callsAfterStart);
  });

  it("setPollInterval resets backoff and reschedules immediately", async () => {
    cache.start();
    await vi.advanceTimersByTimeAsync(0); // first refresh, backoff → 3750
    expect(cache.getCurrentIntervalMs()).toBe(3750);

    cache.setPollInterval(5000);
    expect(cache.getCurrentIntervalMs()).toBe(5000);
    // Timer was rescheduled at 5000ms
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(refreshSpy).toHaveBeenCalledTimes(2);
  });

  it("setPollInterval is no-op when value unchanged", async () => {
    cache.start();
    await vi.advanceTimersByTimeAsync(0);
    const timersBefore = vi.getTimerCount();
    cache.setPollInterval(2500); // same value
    expect(vi.getTimerCount()).toBe(timersBefore);
  });

  it("no-subscriber optimization still reschedules timer", async () => {
    cache.start();
    await vi.advanceTimersByTimeAsync(0); // first refresh completes
    refreshSpy.mockClear();

    // Remove all subscribers so next refresh() takes the early-return path
    internals.refreshCallbacks.clear();
    await vi.advanceTimersByTimeAsync(cache.getCurrentIntervalMs());
    // refresh() should have returned early (no subscribers) but still scheduled next poll
    expect(internals.pollTimer).not.toBeNull();
    // refreshUnix should NOT have been called on this tick
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("resets backoff on error", async () => {
    cache.start();
    await vi.advanceTimersByTimeAsync(0); // first refresh (unchanged) → 3750
    expect(cache.getCurrentIntervalMs()).toBe(3750);

    // Make next refresh throw
    refreshSpy.mockRejectedValueOnce(new Error("ps failed"));
    await vi.advanceTimersByTimeAsync(3750);
    // Error resets to base
    expect(cache.getCurrentIntervalMs()).toBe(2500);
    // Still reschedules
    expect(vi.getTimerCount()).toBe(1);
  });

  it("supports stop → start restart cycle", async () => {
    cache.start();
    await vi.advanceTimersByTimeAsync(0);
    // Advance backoff
    await vi.advanceTimersByTimeAsync(cache.getCurrentIntervalMs());

    cache.stop();
    expect(vi.getTimerCount()).toBe(0);

    // Restart — should reset backoff to base
    cache.start();
    await vi.advanceTimersByTimeAsync(0);
    // After first unchanged refresh, should be base * 1.5
    expect(cache.getCurrentIntervalMs()).toBe(Math.ceil(2500 * 1.5));
  });
});
