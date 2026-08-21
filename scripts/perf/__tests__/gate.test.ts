import { describe, expect, it } from "vitest";
import {
  ABSOLUTE_REGRESSION_MS_FLOOR,
  MIN_REGRESSION_BASELINE_MS,
  evaluateScenarioBudget,
  type GateParams,
} from "../lib/gate";
import type { ScenarioBudget } from "../types";

function makeParams(overrides: Partial<GateParams> = {}): GateParams {
  return {
    scenarioId: "PERF-TEST",
    p95Ms: 1,
    metricAverages: {},
    budget: { p95Ms: 1000, maxRegressionPct: 15 },
    baselineP95: undefined,
    isCritical: false,
    hasBaselineFile: true,
    ...overrides,
  };
}

describe("evaluateScenarioBudget — absolute p95 budget", () => {
  it("fails when p95 exceeds the budget and passes at or under it", () => {
    const budget: ScenarioBudget = { p95Ms: 100 };
    const over = evaluateScenarioBudget(makeParams({ p95Ms: 101, budget, baselineP95: 50 }));
    const at = evaluateScenarioBudget(makeParams({ p95Ms: 100, budget, baselineP95: 50 }));

    expect(over.failedBudget).toBe(true);
    expect(at.failedBudget).toBe(false);
  });

  it("ignores the p95 budget when none is configured", () => {
    // No p95 budget and a flat baseline (no regression) → nothing to fail on.
    const result = evaluateScenarioBudget(
      makeParams({ p95Ms: 1e6, budget: { maxRegressionPct: 15 }, baselineP95: 1e6 })
    );
    expect(result.failedBudget).toBe(false);
  });
});

describe("evaluateScenarioBudget — non-finite measurements fail closed", () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "fails when p95 is %p",
    (p95Ms) => {
      const result = evaluateScenarioBudget(
        makeParams({ p95Ms, budget: { p95Ms: 100 }, baselineP95: 50 })
      );
      expect(result.failedBudget).toBe(true);
    }
  );

  it("fails a non-finite metric value that would otherwise slip past its ceiling", () => {
    const result = evaluateScenarioBudget(
      makeParams({
        budget: { p95Ms: 1000, maxMetricValues: { lag: 100 } },
        baselineP95: 50,
        metricAverages: { lag: Number.NaN },
      })
    );
    expect(result.failedBudget).toBe(true);
  });
});

describe("evaluateScenarioBudget — metric ceilings", () => {
  it("fails only the metric that exceeds its ceiling", () => {
    const budget: ScenarioBudget = {
      p95Ms: 1000,
      maxMetricValues: { eventLoopLagMs: 100, serializeMs: 5 },
    };
    const fail = evaluateScenarioBudget(
      makeParams({
        budget,
        baselineP95: 50,
        metricAverages: { eventLoopLagMs: 150, serializeMs: 4 },
      })
    );
    const pass = evaluateScenarioBudget(
      makeParams({
        budget,
        baselineP95: 50,
        metricAverages: { eventLoopLagMs: 99, serializeMs: 5 },
      })
    );

    expect(fail.failedBudget).toBe(true);
    expect(fail.reasons.some((r) => r.includes("eventLoopLagMs"))).toBe(true);
    expect(fail.reasons.some((r) => r.includes("serializeMs"))).toBe(false);
    expect(pass.failedBudget).toBe(false);
  });

  it("fails closed when a configured metric has no recorded average", () => {
    // Reversed from the original ignore-and-pass behaviour. `averageMetrics`
    // includes any metric reported by at least ONE sample, so an absent entry
    // means no sample emitted it at all — a renamed or dropped metric whose
    // ceiling has silently stopped gating, not a sparse measurement.
    const result = evaluateScenarioBudget(
      makeParams({
        budget: { p95Ms: 1000, maxMetricValues: { eventLoopLagMs: 1 } },
        baselineP95: 50,
        metricAverages: {},
      })
    );
    expect(result.failedBudget).toBe(true);
  });
});

