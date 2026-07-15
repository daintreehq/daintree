import { describe, it, expect } from "vitest";
import type { ResourceProfile } from "../../../shared/types/resourceProfile.js";
import {
  getMaxWebGLContextCeiling,
  resolveWebglThresholds,
  WEBGL_THRESHOLD_RATIOS,
} from "../webglContextBudget.js";

const GIB = 1024 ** 3;
const PROFILES: ResourceProfile[] = ["performance", "balanced", "efficiency"];
const SUPPORTED_CEILINGS = [24, 28, 32];

describe("getMaxWebGLContextCeiling", () => {
  it("returns 24 at or below the 8 GiB tier", () => {
    expect(getMaxWebGLContextCeiling(4 * GIB)).toBe(24);
    expect(getMaxWebGLContextCeiling(8 * GIB)).toBe(24);
  });

  it("returns 28 above 8 GiB up to and including 16 GiB", () => {
    expect(getMaxWebGLContextCeiling(8 * GIB + 1)).toBe(28);
    expect(getMaxWebGLContextCeiling(16 * GIB)).toBe(28);
  });

  it("returns 32 above 16 GiB", () => {
    expect(getMaxWebGLContextCeiling(16 * GIB + 1)).toBe(32);
    expect(getMaxWebGLContextCeiling(64 * GIB)).toBe(32);
  });

  it("is monotonic non-decreasing across the tiers", () => {
    const c1 = getMaxWebGLContextCeiling(4 * GIB);
    const c2 = getMaxWebGLContextCeiling(12 * GIB);
    const c3 = getMaxWebGLContextCeiling(32 * GIB);
    expect(c1).toBeLessThan(c2);
    expect(c2).toBeLessThan(c3);
  });
});

describe("resolveWebglThresholds — invariants", () => {
  for (const ceiling of SUPPORTED_CEILINGS) {
    it(`leaves headroom below the ceiling and a hysteresis gap at ceiling ${ceiling}`, () => {
      for (const profile of PROFILES) {
        const { webglUpperThreshold: upper, webglLowerThreshold: lower } = resolveWebglThresholds(
          profile,
          ceiling
        );
        // Headroom for non-terminal WebGL consumers: never claim the whole cap.
        expect(upper).toBeLessThan(ceiling);
        expect(ceiling - upper).toBeGreaterThanOrEqual(2);
        // Real hysteresis band so a single toggling panel cannot flap the fleet.
        expect(lower).toBeLessThan(upper);
        expect(upper - lower).toBeGreaterThanOrEqual(2);
        // Whole, non-negative context counts.
        expect(Number.isInteger(upper)).toBe(true);
        expect(Number.isInteger(lower)).toBe(true);
        expect(lower).toBeGreaterThanOrEqual(0);
      }
    });

    it(`preserves profile ordering efficiency < balanced < performance at ceiling ${ceiling}`, () => {
      const eff = resolveWebglThresholds("efficiency", ceiling);
      const bal = resolveWebglThresholds("balanced", ceiling);
      const perf = resolveWebglThresholds("performance", ceiling);
      expect(eff.webglUpperThreshold).toBeLessThan(bal.webglUpperThreshold);
      expect(bal.webglUpperThreshold).toBeLessThan(perf.webglUpperThreshold);
      expect(eff.webglLowerThreshold).toBeLessThan(bal.webglLowerThreshold);
      expect(bal.webglLowerThreshold).toBeLessThan(perf.webglLowerThreshold);
    });
  }

  it("scales thresholds up as the ceiling grows", () => {
    for (const profile of PROFILES) {
      const small = resolveWebglThresholds(profile, 24);
      const large = resolveWebglThresholds(profile, 32);
      expect(large.webglUpperThreshold).toBeGreaterThan(small.webglUpperThreshold);
      expect(large.webglLowerThreshold).toBeGreaterThan(small.webglLowerThreshold);
    }
  });

  it("derives exactly from the exported ratios at supported ceilings (clamps do not bind)", () => {
    // Ties the output to WEBGL_THRESHOLD_RATIOS: at 24/28/32 the defensive clamps
    // never engage, so both thresholds are exactly round(ceiling × ratio).
    for (const ceiling of SUPPORTED_CEILINGS) {
      for (const profile of PROFILES) {
        const { webglUpperThreshold: upper, webglLowerThreshold: lower } = resolveWebglThresholds(
          profile,
          ceiling
        );
        expect(upper).toBe(Math.round(ceiling * WEBGL_THRESHOLD_RATIOS[profile].upper));
        expect(lower).toBe(Math.round(ceiling * WEBGL_THRESHOLD_RATIOS[profile].lower));
      }
    }
  });

  it("clamps a degenerate ceiling to a valid (non-inverted, non-negative) pair", () => {
    // At ceiling 4 the raw ratio-derived values would violate the headroom /
    // hysteresis floors, so the clamps engage. Every profile resolves to the
    // same clamped {2, 0}: upper pulled to ceiling-2, lower to upper-2.
    for (const profile of PROFILES) {
      expect(resolveWebglThresholds(profile, 4)).toEqual({
        webglUpperThreshold: 2,
        webglLowerThreshold: 0,
      });
    }
  });
});

describe("resolveWebglThresholds — rounding anchors", () => {
  // Concrete computed outputs that pin the round-half-up behavior at each tier
  // (e.g. ceiling 28 balanced lower = round(17.5) = 18). Not copied constants —
  // each is ceiling × ratio, rounded, then clamped.
  it("ceiling 24", () => {
    expect(resolveWebglThresholds("performance", 24)).toEqual({
      webglUpperThreshold: 21,
      webglLowerThreshold: 18,
    });
    expect(resolveWebglThresholds("balanced", 24)).toEqual({
      webglUpperThreshold: 18,
      webglLowerThreshold: 15,
    });
    expect(resolveWebglThresholds("efficiency", 24)).toEqual({
      webglUpperThreshold: 12,
      webglLowerThreshold: 9,
    });
  });

  it("ceiling 28 (round-half-up boundaries)", () => {
    expect(resolveWebglThresholds("performance", 28)).toEqual({
      webglUpperThreshold: 25, // round(24.5)
      webglLowerThreshold: 21,
    });
    expect(resolveWebglThresholds("balanced", 28)).toEqual({
      webglUpperThreshold: 21,
      webglLowerThreshold: 18, // round(17.5)
    });
    expect(resolveWebglThresholds("efficiency", 28)).toEqual({
      webglUpperThreshold: 14,
      webglLowerThreshold: 11, // round(10.5)
    });
  });

  it("ceiling 32", () => {
    expect(resolveWebglThresholds("performance", 32)).toEqual({
      webglUpperThreshold: 28,
      webglLowerThreshold: 24,
    });
    expect(resolveWebglThresholds("balanced", 32)).toEqual({
      webglUpperThreshold: 24,
      webglLowerThreshold: 20,
    });
    expect(resolveWebglThresholds("efficiency", 32)).toEqual({
      webglUpperThreshold: 16,
      webglLowerThreshold: 12,
    });
  });
});
