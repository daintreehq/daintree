import { describe, expect, it } from "vitest";
import { computeHostAgentLimit, describeHostAgentLimit } from "../hostAgentLimit.js";

const GiB = 1024 * 1024 * 1024;

describe("computeHostAgentLimit", () => {
  it("holds a 36 GB host below the thirteen agents that took one down", () => {
    expect(computeHostAgentLimit(36 * GiB)).toBe(10);
  });

  it("rounds a partial agent's worth of memory down, never up", () => {
    expect(computeHostAgentLimit(12 * GiB)).toBe(2);
    expect(computeHostAgentLimit(13 * GiB)).toBe(3);
    expect(computeHostAgentLimit(15.9 * GiB)).toBe(3);
    expect(computeHostAgentLimit(64 * GiB)).toBe(20);
  });

  it("grows with the host's memory", () => {
    const sizes = [16, 32, 64, 128, 256].map((gb) => computeHostAgentLimit(gb * GiB));
    sizes.slice(1).forEach((size, i) => expect(size).toBeGreaterThan(sizes[i] ?? Infinity));
  });

  it("keeps two agents on a small host, or with no memory reading at all", () => {
    for (const bytes of [8 * GiB, 4 * GiB, 1 * GiB, 0, -1, Number.NaN, Infinity]) {
      expect(computeHostAgentLimit(bytes)).toBe(2);
    }
  });
});

describe("describeHostAgentLimit", () => {
  it("names the host and its limit", () => {
    const text = describeHostAgentLimit({ host: "Mac Studio", count: 12, limit: 10 });
    expect(text).toContain("Mac Studio");
    expect(text).toContain("10");
    expect(text).not.toContain("12");
  });
});
