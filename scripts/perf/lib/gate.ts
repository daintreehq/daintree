import { classifyMetric } from "./comparability";
import { round } from "./stats";
import type { MetricStat, ScenarioBudget } from "../types";

/**
 * Baselines at or above this p95 (in ms) get a percentage-drift note. Below it,
 * percentage math is unstable — a fraction of a millisecond of scheduler noise
 * dwarfs the signal — so the report shows an absolute delta instead.
 */
export const MIN_REGRESSION_BASELINE_MS = 5;

/**
 * Absolute p95 increase (in ms) worth flagging on a scenario whose baseline
 * sits below {@link MIN_REGRESSION_BASELINE_MS}.
 *
 * The original 1ms was calibrated against jitter of ~0.3–0.8ms, but that
 * understated PERF-001, which measures 1.096–2.932ms across ubuntu-22.04 runs
 * — a spread wider than the tolerance itself. Whether the gate passed then
 * depended on where in that band the baseline happened to be captured (the
 * 2026-02-11 baseline caught its high end at 2.932ms and always passed; a
 * regenerated 1.36ms caught the low end and failed on the next run), which
 * makes it a coin flip rather than a signal.
 *
 * 3ms is ~2x the widest observed delta. Most sub-floor scenarios sit between
 * 0.3ms and 0.7ms, so a real regression in one is an order-of-magnitude blowup
 * and still trips this comfortably.
 */
export const ABSOLUTE_REGRESSION_MS_FLOOR = 3;

export interface GateParams {
  scenarioId: string;
  p95Ms: number;
  /**
   * Full per-metric spread, not the mean. A ceiling read against the mean is
   * not a ceiling: 20 spawns in one iteration among fifteen quiet ones averages
   * to 1.25 and slides under a limit of 1.5, which is precisely the storm the
   * limit exists to catch.
   */
  metricStats: Record<string, MetricStat>;
  budget: ScenarioBudget;
  /** Baseline p95 for this scenario, or undefined when absent/non-finite. */
  baselineP95: number | undefined;
  /** Whether a baseline file was loaded at all (distinct from a missing entry). */
  hasBaselineFile: boolean;
}

export interface GateResult {
  /**
   * A measured number sits outside its reference value. Informational — callers
   * must not turn this into a non-zero exit code.
   */
  outsideReference: boolean;
  /**
   * The measurement itself is untrustworthy: a non-finite p95, or a metric with
   * a configured reference that stopped being emitted. Kept separate from
   * `outsideReference` because these say "this number means nothing" rather than
   * "this number is worse", and they are the only outputs worth escalating.
   */
  measurementIssues: string[];
  reasons: string[];
}

/**
 * Pure per-scenario evaluation against configured reference values: the p95
 * reference, metric ceilings, and drift from the recorded baseline.
 *
 * Nothing here gates. Every branch produces an annotation for the report, and
 * no caller may turn one into an exit code. Only `measurementIssues` says
 * something is actually wrong — and it says the apparatus is broken, not that
 * the code is slow.
 */
