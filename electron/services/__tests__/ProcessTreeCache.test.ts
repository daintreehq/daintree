import { describe, expect, it } from "vitest";
import { ProcessTreeCache, type ProcessInfo } from "../ProcessTreeCache.js";

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
});
