import { describe, it, expect } from "vitest";
import { estimateMemoryUsage, getScrollbackForType } from "../scrollbackConfig";

describe("estimateMemoryUsage", () => {
  it("computes per-type and total bytes for a typical 8-agent + 8-shell session", () => {
    const result = estimateMemoryUsage({ agent: 8, plain: 8 }, 1000);
    // agent: 1000 * 5 = 5000 lines/term, 5000 * 1200 * 8 = 48,000,000
    // plain: 1000 * 0.3 = 300 lines/term, 300 * 1200 * 8 =  2,880,000
    // total = 50,880,000
    expect(result.agent).toBe(48_000_000);
    expect(result.plain).toBe(2_880_000);
    expect(result.total).toBe(50_880_000);
  });

  it("computes a single agent terminal at default scrollback", () => {
    const result = estimateMemoryUsage({ agent: 1, plain: 0 }, 1000);
    expect(result.agent).toBe(6_000_000);
    expect(result.plain).toBe(0);
    expect(result.total).toBe(6_000_000);
  });

  it("computes a single plain terminal at default scrollback", () => {
    const result = estimateMemoryUsage({ agent: 0, plain: 1 }, 1000);
    expect(result.agent).toBe(0);
    expect(result.plain).toBe(360_000);
    expect(result.total).toBe(360_000);
  });

  it("uses maxLines for unlimited scrollback (base=0)", () => {
    const result = estimateMemoryUsage({ agent: 8, plain: 8 }, 0);
    // agent: 5000 lines/term, plain: 2000 lines/term
    expect(result.agent).toBe(5000 * 1200 * 8); // 48,000,000
    expect(result.plain).toBe(2000 * 1200 * 8); // 19,200,000
    expect(result.total).toBe(67_200_000);
  });

  it("returns zeros when there are no terminals", () => {
    const result = estimateMemoryUsage({ agent: 0, plain: 0 }, 1000);
    expect(result.agent).toBe(0);
    expect(result.plain).toBe(0);
    expect(result.total).toBe(0);
  });
});

describe("getScrollbackForType", () => {
  it("gives agent terminals at least as much scrollback as plain terminals at any base", () => {
    for (const base of [0, 1, 100, 500, 1000, 2000, 5000, 10000]) {
      expect(getScrollbackForType(true, base)).toBeGreaterThanOrEqual(
        getScrollbackForType(false, base)
      );
    }
  });

  it("scales agent scrollback proportionally below the cap and clamps above it", () => {
    const atLowBase = getScrollbackForType(true, 500);
    const atDefaultBase = getScrollbackForType(true, 1000);
    const atHighBase = getScrollbackForType(true, 5000);
    expect(atLowBase).toBeLessThan(atDefaultBase);
    expect(atDefaultBase).toBe(atHighBase);
  });
});
