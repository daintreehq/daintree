import { describe, it, expect, afterEach } from "vitest";
import { RESOURCE_PROFILE_CONFIGS } from "@shared/types/resourceProfile";
import { PTY_MIRROR_SCROLLBACK } from "@shared/config/scrollback";
import {
  AGENT_SCROLLBACK_MAX_LINES,
  estimateMemoryUsage,
  getAgentScrollbackMaxLines,
  getScrollbackForType,
  setAgentScrollbackMaxLines,
} from "../scrollbackConfig";

const originalAgentMax = getAgentScrollbackMaxLines();

afterEach(() => {
  setAgentScrollbackMaxLines(originalAgentMax);
});

function limitsAt(base: number): { agent: number; plain: number } {
  return { agent: getScrollbackForType(true, base), plain: getScrollbackForType(false, base) };
}

describe("estimateMemoryUsage", () => {
  it("computes per-type and total bytes for a typical 8-agent + 8-shell session", () => {
    const result = estimateMemoryUsage({ agent: 8, plain: 8 }, limitsAt(1000));
    // A line at 180 columns: 180 * 12 + 240 = 2,400 bytes.
    // agent: 1000 * 10 clamps to the 5000-line mirror cap, 5000 * 2400 * 8 = 96,000,000
    // plain: 1000 * 0.3 = 300 lines/term, 300 * 2400 * 8 = 5,760,000
    expect(result.agent).toBe(96_000_000);
    expect(result.plain).toBe(5_760_000);
    expect(result.total).toBe(101_760_000);
  });

  it("computes a single agent terminal below the cap so the multiplier is exercised", () => {
    // base=300 keeps the agent value (3000) under the 5k cap, so this proves
    // the estimate flows the multiplier through rather than always using maxLines.
    const result = estimateMemoryUsage({ agent: 1, plain: 0 }, limitsAt(300));
    // 300 * 10 = 3000 lines, 3000 * 2400 = 7,200,000
    expect(result.agent).toBe(7_200_000);
    expect(result.plain).toBe(0);
    expect(result.total).toBe(7_200_000);
  });

  it("uses maxLines for unlimited scrollback (base=0)", () => {
    const result = estimateMemoryUsage({ agent: 8, plain: 8 }, limitsAt(0));
    // agent: 5000 lines/term, plain: 2000 lines/term, 2,400 bytes a line
    expect(result.agent).toBe(96_000_000);
    expect(result.plain).toBe(38_400_000);
    expect(result.total).toBe(134_400_000);
  });
});

describe("getScrollbackForType", () => {
  it("never keeps more agent history than the pty-host mirror can restore", () => {
    for (const profile of Object.values(RESOURCE_PROFILE_CONFIGS)) {
      setAgentScrollbackMaxLines(profile.agentScrollbackMaxLines);
      for (const base of [0, 500, 1000, 10000]) {
        expect(getScrollbackForType(true, base)).toBeLessThanOrEqual(PTY_MIRROR_SCROLLBACK);
      }
    }
    setAgentScrollbackMaxLines(originalAgentMax);
    expect(getScrollbackForType(true, 0)).toBe(PTY_MIRROR_SCROLLBACK);
  });

  it("gives agent terminals at least as much scrollback as plain terminals at any base", () => {
    for (const base of [0, 1, 100, 500, 1000, 2000, 5000, 10000]) {
      expect(getScrollbackForType(true, base)).toBeGreaterThanOrEqual(
        getScrollbackForType(false, base)
      );
    }
  });

  it("scales agent scrollback proportionally below the cap and clamps above it", () => {
    // Sub-cap: the ×10 multiplier is applied verbatim. 499 sits just below
    // saturation so it proves scaling rather than clamping.
    expect(getScrollbackForType(true, 300)).toBe(3000);
    expect(getScrollbackForType(true, 499)).toBe(4990);
    // At/above saturation (base ≥ 500, which includes the default and the
    // SCROLLBACK_BACKGROUND restore base): clamped to the mirror cap.
    expect(getScrollbackForType(true, 500)).toBe(AGENT_SCROLLBACK_MAX_LINES);
    expect(getScrollbackForType(true, 501)).toBe(AGENT_SCROLLBACK_MAX_LINES);
    expect(getScrollbackForType(true, 5000)).toBe(AGENT_SCROLLBACK_MAX_LINES);
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
      // Stored clamped too, so useResourceProfile's before/after comparison sees
      // no change and skips re-deriving open terminals.
      expect(getAgentScrollbackMaxLines()).toBe(capBefore);
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
