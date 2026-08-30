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

describe("evaluateScenarioBudget — measurement issues vs reference drift", () => {
  it("reports a vanished metric as a measurement issue, NOT as outside reference", () => {
    // These are different claims. "Outside reference" means we measured
    // something and it was worse; a metric that stopped being emitted means we
    // measured nothing at all. Conflating them reports a disappeared
    // measurement as a mildly slow one — the reassuring reading, and the wrong
    // one. It also reads identically to a pass, which is why it is escalated.
    const result = evaluateScenarioBudget(
      makeParams({ budget: { maxMetricValues: { gitSpawns: 5 } }, metricAverages: {} })
    );

    expect(result.measurementIssues).toHaveLength(1);
    expect(result.measurementIssues[0]).toContain("gitSpawns");
    expect(result.outsideReference).toBe(false);
  });

  it("reports a metric over its reference as drift, with no measurement issue", () => {
    const result = evaluateScenarioBudget(
      makeParams({
        budget: { maxMetricValues: { gitSpawns: 5 } },
        metricAverages: { gitSpawns: 9 },
        baselineP95: 1,
      })
    );

    expect(result.outsideReference).toBe(true);
    expect(result.measurementIssues).toEqual([]);
  });

  it("treats a non-finite metric as a broken measurement, not a clean pass", () => {
    // NaN > max is false, so without an explicit branch this reads as success.
    const result = evaluateScenarioBudget(
      makeParams({
        budget: { maxMetricValues: { gitSpawns: 5 } },
        metricAverages: { gitSpawns: Number.NaN },
      })
    );

    expect(result.measurementIssues).toHaveLength(1);
    expect(result.measurementIssues[0]).toContain("non-finite");
  });

  it("carries a non-finite p95 as a measurement issue", () => {
    const result = evaluateScenarioBudget(makeParams({ p95Ms: Number.NaN }));
    expect(result.measurementIssues).toHaveLength(1);
  });

  it("leaves measurementIssues empty on an ordinary healthy scenario", () => {
    const result = evaluateScenarioBudget(makeParams({ p95Ms: 10, baselineP95: 10 }));
    expect(result.measurementIssues).toEqual([]);
  });
});

describe("evaluateScenarioBudget — absolute p95 budget", () => {
  it("fails when p95 exceeds the budget and passes at or under it", () => {
    const budget: ScenarioBudget = { p95Ms: 100 };
    const over = evaluateScenarioBudget(makeParams({ p95Ms: 101, budget, baselineP95: 50 }));
    const at = evaluateScenarioBudget(makeParams({ p95Ms: 100, budget, baselineP95: 50 }));

    expect(over.outsideReference).toBe(true);
    expect(at.outsideReference).toBe(false);
  });

  it("ignores the p95 budget when none is configured", () => {
    // No p95 budget and a flat baseline (no regression) → nothing to fail on.
    const result = evaluateScenarioBudget(
      makeParams({ p95Ms: 1e6, budget: { maxRegressionPct: 15 }, baselineP95: 1e6 })
    );
    expect(result.outsideReference).toBe(false);
  });
});

describe("evaluateScenarioBudget — non-finite measurements are apparatus defects", () => {
  // Behaviour deliberately changed: these used to report `outsideReference`,
  // which dressed a broken measurement up as a merely-slow one. A non-finite
  // value means nothing was measured, so it is now an escalated measurement
  // issue instead. The assertions are stronger, not weaker — each one also
  // pins that the defect is actually surfaced rather than silently swallowed.
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "raises a measurement issue when p95 is %p",
    (p95Ms) => {
      const result = evaluateScenarioBudget(
        makeParams({ p95Ms, budget: { p95Ms: 100 }, baselineP95: 50 })
      );
      expect(result.measurementIssues).toHaveLength(1);
      expect(result.outsideReference).toBe(false);
    }
  );

  it("raises a measurement issue for a non-finite metric that would slip past its ceiling", () => {
    // NaN > ceiling is false, so without an explicit branch this reads as a pass.
    const result = evaluateScenarioBudget(
      makeParams({
        budget: { p95Ms: 1000, maxMetricValues: { lag: 100 } },
        baselineP95: 50,
        metricAverages: { lag: Number.NaN },
      })
    );
    expect(result.measurementIssues).toHaveLength(1);
    expect(result.measurementIssues[0]).toContain("lag");
    expect(result.outsideReference).toBe(false);
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

    expect(fail.outsideReference).toBe(true);
    expect(fail.reasons.some((r) => r.includes("eventLoopLagMs"))).toBe(true);
    expect(fail.reasons.some((r) => r.includes("serializeMs"))).toBe(false);
    expect(pass.outsideReference).toBe(false);
  });

  it("escalates a configured metric that has no recorded average", () => {
    // `averageMetrics` includes any metric reported by at least ONE sample, so
    // an absent entry means no sample emitted it — a renamed or dropped metric
    // whose reference silently stopped meaning anything, not a sparse
    // measurement. Reported as a measurement issue rather than as drift: there
    // is no value to be outside a reference.
    const result = evaluateScenarioBudget(
      makeParams({
        budget: { p95Ms: 1000, maxMetricValues: { eventLoopLagMs: 1 } },
        baselineP95: 50,
        metricAverages: {},
      })
    );
    expect(result.measurementIssues).toHaveLength(1);
    expect(result.measurementIssues[0]).toContain("eventLoopLagMs");
    expect(result.outsideReference).toBe(false);
  });
});

