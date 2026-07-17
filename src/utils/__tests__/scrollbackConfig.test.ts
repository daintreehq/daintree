import { describe, it, expect, afterEach } from "vitest";
import { RESOURCE_PROFILE_CONFIGS } from "@shared/types/resourceProfile";
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
    // agent: 1000 * 10 = 10000 lines/term (at cap), 10000 * 1200 * 8 = 96,000,000
    // plain: 1000 * 0.3 = 300 lines/term, 300 * 1200 * 8 =  2,880,000
    // total = 98,880,000
    expect(result.agent).toBe(96_000_000);
    expect(result.plain).toBe(2_880_000);
    expect(result.total).toBe(98_880_000);
  });

  it("computes a single agent terminal below the cap so the multiplier is exercised", () => {
    // base=500 keeps the agent value (5000) under the 10k cap, so this proves
    // the estimate flows the multiplier through rather than always using maxLines.
    const result = estimateMemoryUsage({ agent: 1, plain: 0 }, 500);
    // 500 * 10 = 5000 lines, 5000 * 1200 = 6,000,000
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
    // agent: 10000 lines/term, plain: 2000 lines/term
    expect(result.agent).toBe(10000 * 1200 * 8); // 96,000,000
    expect(result.plain).toBe(2000 * 1200 * 8); // 19,200,000
    expect(result.total).toBe(115_200_000);
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
    // Sub-cap: the ×10 multiplier is applied verbatim (500 is also the realistic
    // memory-pressure restore base, SCROLLBACK_BACKGROUND). 999 sits just below
    // saturation so it proves scaling rather than clamping.
    expect(getScrollbackForType(true, 500)).toBe(5000);
    expect(getScrollbackForType(true, 999)).toBe(9990);
    // At/above saturation (base ≥ 1000): clamped to the 10k policy ceiling.
    expect(getScrollbackForType(true, 1001)).toBe(10000);
    expect(getScrollbackForType(true, 5000)).toBe(10000);
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
      // Invariant, not a copied literal: a profile ceiling above the policy max
      // cannot push the effective cap past what the policy already allows.
      const capBefore = getScrollbackForType(true, 0);
      setAgentScrollbackMaxLines(50_000);
      expect(getScrollbackForType(true, 0)).toBe(capBefore);
    });

    it("binds the effective agent cap to the configured efficiency ceiling", () => {
      // Feed the real efficiency ceiling in rather than a copied literal: whatever
      // the profile table configures becomes the binding cap, and a sub-ceiling
      // base still scales by the multiplier beneath it.
      const efficiencyCeiling = RESOURCE_PROFILE_CONFIGS.efficiency.agentScrollbackMaxLines;
      setAgentScrollbackMaxLines(efficiencyCeiling);

      expect(getScrollbackForType(true, 0)).toBe(efficiencyCeiling);
      expect(getScrollbackForType(true, 100_000)).toBe(efficiencyCeiling);
      // A base whose ×10 result is under the efficiency ceiling scales freely.
      const subCeilingBase = Math.floor(efficiencyCeiling / 10) - 1;
      expect(getScrollbackForType(true, subCeilingBase)).toBe(subCeilingBase * 10);
    });

    it("keeps performance and balanced ceilings equal and above efficiency", () => {
      // Ordering invariant across the profile table — no per-value literals, so
      // the assertion survives any future retuning that preserves the ordering.
      const { performance, balanced, efficiency } = RESOURCE_PROFILE_CONFIGS;
      expect(performance.agentScrollbackMaxLines).toBe(balanced.agentScrollbackMaxLines);
      expect(efficiency.agentScrollbackMaxLines).toBeLessThan(balanced.agentScrollbackMaxLines);
    });

    it("clamps the ceiling to the policy floor and ignores non-finite input", () => {
      setAgentScrollbackMaxLines(10);
      expect(getScrollbackForType(true, 0)).toBe(500);

      setAgentScrollbackMaxLines(Number.NaN);
      expect(getScrollbackForType(true, 0)).toBe(500);
    });
  });
});
