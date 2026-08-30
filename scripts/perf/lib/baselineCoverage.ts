import { getScenarioBudget } from "./budgets";
import type { BaselineSummary, PerfBudgetConfig, PerfScenario } from "../types";

/**
 * Baselines older than this (in days) trigger a freshness warning. Nothing here
 * gates: a reference value is context for reading a number, not a pass mark, so
 * a stale baseline degrades the quality of the annotation and nothing else.
 * 30 days keeps committed baselines roughly aligned with the runtime they
 * encode.
 */
export const BASELINE_FRESHNESS_DAYS = 30;

const MS_PER_DAY = 86_400_000;

export interface CoverageGap {
  scenarioId: string;
}

/**
 * Warn (never fail) when the loaded baseline's `generatedAt` is older than
 * `thresholdDays`. Skips when no baseline is loaded or the timestamp is
 * unparseable — freshness is advisory, so a malformed value must not throw.
 */
export function checkBaselineFreshness(
  baseline: BaselineSummary | null,
  mode: string,
  thresholdDays = BASELINE_FRESHNESS_DAYS,
  now = new Date()
): void {
  if (!baseline) return;

  const generatedAtMs = new Date(baseline.generatedAt).getTime();
  if (!Number.isFinite(generatedAtMs)) return;

  const ageDays = (now.getTime() - generatedAtMs) / MS_PER_DAY;
  if (ageDays > thresholdDays) {
    console.warn(
      `[perf:${mode}] WARNING baseline is ${Math.round(ageDays)} days old ` +
        `(threshold ${thresholdDays}d) — regenerate with --update-baseline`
    );
  }
}

/**
 * Structural pre-run check: a scenario scheduled for this run that carries a
 * regression budget (`maxRegressionPct`) but is absent from the loaded baseline
 * has no reference to compare against yet. Returns those gaps so the caller can
 * say so; `run.ts` reports them and carries on, because a scenario without a
 * reference value is a normal state — a new scenario, or a newly added OS.
 * `verify-baselines.ts` is the one caller that still treats a gap as a failure,
 * because it is checking a freshly regenerated baseline for completeness.
 *
 * There are no exemptions. An earlier version excluded "critical" scenarios on
 * the theory that `gate.ts` failed closed for them; nothing fails closed now,
 * so the exemption only suppressed the warning for the scenarios it was meant
 * to protect. A null baseline returns no gaps: that's the pre-existing "no
 * file" path, not the partial-coverage gap this check targets.
 */
export function checkBaselineCoverage(
  baseline: BaselineSummary | null,
  budgetConfig: PerfBudgetConfig,
  scenariosForThisRun: PerfScenario[]
): CoverageGap[] {
  if (!baseline) return [];

  const gaps: CoverageGap[] = [];
  for (const scenario of scenariosForThisRun) {
    const budget = getScenarioBudget(budgetConfig, scenario.id);
    if (budget.maxRegressionPct === undefined) continue;

    const baselineP95 = baseline.p95ByScenario?.[scenario.id];
    if (baselineP95 === undefined || !Number.isFinite(baselineP95)) {
      gaps.push({ scenarioId: scenario.id });
    }
  }

  return gaps;
}
