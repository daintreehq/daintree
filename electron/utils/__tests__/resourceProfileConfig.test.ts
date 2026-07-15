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
      for (const key of Object.keys(base) as (keyof typeof base)[]) {
        expect(resolved[key]).toBe(base[key]);
      }
      // …and adds exactly the two resolved WebGL fields on top of the base keys.
      expect(new Set(Object.keys(resolved))).toEqual(
        new Set([...Object.keys(base), "webglUpperThreshold", "webglLowerThreshold"])
      );
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
