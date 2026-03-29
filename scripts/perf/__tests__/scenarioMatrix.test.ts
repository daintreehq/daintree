import { describe, expect, it } from "vitest";
import { allScenarios, assertMatrixCoverage, getScenariosForMode } from "../scenarios";

describe("perf scenario matrix", () => {
  it("covers full PERF matrix", () => {
    expect(() => assertMatrixCoverage()).not.toThrow();
    expect(allScenarios).toHaveLength(28);
  });

  it("returns mode-specific scenario sets", () => {
    const smoke = getScenariosForMode("smoke");
    const ci = getScenariosForMode("ci");
    const nightly = getScenariosForMode("nightly");
    const soak = getScenariosForMode("soak");

    expect(smoke.length).toBeGreaterThan(0);
    expect(ci.length).toBeGreaterThan(smoke.length - 1);
    expect(nightly.length).toBeGreaterThanOrEqual(ci.length);
    expect(soak.length).toBeGreaterThan(0);
  });

  it("has unique scenario IDs", () => {
    const ids = allScenarios.map((scenario) => scenario.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});
