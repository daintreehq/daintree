import { describe, expect, it } from "vitest";

import {
  computeDefaultCachedViews,
  effectiveCachedProjectViews,
  isValidCachedProjectViews,
  memoryPressureTarget,
} from "../cachedProjectViews.js";
import { getSystemMemoryThresholds } from "../systemMemory.js";

const GIB = 1024 ** 3;

describe("computeDefaultCachedViews", () => {
  it("returns 2 for machines below 16 GiB", () => {
    expect(computeDefaultCachedViews(4 * GIB)).toBe(2);
    expect(computeDefaultCachedViews(8 * GIB)).toBe(2);
    expect(computeDefaultCachedViews(16 * GIB - 1)).toBe(2);
  });

  it("returns 3 from the 16 GiB threshold up to just below 32 GiB", () => {
    expect(computeDefaultCachedViews(16 * GIB)).toBe(3);
    expect(computeDefaultCachedViews(24 * GIB)).toBe(3);
    expect(computeDefaultCachedViews(32 * GIB - 1)).toBe(3);
  });

  it("returns 4 from the 32 GiB threshold up to just below 64 GiB", () => {
    expect(computeDefaultCachedViews(32 * GIB)).toBe(4);
    expect(computeDefaultCachedViews(48 * GIB)).toBe(4);
    expect(computeDefaultCachedViews(64 * GIB - 1)).toBe(4);
  });

  it("returns 5 (the cache ceiling) at the 64 GiB threshold and above", () => {
    expect(computeDefaultCachedViews(64 * GIB)).toBe(5);
    expect(computeDefaultCachedViews(96 * GIB)).toBe(5);
    expect(computeDefaultCachedViews(128 * GIB)).toBe(5);
  });

  it("falls back to 2 for invalid or non-positive inputs", () => {
    expect(computeDefaultCachedViews(0)).toBe(2);
    expect(computeDefaultCachedViews(-1)).toBe(2);
    expect(computeDefaultCachedViews(Number.NaN)).toBe(2);
    expect(computeDefaultCachedViews(Number.POSITIVE_INFINITY)).toBe(2);
  });

  it("returns strictly increasing caps across the RAM tiers", () => {
    const low = computeDefaultCachedViews(8 * GIB);
    const mid = computeDefaultCachedViews(48 * GIB);
    const high = computeDefaultCachedViews(96 * GIB);
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
  });
});

describe("isValidCachedProjectViews", () => {
  it("accepts integers within [1, 5]", () => {
    for (const n of [1, 2, 3, 4, 5]) {
      expect(isValidCachedProjectViews(n)).toBe(true);
    }
  });

  it("rejects out-of-range integers", () => {
    expect(isValidCachedProjectViews(0)).toBe(false);
    expect(isValidCachedProjectViews(6)).toBe(false);
    expect(isValidCachedProjectViews(-1)).toBe(false);
  });

  it("rejects non-integer numbers and non-numbers", () => {
    expect(isValidCachedProjectViews(2.5)).toBe(false);
    expect(isValidCachedProjectViews(Number.NaN)).toBe(false);
    expect(isValidCachedProjectViews("3")).toBe(false);
    expect(isValidCachedProjectViews(null)).toBe(false);
    expect(isValidCachedProjectViews(undefined)).toBe(false);
  });
});