describe("evaluateScenarioBudget — percentage gate above the noise floor", () => {
  const baselineP95 = MIN_REGRESSION_BASELINE_MS + 5;

  it("fails when the regression percentage exceeds the budget", () => {
    const budget: ScenarioBudget = { p95Ms: 10000, maxRegressionPct: 15 };
    const regressed = baselineP95 * 1.2; // +20% > 15%
    const result = evaluateScenarioBudget(makeParams({ p95Ms: regressed, budget, baselineP95 }));
    expect(result.outsideReference).toBe(true);
  });

  it("passes when the regression percentage is within the budget", () => {
    const budget: ScenarioBudget = { p95Ms: 10000, maxRegressionPct: 15 };
    const withinBudget = baselineP95 * 1.1; // +10% < 15%
    const result = evaluateScenarioBudget(makeParams({ p95Ms: withinBudget, budget, baselineP95 }));
    expect(result.outsideReference).toBe(false);
  });

  it("treats the regression gate as strict at the exact budget boundary", () => {
    const budget: ScenarioBudget = { p95Ms: 10000, maxRegressionPct: 15 };
    const atBoundary = baselineP95 * 1.15; // exactly +15%, strict > → passes
    const justOver = baselineP95 * 1.15 + baselineP95 * 0.0001; // marginally over → fails
    expect(
      evaluateScenarioBudget(makeParams({ p95Ms: atBoundary, budget, baselineP95 }))
        .outsideReference
    ).toBe(false);
    expect(
      evaluateScenarioBudget(makeParams({ p95Ms: justOver, budget, baselineP95 })).outsideReference
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
    expect(result.outsideReference).toBe(true);
  });

  it("does not fail a critical scenario whose absolute delta is within the floor", () => {
    const result = evaluateScenarioBudget(
      makeParams({
        p95Ms: baselineP95 + ABSOLUTE_REGRESSION_MS_FLOOR, // delta == floor, strict >
        baselineP95,
        isCritical: true,
      })
    );
    expect(result.outsideReference).toBe(false);
  });

  it("warns but does not block non-critical scenarios below the noise floor", () => {
    const result = evaluateScenarioBudget(
      makeParams({
        p95Ms: baselineP95 + ABSOLUTE_REGRESSION_MS_FLOOR + 10,
        baselineP95,
        isCritical: false,
      })
    );
    expect(result.outsideReference).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });
});

describe("evaluateScenarioBudget — Bug 2: baseline entry missing from a present file", () => {
  it("fails a critical scenario when its baseline entry is absent", () => {
    const result = evaluateScenarioBudget(
      makeParams({ baselineP95: undefined, isCritical: true, hasBaselineFile: true })
    );
    expect(result.outsideReference).toBe(true);
  });

  it("warns but does not block a non-critical scenario when its entry is absent", () => {
    const result = evaluateScenarioBudget(
      makeParams({ baselineP95: undefined, isCritical: false, hasBaselineFile: true })
    );
    expect(result.outsideReference).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("treats a non-finite baseline value as a missing entry for critical scenarios", () => {
    const result = evaluateScenarioBudget(
      makeParams({ baselineP95: Number.NaN, isCritical: true, hasBaselineFile: true })
    );
    expect(result.outsideReference).toBe(true);
  });
});

describe("evaluateScenarioBudget — Bug 3: no baseline file at all", () => {
  it("fails a critical scenario when no baseline file was loaded", () => {
    const result = evaluateScenarioBudget(
      makeParams({ baselineP95: undefined, isCritical: true, hasBaselineFile: false })
    );
    expect(result.outsideReference).toBe(true);
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
    expect(atFloor.outsideReference).toBe(false);
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
    expect(justOver.outsideReference).toBe(true);
    expect(exactly.outsideReference).toBe(false);
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
    expect(result.outsideReference).toBe(false);
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
    expect(result.outsideReference).toBe(true);
    expect(result.reasons.join(" ")).toContain("contradictory");
  });

  it("reports that calibration is complete once a baseline exists", () => {
    const result = evaluateScenarioBudget(
      makeParams({
        budget: { p95Ms: 1000, maxRegressionPct: 15, calibrating: true },
        baselineP95: 40,
      })
    );
    expect(result.outsideReference).toBe(false);
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
    expect(result.outsideReference).toBe(true);
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
    expect(evaluateScenarioBudget(regressed).outsideReference).toBe(true);
    expect(
      evaluateScenarioBudget({ ...regressed, budget: { ...budget, calibrating: true } })
        .outsideReference
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
    // Behaviour deliberately changed: a vanished metric is now an escalated
    // measurement issue rather than reference drift. Nothing was measured, so
    // nothing can be outside a reference.
    expect(result.measurementIssues).toHaveLength(1);
    expect(result.outsideReference).toBe(false);
    expect(result.reasons.join(" ")).toContain("not emitted");
  });

  it("passes when every configured metric is emitted and under its ceiling", () => {
    const result = evaluateScenarioBudget(
      makeParams({
        budget: { maxMetricValues: { a: 10, b: 20 } },
        metricAverages: { a: 9, b: 19 },
      })
    );
    expect(result.outsideReference).toBe(false);
  });

  it("still escalates a missing metric while calibrating", () => {
    // `calibrating` softens reference wording; it must never suppress the
    // report that a measurement disappeared entirely.
    const result = evaluateScenarioBudget(
      makeParams({
        budget: { maxMetricValues: { onlyMetric: 1 }, calibrating: true },
        metricAverages: {},
      })
    );
    expect(result.measurementIssues).toHaveLength(1);
  });
});