describe("evaluateScenarioBudget — percentage gate above the noise floor", () => {
  const baselineP95 = MIN_REGRESSION_BASELINE_MS + 5;

  it("fails when the regression percentage exceeds the budget", () => {
    const budget: ScenarioBudget = { p95Ms: 10000, maxRegressionPct: 15 };
    const regressed = baselineP95 * 1.2; // +20% > 15%
    const result = evaluateScenarioBudget(makeParams({ p95Ms: regressed, budget, baselineP95 }));
    expect(result.failedBudget).toBe(true);
  });

  it("passes when the regression percentage is within the budget", () => {
    const budget: ScenarioBudget = { p95Ms: 10000, maxRegressionPct: 15 };
    const withinBudget = baselineP95 * 1.1; // +10% < 15%
    const result = evaluateScenarioBudget(makeParams({ p95Ms: withinBudget, budget, baselineP95 }));
    expect(result.failedBudget).toBe(false);
  });

  it("treats the regression gate as strict at the exact budget boundary", () => {
    const budget: ScenarioBudget = { p95Ms: 10000, maxRegressionPct: 15 };
    const atBoundary = baselineP95 * 1.15; // exactly +15%, strict > → passes
    const justOver = baselineP95 * 1.15 + baselineP95 * 0.0001; // marginally over → fails
    expect(
      evaluateScenarioBudget(makeParams({ p95Ms: atBoundary, budget, baselineP95 })).failedBudget
    ).toBe(false);
    expect(
      evaluateScenarioBudget(makeParams({ p95Ms: justOver, budget, baselineP95 })).failedBudget
    ).toBe(true);
  });
});

describe("evaluateScenarioBudget — Bug 1: sub-floor critical scenarios", () => {
  const baselineP95 = MIN_REGRESSION_BASELINE_MS - 1; // below the noise floor

  it("enforces critical scenarios via absolute delta when below the noise floor", () => {
    // A regression that is small in percentage terms above the floor would slip
    // through, but the absolute delta catches it.
    const result = evaluateScenarioBudget(
      makeParams({
        p95Ms: baselineP95 + ABSOLUTE_REGRESSION_MS_FLOOR + 0.5,
        baselineP95,
        isCritical: true,
      })
    );
    expect(result.failedBudget).toBe(true);
  });

  it("does not fail a critical scenario whose absolute delta is within the floor", () => {
    const result = evaluateScenarioBudget(
      makeParams({
        p95Ms: baselineP95 + ABSOLUTE_REGRESSION_MS_FLOOR, // delta == floor, strict >
        baselineP95,
        isCritical: true,
      })
    );
    expect(result.failedBudget).toBe(false);
  });

  it("warns but does not block non-critical scenarios below the noise floor", () => {
    const result = evaluateScenarioBudget(
      makeParams({
        p95Ms: baselineP95 + ABSOLUTE_REGRESSION_MS_FLOOR + 10,
        baselineP95,
        isCritical: false,
      })
    );
    expect(result.failedBudget).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });
});