describe("effectiveCachedProjectViews", () => {
  const mem = (gib: number) => gib * GIB;

  it("preserves a valid stored preference regardless of RAM or E2E mode", () => {
    expect(effectiveCachedProjectViews(2, { totalMemBytes: mem(128), isE2E: true })).toBe(2);
    expect(effectiveCachedProjectViews(5, { totalMemBytes: mem(8), isE2E: false })).toBe(5);
    expect(effectiveCachedProjectViews(1, { totalMemBytes: mem(64), isE2E: true })).toBe(1);
  });

  it("returns the E2E override when no valid preference is stored", () => {
    expect(effectiveCachedProjectViews(undefined, { totalMemBytes: mem(8), isE2E: true })).toBe(4);
    expect(effectiveCachedProjectViews(null, { totalMemBytes: mem(128), isE2E: true })).toBe(4);
    expect(effectiveCachedProjectViews("bogus", { totalMemBytes: mem(8), isE2E: true })).toBe(4);
  });

  it("derives from RAM when no preference and not in E2E mode", () => {
    expect(effectiveCachedProjectViews(undefined, { totalMemBytes: mem(8), isE2E: false })).toBe(2);
    expect(effectiveCachedProjectViews(undefined, { totalMemBytes: mem(32), isE2E: false })).toBe(
      4
    );
    expect(effectiveCachedProjectViews(undefined, { totalMemBytes: mem(64), isE2E: false })).toBe(
      5
    );
  });

  it("treats corrupted stored values as absent and falls back", () => {
    const ramDefault64 = { totalMemBytes: mem(64), isE2E: false };
    expect(effectiveCachedProjectViews("bogus", ramDefault64)).toBe(5);
    expect(effectiveCachedProjectViews(99, ramDefault64)).toBe(5);
    expect(effectiveCachedProjectViews(0, ramDefault64)).toBe(5);
    expect(effectiveCachedProjectViews(-1, ramDefault64)).toBe(5);
    expect(effectiveCachedProjectViews(2.5, ramDefault64)).toBe(5);
    expect(effectiveCachedProjectViews(Number.NaN, ramDefault64)).toBe(5);
    expect(effectiveCachedProjectViews({ v: 2 }, ramDefault64)).toBe(5);
  });

  it("honors the E2E override when stored value is invalid", () => {
    expect(effectiveCachedProjectViews(99, { totalMemBytes: mem(64), isE2E: true })).toBe(4);
    expect(effectiveCachedProjectViews("bogus", { totalMemBytes: mem(8), isE2E: true })).toBe(4);
    expect(effectiveCachedProjectViews(0, { totalMemBytes: mem(128), isE2E: true })).toBe(4);
  });

  it("prefers an explicit opts.isE2E over the environment variable", () => {
    const prev = process.env.DAINTREE_E2E_MODE;
    try {
      process.env.DAINTREE_E2E_MODE = "1";
      expect(effectiveCachedProjectViews(undefined, { totalMemBytes: mem(8), isE2E: false })).toBe(
        2
      );
      delete process.env.DAINTREE_E2E_MODE;
      expect(effectiveCachedProjectViews(undefined, { totalMemBytes: mem(8), isE2E: true })).toBe(
        4
      );
    } finally {
      if (prev === undefined) {
        delete process.env.DAINTREE_E2E_MODE;
      } else {
        process.env.DAINTREE_E2E_MODE = prev;
      }
    }
  });

  it("reads DAINTREE_E2E_MODE from the environment when isE2E is not provided", () => {
    const prev = process.env.DAINTREE_E2E_MODE;
    try {
      process.env.DAINTREE_E2E_MODE = "1";
      expect(effectiveCachedProjectViews(undefined, { totalMemBytes: mem(8) })).toBe(4);
      process.env.DAINTREE_E2E_MODE = "0";
      expect(effectiveCachedProjectViews(undefined, { totalMemBytes: mem(8) })).toBe(2);
      process.env.DAINTREE_E2E_MODE = "false";
      expect(effectiveCachedProjectViews(undefined, { totalMemBytes: mem(8) })).toBe(2);
      delete process.env.DAINTREE_E2E_MODE;
      expect(effectiveCachedProjectViews(undefined, { totalMemBytes: mem(8) })).toBe(2);
    } finally {
      if (prev === undefined) {
        delete process.env.DAINTREE_E2E_MODE;
      } else {
        process.env.DAINTREE_E2E_MODE = prev;
      }
    }
  });
});

