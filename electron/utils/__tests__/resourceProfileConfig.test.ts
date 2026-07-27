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

  it("keeps every hard timeout strictly above its soft counterpart", () => {
    // The soft bound only warns; the hard bound abandons the work. Equality
    // is as broken as inversion: both fire in the same timer turn, leaving no
    // interval in which slow-but-alive work can recover, which collapses each
    // two-phase design back into the single fatal deadline it replaced.
    for (const profile of PROFILES) {
      const config = RESOURCE_PROFILE_CONFIGS[profile];
      expect(config.paintGateHardTimeoutMs).toBeGreaterThan(config.paintGateTimeoutMs);
      expect(config.warmPaintGateHardTimeoutMs).toBeGreaterThan(config.warmPaintGateTimeoutMs);
      expect(config.viewLoadHardTimeoutMs).toBeGreaterThan(config.viewLoadTimeoutMs);
    }
  });

  it("gives efficiency more view-load headroom than balanced", () => {
    // The profile exists because the machine is under pressure; a ceiling at
    // or below balanced's would defeat the reason for scaling it at all.
    expect(RESOURCE_PROFILE_CONFIGS.efficiency.viewLoadTimeoutMs).toBeGreaterThan(
      RESOURCE_PROFILE_CONFIGS.balanced.viewLoadTimeoutMs
    );
    expect(RESOURCE_PROFILE_CONFIGS.efficiency.viewLoadHardTimeoutMs).toBeGreaterThan(
      RESOURCE_PROFILE_CONFIGS.balanced.viewLoadHardTimeoutMs
    );
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