export function evaluateScenarioBudget(params: GateParams): GateResult {
  const { p95Ms, metricStats, budget, baselineP95, hasBaselineFile } = params;

  let outsideReference = false;
  const reasons: string[] = [];
  const measurementIssues: string[] = [];

  // A non-finite measurement (NaN/Infinity) means the scenario is broken. NaN
  // comparisons are always false in JS, so every check below would read as a
  // clean result — the most reassuring possible output for a broken scenario.
  if (!Number.isFinite(p95Ms)) {
    // A broken measurement, not a slow one. `outsideReference` stays false for
    // the same reason a vanished metric does: there is no measured value to be
    // outside anything, and reporting one would dress a defect up as drift.
    return {
      outsideReference: false,
      measurementIssues: [`non-finite p95 measurement (${p95Ms})`],
      reasons: [`non-finite p95 measurement (${p95Ms})`],
    };
  }

  if (budget.p95Ms !== undefined && p95Ms > budget.p95Ms) {
    outsideReference = true;
    reasons.push(`p95 ${round(p95Ms)}ms > reference ${budget.p95Ms}ms`);
  }

  if (budget.maxMetricValues) {
    for (const [metricName, maxValue] of Object.entries(budget.maxMetricValues)) {
      const stat = metricStats[metricName];
      // A configured reference whose metric is no longer emitted is a
      // measurement that has silently disappeared, and it reads exactly like a
      // healthy one. Renaming a metric must rename it in budgets.json too.
      if (stat === undefined) {
        // NOT `outsideReference`: there is no measured value, so nothing is
        // outside anything. Conflating the two would report a vanished
        // measurement as a mildly-slow one, which is the more reassuring and
        // more wrong of the two readings.
        measurementIssues.push(`${metricName} has a configured reference but was not emitted`);
        reasons.push(`${metricName} has a configured reference but was not emitted`);
        continue;
      }
      // run.ts now rejects non-finite metrics at collection, so this is
      // defence in depth for a caller that bypasses it. It is a broken
      // measurement, not a slow one — NaN > maxValue is false either way, so
      // without this branch it would read as a clean pass.
      if (!Number.isFinite(stat.max)) {
        measurementIssues.push(`${metricName} produced a non-finite value (${stat.max})`);
        reasons.push(`${metricName} non-finite (${stat.max})`);
        continue;
      }
      // The worst iteration, not the average of them. Mean and sum ride along
      // in the reason so a reader can tell a single spike from a steady climb.
      if (stat.max > maxValue) {
        outsideReference = true;
        reasons.push(
          `${metricName} max ${round(stat.max)} > reference ${maxValue} ` +
            `(mean ${round(stat.mean)}, sum ${round(stat.sum)} over ${stat.count})`
        );
      }
    }
  }

  const hasUsableBaseline = baselineP95 !== undefined && Number.isFinite(baselineP95);

  if (!hasUsableBaseline) {
    // Normal, not a defect — a new scenario, or a machine with no recorded
    // history yet. Deliberately NOT `outsideReference`: a missing reference is
    // an absent comparison, not a measurement that came back worse. The old
    // "failing closed" wording described a gate that no longer exists.
    reasons.push(
      hasBaselineFile ? "no recorded baseline for this scenario" : "no baseline file for this mode"
    );
  } else if (baselineP95 >= MIN_REGRESSION_BASELINE_MS) {
    const driftPct = ((p95Ms - baselineP95) / baselineP95) * 100;
    const reference = budget.maxRegressionPct;
    if (reference !== undefined && driftPct > reference) {
      outsideReference = true;
      reasons.push(
        `p95 drifted ${round(driftPct)}% from baseline ${round(baselineP95)}ms (reference ${reference}%)`
      );
    }
  } else {
    // Below the noise floor a percentage is meaningless — a fraction of a
    // millisecond of scheduler jitter dwarfs the signal. This branch used to
    // report nothing at all unless the scenario was critical, which left about
    // a third of the suite silent. Report the absolute delta for every
    // scenario instead: it is the only honest statement available, and it is
    // still a number a reader can act on.
    const deltaMs = p95Ms - baselineP95;
    const signed = `${deltaMs >= 0 ? "+" : ""}${round(deltaMs)}ms`;
    if (deltaMs > ABSOLUTE_REGRESSION_MS_FLOOR) {
      outsideReference = true;
      reasons.push(
        `p95 ${signed} vs baseline ${round(baselineP95)}ms — below the ${MIN_REGRESSION_BASELINE_MS}ms noise floor, so percentage drift is not meaningful`
      );
    } else {
      reasons.push(`p95 ${signed} vs baseline ${round(baselineP95)}ms (sub-noise-floor)`);
    }
  }

  return { outsideReference, measurementIssues, reasons };
}

export interface CorrectnessParams {
  /** Metric keys the scenario declares as miss counts, or undefined if none. */
  correctness: readonly string[] | undefined;
  metricStats: Record<string, MetricStat>;
  /** Measured iterations — the denominator every predicate has to match. */
  runs: number;
}

/**
 * Checks a scenario's correctness predicates against what it actually emitted.
 *
 * A benchmark whose subject died reports no spawns, no allocations and no
 * elapsed time, which reads as the best result the harness has ever recorded.
 * The predicates are the only thing standing between that and a celebrated
 * regression, so a predicate that is missing, partial, or non-zero says the
 * numbers around it mean nothing — a measurement issue, never a gate.
 */
export function evaluateCorrectness(params: CorrectnessParams): string[] {
  const { correctness, metricStats, runs } = params;
  const issues: string[] = [];

  const declared = correctness ?? [];
  if (declared.length === 0) {
    // Counts only. A duration falling to zero is visible as a duration, whereas
    // a count falling to zero is indistinguishable from the counted work never
    // having happened — which is the entire reason the predicate exists.
    const counts = Object.keys(metricStats)
      .filter((name) => classifyMetric(name) === "count")
      .sort();
    if (counts.length > 0) {
      issues.push(
        `reports count-class metric(s) ${counts.join(", ")} but declares no correctness ` +
          `predicate — nothing here can tell a real 0 from a subject that stopped running`
      );
    }
    return issues;
  }

  for (const metricName of declared) {
    const stat = metricStats[metricName];
    if (stat === undefined) {
      issues.push(
        `declared correctness predicate "${metricName}" was never emitted — the one reading ` +
          `that would prove this scenario's subject ran is the reading that is missing`
      );
      continue;
    }

    // run.ts rejects non-finite metrics at collection, so this is defence in
    // depth for a caller that bypasses it. NaN > 0 is false, so without this
    // branch a poisoned predicate reads as a healthy one.
    if (!Number.isFinite(stat.max)) {
      issues.push(
        `correctness predicate "${metricName}" produced a non-finite value (${stat.max})`
      );
      continue;
    }

    // `count` tallies the iterations that emitted the metric, not the run
    // count, so a predicate present on one iteration among sixteen still
    // aggregates to `max: 0`. The blind iterations are the ones that matter.
    if (stat.count !== runs) {
      issues.push(
        `correctness predicate "${metricName}" was emitted on ${stat.count} of ${runs} ` +
          `iteration(s) — the ${runs - stat.count} missing one(s) contribute nothing to its ` +
          `max, so an unmeasured scenario still aggregates to a clean 0`
      );
    }

    if (stat.max > 0) {
      issues.push(
        `correctness predicate "${metricName}" reported misses (max ${round(stat.max)}, ` +
          `sum ${round(stat.sum)} over ${stat.count}) — the subject misbehaved while being ` +
          `measured, so every number from this scenario is suspect`
      );
    }
  }

  return issues;
}
