import { describe, expect, it } from "vitest";
import { evaluateCorrectness, evaluateScenarioBudget } from "../lib/gate";
import { aggregateMetrics } from "../lib/stats";

/**
 * Stats built from per-iteration samples the way run.ts builds them. An
 * iteration that did not emit a metric simply omits the key, which is the exact
 * shape the partial-emission check exists to catch.
 */
function statsFor(samples: Array<Record<string, number>>) {
  return aggregateMetrics(samples);
}

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

  it("leaves a scenario reporting no count-class metric alone", () => {
    // Classification is `classifyMetric`'s job, not a name match here: a
    // duration falling to zero is visible as a duration.
    const issues = evaluateCorrectness({
      correctness: undefined,
      metricStats: statsFor([{ applyMs: 4, heapDeltaMb: 2, msPerKFile: 0.3 }]),
      runs: 1,
    });
    expect(issues).toEqual([]);
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
  it("returns strings only, and carries no flag a caller could exit on", () => {
    const issues = evaluateCorrectness({
      correctness: ["refreshMisses"],
      metricStats: statsFor([{ refreshMisses: 9 }]),
      runs: 1,
    });
    expect(Array.isArray(issues)).toBe(true);
    expect(issues.every((issue) => typeof issue === "string")).toBe(true);
  });

  it("leaves outsideReference alone — a broken predicate is not a slow number", () => {
    // `outsideReference` feeds the report's "outside a reference value" list.
    // A correctness failure says the numbers mean nothing, which is a different
    // and louder statement, so it must not land there.
    const metricStats = statsFor([{ refreshMisses: 9 }]);
    const { outsideReference } = evaluateScenarioBudget({
      scenarioId: "PERF-000",
      p95Ms: 1,
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
