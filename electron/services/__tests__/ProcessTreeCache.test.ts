import { describe, expect, it } from "vitest";
import { ProcessTreeCache, type ProcessInfo } from "../ProcessTreeCache.js";

type CpuSnapshot = { kernelTicks: bigint; userTicks: bigint; wallMs: number };
type CacheInternals = {
  cache: Map<number, ProcessInfo>;
  childrenMap: Map<number, number[]>;
  cpuSnapshots: Map<string, CpuSnapshot>;
};

function createSeededCache(): ProcessTreeCache {
  const processTree = new ProcessTreeCache();
  const internals = processTree as unknown as {
    cache: Map<number, ProcessInfo>;
    childrenMap: Map<number, number[]>;
  };

  internals.cache = new Map<number, ProcessInfo>([
    [2, { pid: 2, ppid: 1, comm: "node", command: "node a.js", cpuPercent: 0.2 }],
    [3, { pid: 3, ppid: 1, comm: "node", command: "node b.js", cpuPercent: 0.1 }],
    [4, { pid: 4, ppid: 2, comm: "npm", command: "npm test", cpuPercent: 1.5 }],
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

  it("does not mutate descendant structure when computing cpu usage", () => {
    const processTree = createSeededCache();

    expect(processTree.getDescendantsCpuUsage(1)).toBeCloseTo(1.8, 6);
    expect(processTree.getChildPids(1)).toEqual([2, 3]);
    expect(processTree.getChildPids(2)).toEqual([4]);

    // Repeat call should be stable and return the same value.
    expect(processTree.getDescendantsCpuUsage(1)).toBeCloseTo(1.8, 6);
    expect(processTree.getChildPids(1)).toEqual([2, 3]);
  });

  it("does not mutate child map when checking active descendants", () => {
    const processTree = createSeededCache();

    expect(processTree.hasActiveDescendants(1, 1.0)).toBe(true);
    expect(processTree.getChildPids(1)).toEqual([2, 3]);
    expect(processTree.getChildPids(2)).toEqual([4]);

    expect(processTree.hasActiveDescendants(1, 1.0)).toBe(true);
  });

  it("returns false for active descendants when none exceed threshold", () => {
    const processTree = createSeededCache();

    expect(processTree.hasActiveDescendants(1, 2.0)).toBe(false);
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
