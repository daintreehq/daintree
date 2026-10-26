import { describe, expect, it } from "vitest";
import { computeHostAgentLimit, describeHostAgentLimit } from "../hostAgentLimit.js";

const GiB = 1024 * 1024 * 1024;

describe("computeHostAgentLimit", () => {
  it("holds a 36 GB host below the thirteen agents that took one down", () => {
    expect(computeHostAgentLimit(36 * GiB)).toBeLessThan(13);
  });

  it("grows with the host's memory", () => {
    const sizes = [16, 32, 64, 128, 256].map((gb) => computeHostAgentLimit(gb * GiB));
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeGreaterThan(sizes[i - 1]);
  });

  it("never drops below the floor, even with no memory reading", () => {
    const floor = computeHostAgentLimit(4 * GiB);
    expect(floor).toBeGreaterThanOrEqual(1);
    expect(computeHostAgentLimit(1 * GiB)).toBe(floor);
    expect(computeHostAgentLimit(0)).toBe(floor);
    expect(computeHostAgentLimit(Number.NaN)).toBe(floor);
  });
});

describe("describeHostAgentLimit", () => {
  it("names the host and its limit", () => {
    const text = describeHostAgentLimit({ host: "Mac Studio", count: 10, limit: 10 });
    expect(text).toContain("Mac Studio");
    expect(text).toContain("10");
  });
});
