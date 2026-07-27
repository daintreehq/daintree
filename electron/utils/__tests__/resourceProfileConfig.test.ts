import { describe, it, expect } from "vitest";
import {
  RESOURCE_PROFILE_CONFIGS,
  type ResourceProfile,
} from "../../../shared/types/resourceProfile.js";
import { resolveResourceProfileConfig } from "../resourceProfileConfig.js";

const PROFILES: ResourceProfile[] = ["performance", "balanced", "efficiency"];

describe("resolveResourceProfileConfig", () => {
  it("forwards the ceiling so WebGL thresholds scale (not pinned to one tier)", () => {
    // Concrete anchors independent of resolveWebglThresholds: a wrapper that
    // ignored its ceiling argument (e.g. hardcoded 24) would return the 24-tier
    // pair for both calls and fail the 32-tier expectation.
    expect(resolveResourceProfileConfig("balanced", 24)).toMatchObject({
      webglUpperThreshold: 18,
      webglLowerThreshold: 15,
    });
    expect(resolveResourceProfileConfig("balanced", 32)).toMatchObject({
      webglUpperThreshold: 24,
      webglLowerThreshold: 20,
    });
    expect(resolveResourceProfileConfig("performance", 32)).toMatchObject({
      webglUpperThreshold: 28,
      webglLowerThreshold: 24,
    });
  });

  it("preserves every base field from the static table verbatim", () => {
    for (const profile of PROFILES) {
      const base = RESOURCE_PROFILE_CONFIGS[profile];
      const resolved = resolveResourceProfileConfig(profile, 28);
      // Every base field is carried through unchanged…
      expect(resolved).toMatchObject(base);
      // …and the resolved config adds exactly the two WebGL fields on top.
      expect(new Set(Object.keys(resolved))).toEqual(
        new Set([...Object.keys(base), "webglUpperThreshold", "webglLowerThreshold"])
      );
    }
  });

  it("keeps every hard timeout at or above its soft counterpart", () => {
    // The soft bound only warns; the hard bound is what abandons the work. If
    // a profile ever inverts them the soft phase is unreachable and the
    // two-phase design silently collapses back to a single fatal deadline.
    for (const profile of PROFILES) {
      const config = RESOURCE_PROFILE_CONFIGS[profile];
      expect(config.paintGateHardTimeoutMs).toBeGreaterThanOrEqual(config.paintGateTimeoutMs);
      expect(config.warmPaintGateHardTimeoutMs).toBeGreaterThanOrEqual(
        config.warmPaintGateTimeoutMs
      );
      expect(config.viewLoadHardTimeoutMs).toBeGreaterThanOrEqual(config.viewLoadTimeoutMs);
      // A view-load ceiling below the paint-gate ceiling would abandon loads
      // the gate downstream is still willing to wait for.
      expect(config.viewLoadHardTimeoutMs).toBeGreaterThan(config.paintGateHardTimeoutMs);
    }
  });

  it("does not mutate the shared RESOURCE_PROFILE_CONFIGS table", () => {
    const balancedBefore = { ...RESOURCE_PROFILE_CONFIGS.balanced };
    resolveResourceProfileConfig("balanced", 32);
    expect(RESOURCE_PROFILE_CONFIGS.balanced).toEqual(balancedBefore);
    // The WebGL fields must never leak back onto the static table.
    expect("webglUpperThreshold" in RESOURCE_PROFILE_CONFIGS.balanced).toBe(false);
    expect("webglLowerThreshold" in RESOURCE_PROFILE_CONFIGS.balanced).toBe(false);
  });
});
