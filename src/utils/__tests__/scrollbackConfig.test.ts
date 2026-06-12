import { describe, it, expect, afterEach } from "vitest";
import {
  estimateMemoryUsage,
  getAgentScrollbackMaxLines,
  getScrollbackForType,
  setAgentScrollbackMaxLines,
} from "../scrollbackConfig";

const originalAgentMax = getAgentScrollbackMaxLines();

afterEach(() => {
  setAgentScrollbackMaxLines(originalAgentMax);
});

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
    // base=500 is the realistic memory-pressure restore base (SCROLLBACK_BACKGROUND)
    expect(getScrollbackForType(true, 500)).toBe(2500);
    expect(getScrollbackForType(true, 1000)).toBe(5000);
    expect(getScrollbackForType(true, 5000)).toBe(5000);
  });

  it("keeps plain terminals on the small policy at the default base", () => {
    expect(getScrollbackForType(false, 1000)).toBe(300);
  });

  it("applies the minLines floor for tiny bases", () => {
    expect(getScrollbackForType(true, 1)).toBe(500);
    expect(getScrollbackForType(false, 1)).toBe(200);
  });

  describe("resource-profile agent ceiling", () => {
    it("lowering the ceiling clamps agent terminals but leaves plain terminals alone", () => {
      const plainBefore = getScrollbackForType(false, 1000);
      setAgentScrollbackMaxLines(2500);

      expect(getScrollbackForType(true, 1000)).toBe(2500);
      expect(getScrollbackForType(true, 0)).toBe(2500);
      expect(getScrollbackForType(false, 1000)).toBe(plainBefore);
    });

    it("never raises the ceiling above the policy max", () => {
      setAgentScrollbackMaxLines(50_000);
      expect(getScrollbackForType(true, 0)).toBe(5000);
    });

    it("clamps the ceiling to the policy floor and ignores non-finite input", () => {
      setAgentScrollbackMaxLines(10);
      expect(getScrollbackForType(true, 0)).toBe(500);

      setAgentScrollbackMaxLines(Number.NaN);
      expect(getScrollbackForType(true, 0)).toBe(500);
    });
  });
});
