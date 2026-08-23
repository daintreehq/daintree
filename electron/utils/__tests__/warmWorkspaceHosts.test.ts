import { describe, expect, it } from "vitest";
import { computeDefaultWarmWorkspaceHosts } from "../warmWorkspaceHosts.js";

const GIB = 1024 ** 3;

describe("computeDefaultWarmWorkspaceHosts", () => {
  it("returns a whole, bounded pool size for every plausible machine", () => {
    // The result caps a dormant-host count that the pool decrements in a
    // `while` loop, so a fractional or unbounded value would either never
    // settle or park an unbounded number of paused utility processes.
    for (const totalGib of [1, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 512]) {
      const pool = computeDefaultWarmWorkspaceHosts(totalGib * GIB);
      expect(Number.isInteger(pool)).toBe(true);
      expect(pool).toBeGreaterThanOrEqual(2);
      expect(pool).toBeLessThanOrEqual(5);
    }
  });

  it("never shrinks the pool as RAM grows", () => {
    let previous = 0;
    for (let totalGib = 1; totalGib <= 256; totalGib++) {
      const pool = computeDefaultWarmWorkspaceHosts(totalGib * GIB);
      expect(pool).toBeGreaterThanOrEqual(previous);
      previous = pool;
    }
  });

  it("steps up at each tier boundary and holds between them", () => {
    // Tests the ladder's conditional structure rather than its constants: a
    // boundary must cost exactly one step, and the byte just below it must
    // still read as the lower tier.
    for (const boundaryGib of [16, 32, 64]) {
      const below = computeDefaultWarmWorkspaceHosts(boundaryGib * GIB - 1);
      const at = computeDefaultWarmWorkspaceHosts(boundaryGib * GIB);
      expect(at - below).toBe(1);
      expect(computeDefaultWarmWorkspaceHosts(boundaryGib * GIB + GIB)).toBe(at);
    }
  });

  it("saturates rather than growing without bound", () => {
    const top = computeDefaultWarmWorkspaceHosts(64 * GIB);
    expect(computeDefaultWarmWorkspaceHosts(1024 * GIB)).toBe(top);
    expect(computeDefaultWarmWorkspaceHosts(Number.MAX_SAFE_INTEGER)).toBe(top);
  });

  it("falls back to the smallest pool on an unreadable total", () => {
    // os.totalmem() is the only caller, but a 0/NaN reading must not produce a
    // NaN cap — the pool's eviction loop would then never terminate its guard.
    const smallest = computeDefaultWarmWorkspaceHosts(1 * GIB);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(computeDefaultWarmWorkspaceHosts(bad)).toBe(smallest);
    }
  });
});