describe("memoryPressureTarget", () => {
  const band = { criticalMb: 1024, warningMb: 2048 };

  it("leaves the configured cap alone at or above the warning edge", () => {
    expect(memoryPressureTarget(band.warningMb, band, 5)).toEqual({ level: "none", targetMax: 5 });
    expect(memoryPressureTarget(64 * 1024, band, 5)).toEqual({ level: "none", targetMax: 5 });
  });

  it("collapses to the active view alone below the critical edge", () => {
    expect(memoryPressureTarget(band.criticalMb - 1, band, 5)).toEqual({
      level: "critical",
      targetMax: 1,
    });
    expect(memoryPressureTarget(0, band, 5)).toEqual({ level: "critical", targetMax: 1 });
  });

  it("treats the critical edge itself as soft, not critical (strict <)", () => {
    // Only the strict `<` collapse boundary carries over from the previous
    // single-threshold check — at the edge itself the reading is now soft
    // (stepped) where it used to mean "no override at all".
    expect(memoryPressureTarget(band.criticalMb, band, 5).level).toBe("soft");
  });

  it("sheds one view per equal slice of the band", () => {
    // 5 views over a 1024MB band = one step per 256MB, so the cap walks
    // 4 → 3 → 2 → 1 as headroom falls, rather than collapsing at one point.
    const caps = [2047, 1792, 1791, 1536, 1280, 1024].map(
      (availableMb) => memoryPressureTarget(availableMb, band, 5).targetMax
    );
    expect(caps).toEqual([4, 4, 3, 3, 2, 1]);
  });

  it("is monotonic and stays within [1, max] across the whole band", () => {
    let previous = 0;
    for (let availableMb = 0; availableMb <= 3000; availableMb += 7) {
      const { targetMax } = memoryPressureTarget(availableMb, band, 5);
      expect(Number.isInteger(targetMax)).toBe(true);
      expect(targetMax).toBeGreaterThanOrEqual(1);
      expect(targetMax).toBeLessThanOrEqual(5);
      expect(targetMax).toBeGreaterThanOrEqual(previous);
      previous = targetMax;
    }
  });

  it("reads the warning edge rather than inferring it from the critical one", () => {
    // A non-2:1 band proves warningMb is genuinely consumed — a `critical * 2`
    // derivation would put 1500MB above the band top and report no pressure.
    const wide = { criticalMb: 500, warningMb: 4000 };
    expect(memoryPressureTarget(1500, wide, 5).level).toBe("soft");
    expect(memoryPressureTarget(1500, wide, 5).targetMax).toBeLessThan(5);
  });

  it("degenerates to the pre-#11469 cliff when both edges coincide", () => {
    // The legacy single-scalar setter maps to critical === warning: every
    // reading is either untouched or an immediate collapse, never stepped.
    const cliff = { criticalMb: 768, warningMb: 768 };
    expect(memoryPressureTarget(768, cliff, 5)).toEqual({ level: "none", targetMax: 5 });
    expect(memoryPressureTarget(767, cliff, 5)).toEqual({ level: "critical", targetMax: 1 });
  });

  it("has no step to take when only the active view fits", () => {
    expect(memoryPressureTarget(1500, band, 1)).toEqual({ level: "soft", targetMax: 1 });
  });

  it("normalizes a fractional or non-finite cap into a whole view count", () => {
    // The return value caps a view count, so a bad input must not leak out as
    // a fractional target that the eviction loop would compare against.
    expect(memoryPressureTarget(1500, band, 4.7)).toEqual(memoryPressureTarget(1500, band, 4));
    expect(Number.isInteger(memoryPressureTarget(1500, band, 4.7).targetMax)).toBe(true);
    expect(memoryPressureTarget(1500, band, Number.NaN).targetMax).toBe(1);
  });

  it("treats an unreadable availability figure as no pressure", () => {
    // Unknown must never read as "zero available" — that would collapse the
    // whole cache on a failed reading.
    expect(memoryPressureTarget(Number.NaN, band, 5)).toEqual({ level: "none", targetMax: 5 });
  });

  it("keeps a usable band on every RAM tier the app ships defaults for", () => {
    // The ladder needs headroom between the edges to step through; the capped
    // fractions must never produce a degenerate band on a supported machine.
    for (const totalGib of [4, 8, 16, 32, 64, 128]) {
      const thresholds = getSystemMemoryThresholds(totalGib * 1024);
      expect(thresholds.warningMb).toBeGreaterThan(thresholds.criticalMb);
      const maxViews = computeDefaultCachedViews(totalGib * GIB);
      const justUnderWarning = memoryPressureTarget(thresholds.warningMb - 1, thresholds, maxViews);
      // Crossing the warning edge must cost exactly one cached view, whatever
      // the machine's tier — that is what makes reclaim start early.
      expect(justUnderWarning.level).toBe("soft");
      expect(justUnderWarning.targetMax).toBe(Math.max(maxViews - 1, 1));
    }
  });

  it("walks every rung between the edges on every machine from 4 GiB up", () => {
    // Widening the warning edge with RAM (#11926) is only worth anything if the
    // extra room turns into extra rungs. Sweeping the real band proves the
    // ladder still sheds one view at a time rather than collapsing — the
    // #11469 contract — now that the band is no longer a flat 1024MB.
    // Swept densely rather than at round tiers: the band widens continuously
    // while the view cap steps, so the extremes sit just BELOW each boundary
    // (at 15 GiB the band is already 1184MB wide but the cap is still 2).
    // Sampling only 4/8/16/32/64/128 GiB walks straight past them.
    const notSoft: string[] = [];
    const missingRungs: string[] = [];
    const thinRungs: string[] = [];
    const wideRungs: string[] = [];
    for (let totalGib = 4; totalGib <= 130; totalGib += 0.25) {
      const band = getSystemMemoryThresholds(totalGib * 1024);
      const maxViews = computeDefaultCachedViews(totalGib * GIB);
      const width = band.warningMb - band.criticalMb;
      const seen = new Set<number>();
      for (let i = 0; i < 200; i++) {
        const { level, targetMax } = memoryPressureTarget(
          band.criticalMb + (width * i) / 200,
          band,
          maxViews
        );
        if (level !== "soft") notSoft.push(`${totalGib}GiB: ${level} inside the band`);
        seen.add(targetMax);
      }
      // Every intermediate cap is reachable, and none exceeds the step-down
      // ceiling of `cap - 1` (the configured cap only returns above warning).
      const expected = Array.from({ length: Math.max(maxViews - 1, 1) }, (_, i) => i + 1);
      const walked = [...seen].sort((a, b) => a - b);
      if (walked.join() !== expected.join()) {
        missingRungs.push(`${totalGib}GiB: walked ${walked.join("/")} of ${expected.join("/")}`);
      }
      // No rung may collapse below one cached renderer (~100-500MB), or a
      // tick's reclaim buys less than the switch it costs. The floor holds
      // from 4 GiB up; below the knee the band is still the untouched 0.1×RAM
      // fraction, so a 2 GiB machine's 205MB rung is legacy behavior this
      // change deliberately leaves alone.
      const rungMb = width / Math.max(maxViews - 1, 1);
      if (rungMb < 256) thinRungs.push(`${totalGib}GiB: ${Math.round(rungMb)}MB rung`);
      // Only meaningful where there is more than one background view to shed:
      // at cap 2 the single "rung" IS the whole band, a shed point rather than
      // a step size. Where the ladder really steps, no step may swallow the
      // band — that would be the pre-#11469 cliff wearing a graduated coat.
      if (maxViews > 2 && rungMb > 1024) {
        wideRungs.push(`${totalGib}GiB: ${Math.round(rungMb)}MB rung on cap ${maxViews}`);
      }
    }
    expect(notSoft.slice(0, 3)).toEqual([]);
    expect(missingRungs.slice(0, 3)).toEqual([]);
    expect(thinRungs.slice(0, 3)).toEqual([]);
    expect(wideRungs.slice(0, 3)).toEqual([]);
  });
});
