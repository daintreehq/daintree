import { describe, expect, it } from "vitest";
import {
  ABSOLUTE_REGRESSION_MS_FLOOR,
  MIN_REGRESSION_BASELINE_MS,
  evaluateScenarioBudget,
  type GateParams,
} from "../lib/gate";
import { aggregateMetrics } from "../lib/stats";
import type { MetricStat, ScenarioBudget } from "../types";

/**
 * Metric stats built the way run.ts builds them — from per-iteration samples —
 * so these tests exercise the real shape rather than a hand-written stat.
 */
function statsFor(samples: Array<Record<string, number>>): Record<string, MetricStat> {
  return aggregateMetrics(samples);
}

/**
 * Derived from the stats rather than fixed at 1, so a fixture built from three
 * samples is COMPLETE by default and the partial-emission check stays out of
 * the way of every case that is about something else. A test that wants to
 * exercise partiality passes `runs` explicitly.
 */
function completeRuns(metricStats: Record<string, MetricStat>): number {
  const counts = Object.values(metricStats).map((stat) => stat.count);
  return counts.length > 0 ? Math.max(...counts) : 1;
}

function makeParams(overrides: Partial<GateParams> = {}): GateParams {
  const metricStats = overrides.metricStats ?? {};
  return {
    scenarioId: "PERF-TEST",
    p95Ms: 1,
    runs: completeRuns(metricStats),
    metricStats: {},
    budget: { p95Ms: 1000, maxRegressionPct: 15 },
    baselineP95: undefined,
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
      makeParams({ budget: { maxMetricValues: { gitSpawns: 5 } }, metricStats: {} })
    );

    expect(result.measurementIssues).toHaveLength(1);
    expect(result.measurementIssues[0]).toContain("gitSpawns");
    expect(result.outsideReference).toBe(false);
  });

  it("reports a metric over its reference as drift, with no measurement issue", () => {
    const result = evaluateScenarioBudget(
      makeParams({
        budget: { maxMetricValues: { gitSpawns: 5 } },
        metricStats: statsFor([{ gitSpawns: 9 }]),
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
        metricStats: statsFor([{ gitSpawns: Number.NaN }]),
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
        metricStats: statsFor([{ lag: Number.NaN }]),
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
        metricStats: statsFor([{ eventLoopLagMs: 150, serializeMs: 4 }]),
      })
    );
    const pass = evaluateScenarioBudget(
      makeParams({
        budget,
        baselineP95: 50,
        metricStats: statsFor([{ eventLoopLagMs: 99, serializeMs: 5 }]),
      })
    );

    expect(fail.outsideReference).toBe(true);
    expect(fail.reasons.some((r) => r.includes("eventLoopLagMs"))).toBe(true);
    expect(fail.reasons.some((r) => r.includes("serializeMs"))).toBe(false);
    expect(pass.outsideReference).toBe(false);
  });

  it("escalates a configured metric that was never recorded", () => {
    // `aggregateMetrics` includes any metric reported by at least ONE sample,
    // so an absent entry means no sample emitted it — a renamed or dropped
    // metric whose reference silently stopped meaning anything, not a sparse
    // measurement. Reported as a measurement issue rather than as drift: there
    // is no value to be outside a reference.
    const result = evaluateScenarioBudget(
      makeParams({
        budget: { p95Ms: 1000, maxMetricValues: { eventLoopLagMs: 1 } },
        baselineP95: 50,
        metricStats: {},
      })
    );
    expect(result.measurementIssues).toHaveLength(1);
    expect(result.measurementIssues[0]).toContain("eventLoopLagMs");
    expect(result.outsideReference).toBe(false);
  });

  it("compares the ceiling against the metric MAX, not its mean", () => {
    // The bug this gate exists to catch: one iteration spawning 20 processes
    // among fifteen quiet ones. Averaged, that is 1.25 and slides under a
    // ceiling of 1.5 — the storm reported as "about one spawn".
    const spiky = [{ gitSpawns: 20 }, ...Array.from({ length: 15 }, () => ({ gitSpawns: 0 }))];
    const stats = statsFor(spiky);
    expect(stats.gitSpawns.mean).toBeLessThan(1.5);

    const result = evaluateScenarioBudget(
      makeParams({
        budget: { maxMetricValues: { gitSpawns: 1.5 } },
        metricStats: stats,
        baselineP95: 50,
      })
    );
    expect(result.outsideReference).toBe(true);
    expect(result.reasons.join(" ")).toContain("max 20");
  });

  it("reports mean and sum alongside the max that tripped the ceiling", () => {
    const result = evaluateScenarioBudget(
      makeParams({
        budget: { maxMetricValues: { gitSpawns: 1 } },
        metricStats: statsFor([{ gitSpawns: 4 }, { gitSpawns: 2 }]),
        baselineP95: 50,
      })
    );
    const reason = result.reasons.join(" ");
    expect(reason).toContain("max 4");
    expect(reason).toContain("mean 3");
    expect(reason).toContain("sum 6");
  });

  it("passes a metric whose every iteration sits under the ceiling", () => {
    const result = evaluateScenarioBudget(
      makeParams({
        budget: { maxMetricValues: { gitSpawns: 5 } },
        metricStats: statsFor([{ gitSpawns: 5 }, { gitSpawns: 1 }, { gitSpawns: 4 }]),
        baselineP95: 50,
      })
    );
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
      })
    );
    expect(result.outsideReference).toBe(true);
  });

  it("does not fail a critical scenario whose absolute delta is within the floor", () => {
    const result = evaluateScenarioBudget(
      makeParams({
        p95Ms: baselineP95 + ABSOLUTE_REGRESSION_MS_FLOOR, // delta == floor, strict >
        baselineP95,
      })
    );
    expect(result.outsideReference).toBe(false);
  });

  it("flags a sub-floor delta past the absolute floor", () => {
    // Behaviour deliberately changed. This branch used to annotate only the
    // scenarios listed in `criticalScenarios` and stay silent for everything
    // else, which left about a third of the suite reporting no number at all.
    // That list decided who could be BLOCKED, and nothing blocks any more — so
    // it no longer decides who gets MEASURED, and it has been removed outright.
    // A +3ms move on a sub-millisecond baseline is a multiple-x change and is
    // exactly what someone optimising needs to see.
    const result = evaluateScenarioBudget(
      makeParams({ p95Ms: baselineP95 + ABSOLUTE_REGRESSION_MS_FLOOR + 10, baselineP95 })
    );

    expect(result.outsideReference).toBe(true);
    expect(result.reasons.join()).toContain("noise floor");
  });

  it("reports the absolute delta even when it is within the floor", () => {
    // The silent case is the one that used to report nothing. A number that has
    // not moved much is still a number worth printing.
    const result = evaluateScenarioBudget(makeParams({ p95Ms: baselineP95 + 0.2, baselineP95 }));
    expect(result.outsideReference).toBe(false);
    expect(result.reasons.join()).toContain("sub-noise-floor");
  });
});

