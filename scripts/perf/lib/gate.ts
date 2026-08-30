import { round } from "./stats";
import type { MetricStat, ScenarioBudget } from "../types";

/**
 * Baselines at or above this p95 (in ms) are gated by percentage regression.
 * Below it, percentage math is unstable (a fraction of a millisecond of
 * scheduler noise dwarfs the signal), so we fall back to an absolute-delta gate.
 */
export const MIN_REGRESSION_BASELINE_MS = 5;

/**
 * Absolute p95 increase (in ms) that fails a critical scenario whose baseline
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
 * 3ms is ~2x the widest observed delta. The other two critical scenarios sit
 * at 0.3ms and 0.7ms, so a real regression in any of them is an
 * order-of-magnitude blowup and still trips this comfortably.
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
  /** Whether this scenario is in `criticalScenarios`. */
  isCritical: boolean;
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
 * Pure per-scenario budget evaluation. Covers the absolute p95 budget, metric
 * ceilings, and the baseline regression gate. "Fails closed" here means
 * `outsideReference` is set — an annotation on the report, never an exit code.
 * Only `measurementIssues` says the apparatus itself is broken.
 */
export function evaluateScenarioBudget(params: GateParams): GateResult {
  const { p95Ms, metricStats, budget, baselineP95, isCritical, hasBaselineFile } = params;

  let outsideReference = false;
  const reasons: string[] = [];
  const measurementIssues: string[] = [];

  // A non-finite measurement (NaN/Infinity) means the scenario is broken. NaN
  // comparisons are always false in JS, so without this guard every gate below
  // would silently pass — fail closed instead.
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
    reasons.push(`p95 ${round(p95Ms)}ms > budget ${budget.p95Ms}ms`);
  }

  if (budget.maxMetricValues) {
    for (const [metricName, maxValue] of Object.entries(budget.maxMetricValues)) {
      const stat = metricStats[metricName];
      // A configured ceiling whose metric is no longer emitted is a gate that
      // has silently disappeared — the exact failure this file exists to
      // prevent — so an absent metric fails rather than passes. Renaming a
      // metric must therefore rename it in budgets.json too.
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
    if (isCritical) {
      outsideReference = true;
      reasons.push(
        hasBaselineFile
          ? "critical scenario missing from baseline - failing closed"
          : "baseline file missing for critical scenario - failing closed"
      );
    } else {
      reasons.push("baseline missing - regression gate skipped");
    }
  } else if (budget.maxRegressionPct !== undefined) {
    if (baselineP95 >= MIN_REGRESSION_BASELINE_MS) {
      const regressionPct = ((p95Ms - baselineP95) / baselineP95) * 100;
      if (regressionPct > budget.maxRegressionPct) {
        outsideReference = true;
        reasons.push(
          `regression ${round(regressionPct)}% exceeds ${budget.maxRegressionPct}% baseline gate`
        );
      }
    } else if (isCritical) {
      const deltaMs = p95Ms - baselineP95;
      if (deltaMs > ABSOLUTE_REGRESSION_MS_FLOOR) {
        outsideReference = true;
        reasons.push(
          `regression +${round(deltaMs)}ms exceeds ${ABSOLUTE_REGRESSION_MS_FLOOR}ms absolute gate (baseline ${round(baselineP95)}ms below ${MIN_REGRESSION_BASELINE_MS}ms noise floor)`
        );
      }
    } else {
      reasons.push(
        `baseline ${round(baselineP95)}ms below ${MIN_REGRESSION_BASELINE_MS}ms noise floor - regression gate skipped`
      );
    }
  }

  return { outsideReference, measurementIssues, reasons };
}