describe("evaluateScenarioBudget — Bug 2: baseline entry missing from a present file", () => {
  it("fails a critical scenario when its baseline entry is absent", () => {
    const result = evaluateScenarioBudget(
      makeParams({ baselineP95: undefined, isCritical: true, hasBaselineFile: true })
    );
    expect(result.failedBudget).toBe(true);
  });

  it("warns but does not block a non-critical scenario when its entry is absent", () => {
    const result = evaluateScenarioBudget(
      makeParams({ baselineP95: undefined, isCritical: false, hasBaselineFile: true })
    );
    expect(result.failedBudget).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("treats a non-finite baseline value as a missing entry for critical scenarios", () => {
    const result = evaluateScenarioBudget(
      makeParams({ baselineP95: Number.NaN, isCritical: true, hasBaselineFile: true })
    );
    expect(result.failedBudget).toBe(true);
  });
});

describe("evaluateScenarioBudget — Bug 3: no baseline file at all", () => {
  it("fails a critical scenario when no baseline file was loaded", () => {
    const result = evaluateScenarioBudget(
      makeParams({ baselineP95: undefined, isCritical: true, hasBaselineFile: false })
    );
    expect(result.failedBudget).toBe(true);
  });

  it("distinguishes a missing file from a missing entry in its reason", () => {
    const noFile = evaluateScenarioBudget(
      makeParams({ baselineP95: undefined, isCritical: true, hasBaselineFile: false })
    );
    const noEntry = evaluateScenarioBudget(
      makeParams({ baselineP95: undefined, isCritical: true, hasBaselineFile: true })
    );
    expect(noFile.reasons.join()).not.toBe(noEntry.reasons.join());
  });
});

describe("evaluateScenarioBudget — thresholds are exported, not magic numbers", () => {
  it("uses MIN_REGRESSION_BASELINE_MS as the percentage/absolute boundary", () => {
    // Exactly at the floor → percentage gate (a +0% change passes).
    const atFloor = evaluateScenarioBudget(
      makeParams({
        p95Ms: MIN_REGRESSION_BASELINE_MS,
        baselineP95: MIN_REGRESSION_BASELINE_MS,
        isCritical: true,
      })
    );
    expect(atFloor.failedBudget).toBe(false);
  });

  it("the absolute-delta gate is strict (delta must exceed the floor)", () => {
    const baselineP95 = MIN_REGRESSION_BASELINE_MS - 2;
    const justOver = evaluateScenarioBudget(
      makeParams({
        p95Ms: baselineP95 + ABSOLUTE_REGRESSION_MS_FLOOR + 1e-6,
        baselineP95,
        isCritical: true,
      })
    );
    const exactly = evaluateScenarioBudget(
      makeParams({
        p95Ms: baselineP95 + ABSOLUTE_REGRESSION_MS_FLOOR,
        baselineP95,
        isCritical: true,
      })
    );
    expect(justOver.failedBudget).toBe(true);
    expect(exactly.failedBudget).toBe(false);
  });
});

describe("evaluateScenarioBudget — calibrating scenarios", () => {
  it("skips the regression gate without a baseline and says why", () => {
    const result = evaluateScenarioBudget(
      makeParams({
        budget: { p95Ms: 1000, maxRegressionPct: 15, calibrating: true },
        baselineP95: undefined,
      })
    );
    expect(result.failedBudget).toBe(false);
    expect(result.reasons).toContain("calibrating - regression gate not yet enabled");
    // The misleading missing-baseline reason must not also be reported.
    expect(result.reasons).not.toContain("baseline missing - regression gate skipped");
  });

  it("rejects the contradictory critical + calibrating combination", () => {
    const result = evaluateScenarioBudget(
      makeParams({
        budget: { p95Ms: 1000, maxRegressionPct: 15, calibrating: true },
        baselineP95: undefined,
        isCritical: true,
      })
    );
    expect(result.failedBudget).toBe(true);
    expect(result.reasons.join(" ")).toContain("contradictory");
  });

  it("reports that calibration is complete once a baseline exists", () => {
    const result = evaluateScenarioBudget(
      makeParams({
        budget: { p95Ms: 1000, maxRegressionPct: 15, calibrating: true },
        baselineP95: 40,
      })
    );
    expect(result.failedBudget).toBe(false);
    expect(result.reasons.join(" ")).toContain("remove `calibrating`");
  });

  it("still enforces the absolute p95 budget and metric ceilings", () => {
    const result = evaluateScenarioBudget(
      makeParams({
        budget: { p95Ms: 100, maxMetricValues: { p99KeystrokeMs: 4 }, calibrating: true },
        p95Ms: 250,
        metricAverages: { p99KeystrokeMs: 9 },
      })
    );
    expect(result.failedBudget).toBe(true);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining("p95"),
        expect.stringContaining("p99Keystroke"),
      ])
    );
  });

  it("suppresses a real regression that would otherwise fail", () => {
    const budget = { p95Ms: 1000, maxRegressionPct: 15 };
    const regressed = makeParams({ budget, p95Ms: 100, baselineP95: 50 });
    expect(evaluateScenarioBudget(regressed).failedBudget).toBe(true);
    expect(
      evaluateScenarioBudget({ ...regressed, budget: { ...budget, calibrating: true } })
        .failedBudget
    ).toBe(false);
  });
});

describe("evaluateScenarioBudget — metric-only budgets (no p95Ms)", () => {
  it("fails closed when a configured metric is not emitted", () => {
    // A renamed or dropped metric silently removes its gate otherwise, which is
    // the same silent-rot class as a missing baseline.
    const result = evaluateScenarioBudget(
      makeParams({
        budget: { maxMetricValues: { p99KeystrokeMs: 4 } },
        metricAverages: {},
      })
    );
    expect(result.failedBudget).toBe(true);
    expect(result.reasons.join(" ")).toContain("not emitted");
  });

  it("passes when every configured metric is emitted and under its ceiling", () => {
    const result = evaluateScenarioBudget(
      makeParams({
        budget: { maxMetricValues: { a: 10, b: 20 } },
        metricAverages: { a: 9, b: 19 },
      })
    );
    expect(result.failedBudget).toBe(false);
  });

  it("still fails closed for a missing metric while calibrating", () => {
    const result = evaluateScenarioBudget(
      makeParams({
        budget: { maxMetricValues: { onlyMetric: 1 }, calibrating: true },
        metricAverages: {},
      })
    );
    expect(result.failedBudget).toBe(true);
  });
});
