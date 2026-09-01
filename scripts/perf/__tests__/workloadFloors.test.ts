import { describe, expect, it } from "vitest";
import { evaluateWorkload } from "../lib/gate";
import { aggregateMetrics } from "../lib/stats";
import { allScenarios } from "../scenarios";

/**
 * Does the workload floor react, and does it catch what the predicates cannot?
 *
 * The failure it exists for is the most flattering wrong number the suite can
 * produce: a scenario that asked for twelve background terminals and started
 * nine measures a lighter workload than it claims and reports a BETTER latency
 * for it, with every correctness predicate at zero because the nine that did
 * start behaved perfectly. Nothing else in the harness sees that.
 */

function statsFor(samples: Array<Record<string, number>>) {
  return aggregateMetrics(samples);
}

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
      "PERF-395",
    ]);
    for (const scenario of declaring) {
      for (const [metric, floor] of Object.entries(scenario.workloadFloors!)) {
        expect(Number.isFinite(floor), `${scenario.id}.${metric} floor must be finite`).toBe(true);
        expect(floor, `${scenario.id}.${metric} floor must be positive`).toBeGreaterThan(0);
      }
    }
  });
});
