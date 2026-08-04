import { round } from "./stats";
import type { ScenarioBudget } from "../types";

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
  metricAverages: Record<string, number>;
  budget: ScenarioBudget;
  /** Baseline p95 for this scenario, or undefined when absent/non-finite. */
  baselineP95: number | undefined;
  /** Whether this scenario is in `criticalScenarios`. */
  isCritical: boolean;
  /** Whether a baseline file was loaded at all (distinct from a missing entry). */
  hasBaselineFile: boolean;
}

export interface GateResult {
  failedBudget: boolean;
  reasons: string[];
}

/**
 * Pure per-scenario budget evaluation. Covers the absolute p95 budget, metric
 * ceilings, and the baseline regression gate. The regression gate fails closed
 * for critical scenarios: a missing baseline file, a missing baseline entry, or
 * a sub-floor baseline that regresses past the absolute-delta gate all fail.
 * Non-critical scenarios without a usable baseline warn but do not block CI.
 */
export function evaluateScenarioBudget(params: GateParams): GateResult {
  const { p95Ms, metricAverages, budget, baselineP95, isCritical, hasBaselineFile } = params;

  let failedBudget = false;
  const reasons: string[] = [];

  // A non-finite measurement (NaN/Infinity) means the scenario is broken. NaN
  // comparisons are always false in JS, so without this guard every gate below
  // would silently pass — fail closed instead.
  if (!Number.isFinite(p95Ms)) {
    return {
      failedBudget: true,
      reasons: [`non-finite p95 measurement (${p95Ms}) - failing closed`],
    };
  }

  if (budget.p95Ms !== undefined && p95Ms > budget.p95Ms) {
    failedBudget = true;
    reasons.push(`p95 ${round(p95Ms)}ms > budget ${budget.p95Ms}ms`);
  }

  if (budget.maxMetricValues) {
    for (const [metricName, maxValue] of Object.entries(budget.maxMetricValues)) {
      const actual = metricAverages[metricName];
      // Treat a non-finite metric as a breach: NaN > maxValue is false, which
      // would otherwise let a broken metric slip past its ceiling.
      if (actual !== undefined && (!Number.isFinite(actual) || actual > maxValue)) {
        failedBudget = true;
        reasons.push(`${metricName} ${round(actual)} > max ${maxValue}`);
      }
    }
  }

  const hasUsableBaseline = baselineP95 !== undefined && Number.isFinite(baselineP95);

  if (!hasUsableBaseline) {
    if (isCritical) {
      failedBudget = true;
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
        failedBudget = true;
        reasons.push(
          `regression ${round(regressionPct)}% exceeds ${budget.maxRegressionPct}% baseline gate`
        );
      }
    } else if (isCritical) {
      const deltaMs = p95Ms - baselineP95;
      if (deltaMs > ABSOLUTE_REGRESSION_MS_FLOOR) {
        failedBudget = true;
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

  return { failedBudget, reasons };
}
