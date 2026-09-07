import { describe, expect, it } from "vitest";
import { getScenarioBudget, loadBudgetConfig } from "../lib/budgets";

describe("perf budgets", () => {
  it("loads the reference config", () => {
    // `criticalScenarios` is deliberately gone. It only ever decided which
    // scenarios could FAIL a run, and nothing fails now — keeping it would have
    // left a config key that silently suppressed a coverage warning.
    const config = loadBudgetConfig();
    expect(Object.keys(config.scenarios).length).toBeGreaterThan(0);
    expect(config.defaultBudget.maxRegressionPct).toBeGreaterThan(0);
  });

  it("merges default and scenario-specific budgets", () => {
    const config = loadBudgetConfig();
    const scenarioBudget = getScenarioBudget(config, "PERF-042");
    const fallbackBudget = getScenarioBudget(config, "PERF-999");

    expect(scenarioBudget.p95Ms).toBeTypeOf("number");
    expect(scenarioBudget.maxMetricValues?.eventLoopLagMs).toBe(100);
    expect(fallbackBudget.maxRegressionPct).toBe(config.defaultBudget.maxRegressionPct);
  });
});
