import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BASELINE_FRESHNESS_DAYS,
  checkBaselineCoverage,
  checkBaselineFreshness,
} from "../lib/baselineCoverage";
import type { BaselineSummary, PerfBudgetConfig, PerfScenario } from "../types";

function scenario(id: string): PerfScenario {
  return {
    id,
    name: id,
    description: id,
    tier: "fast",
    modes: ["ci"],
    run: () => ({ durationMs: 1 }),
  };
}

const budgetConfig: PerfBudgetConfig = {
  criticalScenarios: ["PERF-001"],
  defaultBudget: { p95Ms: 5000, maxRegressionPct: 15 },
  scenarios: {
    "PERF-001": { p95Ms: 3500, maxRegressionPct: 15 },
    "PERF-070": { p95Ms: 1200, maxRegressionPct: 15 },
  },
};

// A config whose defaultBudget has no regression gate, so a scenario without an
// override is genuinely not regression-gated (the merge can't reintroduce it).
const noRegressionConfig: PerfBudgetConfig = {
  criticalScenarios: [],
  defaultBudget: { p95Ms: 5000 },
  scenarios: {
    "PERF-200": { p95Ms: 1000 },
  },
};

function baseline(
  p95ByScenario: Record<string, number>,
  generatedAt = "2026-06-01T00:00:00.000Z"
): BaselineSummary {
  return { generatedAt, mode: "ci", p95ByScenario };
}

describe("checkBaselineFreshness", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns when the baseline is older than the threshold", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const now = new Date("2026-06-07T00:00:00.000Z");
    const old = baseline({}, "2026-01-01T00:00:00.000Z"); // ~157 days
    checkBaselineFreshness(old, "ci", BASELINE_FRESHNESS_DAYS, now);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("does not warn when the baseline is within the threshold", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const now = new Date("2026-06-07T00:00:00.000Z");
    const fresh = baseline({}, "2026-06-01T00:00:00.000Z"); // 6 days
    checkBaselineFreshness(fresh, "ci", BASELINE_FRESHNESS_DAYS, now);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn exactly at the threshold boundary", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const now = new Date("2026-02-01T00:00:00.000Z");
    const atBoundary = baseline({}, "2026-01-02T00:00:00.000Z"); // exactly 30 days
    checkBaselineFreshness(atBoundary, "ci", 30, now);
    expect(warn).not.toHaveBeenCalled();
  });

  it("skips when no baseline is loaded", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    checkBaselineFreshness(null, "ci");
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not throw or warn on an unparseable timestamp", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad = baseline({}, "not-a-date");
    expect(() => checkBaselineFreshness(bad, "ci")).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("checkBaselineCoverage", () => {
  it("flags a budgeted scenario absent from the baseline", () => {
    const gaps = checkBaselineCoverage(baseline({ "PERF-001": 1 }), budgetConfig, [
      scenario("PERF-070"),
    ]);
    expect(gaps).toEqual([{ scenarioId: "PERF-070" }]);
  });

  it("does not flag a calibrating scenario absent from the baseline", () => {
    // A calibrating scenario inherits maxRegressionPct from defaultBudget but
    // has deliberately not been baselined yet, so its absence is expected.
    const calibratingConfig: PerfBudgetConfig = {
      ...budgetConfig,
      scenarios: { ...budgetConfig.scenarios, "PERF-070": { calibrating: true } },
    };
    const gaps = checkBaselineCoverage(baseline({ "PERF-001": 1 }), calibratingConfig, [
      scenario("PERF-070"),
    ]);
    expect(gaps).toEqual([]);
  });

  it("does not flag a scenario present in the baseline", () => {
    const gaps = checkBaselineCoverage(baseline({ "PERF-070": 900 }), budgetConfig, [
      scenario("PERF-070"),
    ]);
    expect(gaps).toEqual([]);
  });

  it("ignores critical scenarios (gate.ts owns those)", () => {
    const gaps = checkBaselineCoverage(baseline({}), budgetConfig, [scenario("PERF-001")]);
    expect(gaps).toEqual([]);
  });

  it("ignores scenarios without a regression budget", () => {
    const gaps = checkBaselineCoverage(baseline({}), noRegressionConfig, [scenario("PERF-200")]);
    expect(gaps).toEqual([]);
  });

  it("flags scenarios that fall back to the default regression budget", () => {
    // PERF-063 has no explicit budget entry but defaultBudget carries maxRegressionPct.
    const gaps = checkBaselineCoverage(baseline({}), budgetConfig, [scenario("PERF-063")]);
    expect(gaps).toEqual([{ scenarioId: "PERF-063" }]);
  });

  it("flags a non-finite baseline entry as a gap", () => {
    const gaps = checkBaselineCoverage(baseline({ "PERF-070": Number.NaN }), budgetConfig, [
      scenario("PERF-070"),
    ]);
    expect(gaps).toEqual([{ scenarioId: "PERF-070" }]);
  });

  it("returns no gaps when no baseline file is loaded", () => {
    const gaps = checkBaselineCoverage(null, budgetConfig, [scenario("PERF-070")]);
    expect(gaps).toEqual([]);
  });

  it("only reports scenarios scheduled for this run", () => {
    const gaps = checkBaselineCoverage(baseline({ "PERF-070": 900 }), budgetConfig, [
      scenario("PERF-070"),
    ]);
    // PERF-072 is missing from the baseline but is not in this run's scenario set.
    expect(gaps).toEqual([]);
  });
});
