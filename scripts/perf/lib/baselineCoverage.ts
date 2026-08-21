import { getScenarioBudget } from "./budgets";
import type { BaselineSummary, PerfBudgetConfig, PerfScenario } from "../types";

/**
 * Baselines older than this (in days) trigger a freshness warning. The threshold
 * is an opinion, not a hard rule — a stale-but-present baseline still gates, so
 * this only ever warns. 30 days keeps committed baselines roughly aligned with
 * the runtime they encode without breaking CI for legitimately-quiet periods.
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
 * would otherwise silently skip its regression gate. Returns those gaps so the
 * caller can fail the run before wasting measurement time.
 *
 * Scenarios marked `calibrating` are excluded: they have deliberately not been
 * baselined yet, so a missing entry is the expected state, not a gap.
 *
 * Critical scenarios are excluded — `gate.ts` already fails closed for them.
 * A null baseline returns no gaps: that's the pre-existing "no file" path, not
 * the partial-coverage gap this check targets.
 */
export function checkBaselineCoverage(
  baseline: BaselineSummary | null,
  budgetConfig: PerfBudgetConfig,
  scenariosForThisRun: PerfScenario[]
): CoverageGap[] {
  if (!baseline) return [];

  const gaps: CoverageGap[] = [];
  for (const scenario of scenariosForThisRun) {
    if (budgetConfig.criticalScenarios.includes(scenario.id)) continue;

    const budget = getScenarioBudget(budgetConfig, scenario.id);
    if (budget.calibrating) continue;
    if (budget.maxRegressionPct === undefined) continue;

    const baselineP95 = baseline.p95ByScenario?.[scenario.id];
    if (baselineP95 === undefined || !Number.isFinite(baselineP95)) {
      gaps.push({ scenarioId: scenario.id });
    }
  }

  return gaps;
}