describe("evaluateScenarioBudget — a baseline entry missing from a present file", () => {
  // Behaviour deliberately changed throughout this block. A missing baseline
  // used to set `outsideReference` for a scenario listed in
  // `criticalScenarios` ("failing closed"). It no longer does, for any
  // scenario — and that list no longer exists: an absent reference is an
  // absent COMPARISON, not a measurement that came back worse. Reporting it as
  // drift would invent a regression out of a scenario nobody has ever
  // baselined, which is the normal state on a machine or OS being measured for
  // the first time — the case this whole change exists to make easy.
  it("does not report a missing entry as drift", () => {
    const result = evaluateScenarioBudget(
      makeParams({ baselineP95: undefined, hasBaselineFile: true })
    );

    expect(result.outsideReference).toBe(false);
    // Still says something — silence would be indistinguishable from a match.
    expect(result.reasons.join()).toContain("no recorded baseline");
  });

  it("treats a non-finite baseline value the same as a missing entry", () => {
    const result = evaluateScenarioBudget(
      makeParams({ baselineP95: Number.NaN, hasBaselineFile: true })
    );
    expect(result.outsideReference).toBe(false);
    expect(result.reasons.join()).toContain("no recorded baseline");
  });
});

describe("evaluateScenarioBudget — no baseline file at all", () => {
  it("does not report an absent baseline file as drift", () => {
    const result = evaluateScenarioBudget(
      makeParams({ baselineP95: undefined, hasBaselineFile: false })
    );
    expect(result.outsideReference).toBe(false);
    expect(result.reasons.join()).toContain("no baseline file");
  });

  it("distinguishes a missing file from a missing entry in its reason", () => {
    const noFile = evaluateScenarioBudget(
      makeParams({ baselineP95: undefined, hasBaselineFile: false })
    );
    const noEntry = evaluateScenarioBudget(
      makeParams({ baselineP95: undefined, hasBaselineFile: true })
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
      })
    );
    const exactly = evaluateScenarioBudget(
      makeParams({
        p95Ms: baselineP95 + ABSOLUTE_REGRESSION_MS_FLOOR,
        baselineP95,
      })
    );
    expect(justOver.outsideReference).toBe(true);
    expect(exactly.outsideReference).toBe(false);
  });
});

