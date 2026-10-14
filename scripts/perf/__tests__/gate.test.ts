import { describe, expect, it } from "vitest";
import {
  ABSOLUTE_REGRESSION_MS_FLOOR,
  MIN_REGRESSION_BASELINE_MS,
  evaluateCorrectness,
  evaluateScenarioBudget,
  evaluateWorkload,
  type GateParams,
} from "../lib/gate";
import { aggregateMetrics } from "../lib/stats";
import { allScenarios } from "../scenarios";
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
});

describe("evaluateScenarioBudget — thresholds are exported, not magic numbers", () => {
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

describe("evaluateCorrectness — a declared predicate", () => {
  it("says nothing when the predicate is emitted every iteration and reports no misses", () => {
    const issues = evaluateCorrectness({
      correctness: ["refreshMisses"],
      metricStats: statsFor([{ refreshMisses: 0 }, { refreshMisses: 0 }, { refreshMisses: 0 }]),
      runs: 3,
    });
    expect(issues).toEqual([]);
  });

  it("flags a predicate that was never emitted at all", () => {
    // The scenario that silently stopped running: it reports no misses because
    // it reports nothing, which is the most reassuring possible output.
    const issues = evaluateCorrectness({
      correctness: ["refreshMisses"],
      metricStats: statsFor([{ gitSpawns: 0 }, { gitSpawns: 0 }]),
      runs: 2,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("refreshMisses");
    expect(issues[0]).toContain("never emitted");
  });

  it("flags a predicate present on only some iterations, which aggregates to a clean max of 0", () => {
    const samples: Array<Record<string, number>> = [{ refreshMisses: 0 }, {}, {}, {}];
    const stats = statsFor(samples);

    // The trap in one assertion: fifteen blind iterations and one healthy
    // sample summarise identically to a fully healthy run.
    expect(stats.refreshMisses.max).toBe(0);
    expect(stats.refreshMisses.count).toBe(1);

    const issues = evaluateCorrectness({
      correctness: ["refreshMisses"],
      metricStats: stats,
      runs: samples.length,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("1 of 4");
  });

  it("flags a non-zero predicate, because the subject misbehaved while being measured", () => {
    const issues = evaluateCorrectness({
      correctness: ["refreshMisses"],
      metricStats: statsFor([{ refreshMisses: 0 }, { refreshMisses: 3 }]),
      runs: 2,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("reported misses");
    expect(issues[0]).toContain("max 3");
    expect(issues[0]).toContain("suspect");
  });

  it("flags a negative predicate, which a max-only test lets through", () => {
    // Several predicates are signed subtractions — PERF-057's `written -
    // persisted` — where a negative means the subject produced MORE than it was
    // asked to. `max > 0` reads that as healthy.
    const issues = evaluateCorrectness({
      correctness: ["writeMisses"],
      metricStats: statsFor([{ writeMisses: -1 }, { writeMisses: -2 }]),
      runs: 2,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("reported misses");
    expect(issues[0]).toContain("min -2");
  });

  it("flags a mixed run whose max is zero", () => {
    // The trap in its purest form: max is 0, count equals runs, and the
    // scenario still misbehaved on half its iterations.
    const stats = statsFor([{ writeMisses: -1 }, { writeMisses: 0 }]);
    expect(stats.writeMisses.max).toBe(0);
    expect(stats.writeMisses.count).toBe(2);

    const issues = evaluateCorrectness({
      correctness: ["writeMisses"],
      metricStats: stats,
      runs: 2,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("reported misses");
  });

  it("reports both faults when a predicate is partial AND non-zero", () => {
    const issues = evaluateCorrectness({
      correctness: ["refreshMisses"],
      metricStats: statsFor([{ refreshMisses: 2 }, {}, {}]),
      runs: 3,
    });
    expect(issues).toHaveLength(2);
    expect(issues.join(" ")).toContain("1 of 3");
    expect(issues.join(" ")).toContain("reported misses");
  });

  it("flags a non-finite predicate, which would otherwise read as healthy", () => {
    // NaN > 0 is false, so without an explicit branch a poisoned predicate is
    // indistinguishable from a passing one.
    const issues = evaluateCorrectness({
      correctness: ["refreshMisses"],
      metricStats: { refreshMisses: { mean: NaN, max: NaN, min: NaN, sum: NaN, count: 2 } },
      runs: 2,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("non-finite");
  });

  it("checks every declared key, not just the first", () => {
    const issues = evaluateCorrectness({
      correctness: ["refreshMisses", "detectionMisses"],
      metricStats: statsFor([{ refreshMisses: 0 }]),
      runs: 1,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("detectionMisses");
  });
});

describe("evaluateCorrectness — an undeclared predicate", () => {
  it("flags a scenario reporting a count-class metric with no predicate at all", () => {
    const issues = evaluateCorrectness({
      correctness: undefined,
      metricStats: statsFor([{ gitSpawns: 0, worktreeListSpawns: 0 }]),
      runs: 1,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("gitSpawns");
    expect(issues[0]).toContain("worktreeListSpawns");
    expect(issues[0]).toContain("no correctness predicate");
  });

  it("treats an empty declaration the same as an absent one", () => {
    expect(
      evaluateCorrectness({
        correctness: [],
        metricStats: statsFor([{ gitSpawns: 0 }]),
        runs: 1,
      })
    ).toHaveLength(1);
  });

  it("reports a duration-only scenario that declares nothing", () => {
    // This used to pass silently, on the reasoning that a duration falling to
    // zero is visible as a duration and so needs no predicate. The reasoning is
    // sound about DURATIONS and wrong about the situation: every scenario in the
    // matrix declares a predicate and `scenarioMatrix.test.ts`'s exemption list
    // is empty, so an absent declaration reaching here is one that was removed —
    // and removing it is the cheapest way to make a failing predicate stop
    // failing. With both the declaration and its emission gone, the old rule
    // produced no issue at all and `--enforce-integrity` did not uphold what it
    // documents.
    const issues = evaluateCorrectness({
      correctness: undefined,
      metricStats: statsFor([{ applyMs: 4, heapDeltaMb: 2, msPerKFile: 0.3 }]),
      runs: 1,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("declares no correctness predicate");
    // No count-class metric survived, so the message must not claim one did.
    expect(issues[0]).not.toContain("count-class");
  });

  it("still names the surviving counts when there are any", () => {
    // Classification stays `classifyMetric`'s job rather than a name match here.
    const issues = evaluateCorrectness({
      correctness: undefined,
      metricStats: statsFor([{ applyMs: 4, gitSpawns: 0, refreshCount: 2 }]),
      runs: 1,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("gitSpawns");
    expect(issues[0]).toContain("refreshCount");
    expect(issues[0]).not.toContain("applyMs");
  });

  it("does not double-report on a scenario that declares a predicate", () => {
    const issues = evaluateCorrectness({
      correctness: ["refreshMisses"],
      metricStats: statsFor([{ refreshMisses: 0, gitSpawns: 0 }]),
      runs: 1,
    });
    expect(issues).toEqual([]);
  });
});

describe("evaluateCorrectness — never a gate", () => {
  it("leaves outsideReference alone — a broken predicate is not a slow number", () => {
    // `outsideReference` feeds the report's "outside a reference value" list.
    // A correctness failure says the numbers mean nothing, which is a different
    // and louder statement, so it must not land there.
    const metricStats = statsFor([{ refreshMisses: 9 }]);
    const { outsideReference } = evaluateScenarioBudget({
      scenarioId: "PERF-000",
      p95Ms: 1,
      runs: 1,
      metricStats,
      budget: {},
      baselineP95: 1,
      hasBaselineFile: true,
    });
    expect(outsideReference).toBe(false);
    expect(
      evaluateCorrectness({ correctness: ["refreshMisses"], metricStats, runs: 1 })
    ).not.toEqual([]);
  });
});

/**
 * Does the workload floor react, and does it catch what the predicates cannot?
 *
 * The failure it exists for is the most flattering wrong number the suite can
 * produce: a scenario that asked for twelve background terminals and started
 * nine measures a lighter workload than it claims and reports a BETTER latency
 * for it, with every correctness predicate at zero because the nine that did
 * start behaved perfectly. Nothing else in the harness sees that.
 */

describe("workload floors", () => {
  it("says nothing when a scenario declares none", () => {
    expect(
      evaluateWorkload({ floors: undefined, metricStats: statsFor([{ floodBytes: 1 }]), runs: 1 })
    ).toEqual([]);
  });

  it("passes a workload that met its floor on every iteration", () => {
    expect(
      evaluateWorkload({
        floors: { floodBytes: 500_000 },
        metricStats: statsFor([{ floodBytes: 640_000 }, { floodBytes: 610_000 }]),
        runs: 2,
      })
    ).toEqual([]);
  });

  it("catches a fixture that quietly built less than it claims", () => {
    const issues = evaluateWorkload({
      floors: { floodBytes: 500_000 },
      metricStats: statsFor([{ floodBytes: 640_000 }, { floodBytes: 61_000 }]),
      runs: 2,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("workload shortfall");
    expect(issues[0]).toContain("floodBytes");
  });

  it("reads the minimum, not the mean", () => {
    // The whole reason it is `min`: one starved iteration among healthy ones
    // averages away, and that iteration is in the aggregate the run reports.
    const samples = [
      { floodBytes: 900_000 },
      { floodBytes: 900_000 },
      { floodBytes: 900_000 },
      { floodBytes: 10_000 },
    ];
    const stats = statsFor(samples);
    expect(stats.floodBytes!.mean).toBeGreaterThan(500_000);
    expect(
      evaluateWorkload({ floors: { floodBytes: 500_000 }, metricStats: stats, runs: 4 })
    ).toHaveLength(1);
  });

  it("catches a floor naming a metric the scenario never emits", () => {
    // A broken declaration, and it reads as a clean pass without this: an
    // absent metric compares against nothing.
    const issues = evaluateWorkload({
      floors: { terminalsStarted: 12 },
      metricStats: statsFor([{ floodBytes: 900_000 }]),
      runs: 1,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("never emitted");
  });

  it("catches a workload metric emitted on only some iterations", () => {
    // Same rule as a correctness predicate: the blind iterations are the ones
    // that matter, and `min` over one sample says nothing about the other two.
    const issues = evaluateWorkload({
      floors: { floodBytes: 500_000 },
      metricStats: statsFor([{ floodBytes: 900_000 }, {}, {}]),
      runs: 3,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("emitted on 1 of 3");
  });

  it("catches a floor that is not a finite number", () => {
    // A NaN floor makes `min < floor` false, so the declaration reads as
    // satisfied while checking nothing. Same quiet shape as a predicate that
    // stopped being emitted.
    for (const floor of [NaN, Infinity]) {
      const issues = evaluateWorkload({
        floors: { floodBytes: floor },
        metricStats: statsFor([{ floodBytes: 1 }]),
        runs: 1,
      });
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain("not a finite number");
    }
  });

  it("catches a non-finite workload reading", () => {
    expect(
      evaluateWorkload({
        floors: { floodBytes: 1 },
        metricStats: { floodBytes: { mean: NaN, max: NaN, min: NaN, sum: NaN, count: 1 } },
        runs: 1,
      })[0]
    ).toContain("non-finite");
  });

  it("declares floors only on metrics the scenario actually emits", async () => {
    // The declaration and the emission live in different places, so a rename
    // silently disconnects them. `scenarioLiveness` proves this per scenario by
    // running it; this is the cheap structural half, and it names the scenarios
    // that carry a floor so the list cannot quietly empty itself.
    const declaring = allScenarios.filter((scenario) => scenario.workloadFloors);
    expect(declaring.map((scenario) => scenario.id).sort()).toEqual([
      "PERF-034",
      "PERF-036",
      "PERF-163",
      "PERF-164",
      "PERF-247",
      "PERF-395",
      "PERF-406",
      "PERF-407",
      "PERF-408",
    ]);
    for (const scenario of declaring) {
      for (const [metric, floor] of Object.entries(scenario.workloadFloors!)) {
        expect(Number.isFinite(floor), `${scenario.id}.${metric} floor must be finite`).toBe(true);
        expect(floor, `${scenario.id}.${metric} floor must be positive`).toBeGreaterThan(0);
      }
    }
  });
});