describe("evaluateScenarioBudget — a scenario with no reference value yet", () => {
  it("reports the absent baseline and enforces the ceilings it does have", () => {
    // The state every new scenario starts in, and every scenario on a newly
    // added OS. It is a note, not drift: the absolute p95 budget and the metric
    // ceilings still apply, and only the regression gate is skipped.
    const result = evaluateScenarioBudget(
      makeParams({
        budget: { p95Ms: 100, maxRegressionPct: 15, maxMetricValues: { p99KeystrokeMs: 4 } },
        p95Ms: 250,
        metricStats: statsFor([{ p99KeystrokeMs: 9 }]),
        baselineP95: undefined,
      })
    );
    expect(result.outsideReference).toBe(true);
    expect(result.reasons).toContain("no recorded baseline for this scenario");
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining("p95"),
        expect.stringContaining("p99Keystroke"),
      ])
    );
  });
});

describe("evaluateScenarioBudget — metric-only budgets (no p95Ms)", () => {
  it("fails closed when a configured metric is not emitted", () => {
    // A renamed or dropped metric silently removes its gate otherwise, which is
    // the same silent-rot class as a missing baseline.
    const result = evaluateScenarioBudget(
      makeParams({
        budget: { maxMetricValues: { p99KeystrokeMs: 4 } },
        metricStats: {},
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
        metricStats: statsFor([{ a: 9, b: 19 }]),
      })
    );
    expect(result.outsideReference).toBe(false);
  });

  it("escalates one vanished metric while another is still measured", () => {
    // The dangerous shape: the scenario still reports numbers, so every row
    // reads healthy while one ceiling has quietly stopped meaning anything.
    const result = evaluateScenarioBudget(
      makeParams({
        budget: { maxMetricValues: { stillHere: 10, renamedAway: 1 } },
        metricStats: statsFor([{ stillHere: 2 }]),
      })
    );
    expect(result.measurementIssues).toHaveLength(1);
    expect(result.measurementIssues[0]).toContain("renamedAway");
    expect(result.outsideReference).toBe(false);
  });
});

describe("evaluateScenarioBudget — a configured metric emitted on only some iterations", () => {
  /**
   * `MetricStat.count` tallies the iterations that emitted a metric, not the
   * run count. A ceiling checked against one sample out of sixteen is a ceiling
   * with fifteen blind iterations behind it, and it passes — looking exactly
   * like a clean result. Correctness predicates have always been checked this
   * way; configured metrics were not, which left the louder case enforced and
   * this one open.
   */
  it("reports a partial emission as a measurement issue, not a pass", () => {
    const metricStats = statsFor([{ gitSpawns: 2 }, {}, {}]);
    const result = evaluateScenarioBudget(
      makeParams({
        runs: 3,
        metricStats,
        budget: { maxMetricValues: { gitSpawns: 10 } },
      })
    );

    expect(result.measurementIssues).toHaveLength(1);
    expect(result.measurementIssues[0]).toContain("emitted on 1 of 3");
    // A broken measurement, not a slow one — same rule as a vanished metric.
    expect(result.outsideReference).toBe(false);
  });

  it("does not re-report the ceiling for a metric it already called partial", () => {
    // The ceiling comparison is skipped once the emission is known partial:
    // reporting both would say the number is too high AND that there is no
    // trustworthy number, and only the second is true.
    const result = evaluateScenarioBudget(
      makeParams({
        runs: 4,
        metricStats: statsFor([{ gitSpawns: 900 }, {}, {}, {}]),
        budget: { maxMetricValues: { gitSpawns: 10 } },
      })
    );
    expect(result.outsideReference).toBe(false);
    expect(result.reasons.join(" ")).not.toContain("> reference 10");
  });

  it("passes a metric emitted on every iteration", () => {
    const result = evaluateScenarioBudget(
      makeParams({
        runs: 3,
        metricStats: statsFor([{ gitSpawns: 1 }, { gitSpawns: 2 }, { gitSpawns: 1 }]),
        budget: { maxMetricValues: { gitSpawns: 10 } },
      })
    );
    expect(result.measurementIssues).toEqual([]);
  });

  it("says nothing about emission when there is no run count to compare against", () => {
    // `runs: 0` means the caller did not supply one; the check is skipped
    // rather than reporting every metric as partial against a zero denominator.
    const result = evaluateScenarioBudget(
      makeParams({
        runs: 0,
        metricStats: statsFor([{ gitSpawns: 1 }]),
        budget: { maxMetricValues: { gitSpawns: 10 } },
      })
    );
    expect(result.measurementIssues).toEqual([]);
  });
});
