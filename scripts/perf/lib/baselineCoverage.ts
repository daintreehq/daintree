import { getScenarioBudget } from "./budgets";
import {
  classifyMetric,
  describeIncomparability,
  durationsComparable,
  isMachineIndependent,
} from "./comparability";
import type {
  BaselineEntry,
  BaselineSummary,
  PerfBudgetConfig,
  PerfScenario,
  RunEnvironment,
} from "../types";

/**
 * Baseline entries older than this (in days) trigger a freshness warning.
 * Nothing here gates: a reference value is context for reading a number, not a
 * pass mark, so a stale baseline degrades the quality of the annotation and
 * nothing else. 30 days keeps committed baselines roughly aligned with the
 * runtime they encode.
 */
export const BASELINE_FRESHNESS_DAYS = 30;

const MS_PER_DAY = 86_400_000;

/** Stale ids named in a warning before it collapses into "+N more". */
const MAX_NAMED_STALE = 6;

export interface CoverageGap {
  scenarioId: string;
}

export interface StaleBaselineEntry {
  scenarioId: string;
  ageDays: number;
  /** Null when the entry came from a pre-provenance file. */
  machineLabel: string | null;
}

/**
 * Every usable reference in a baseline file, each carrying its own provenance.
 *
 * Two shapes are read. `scenarios` holds provenanced entries and is what the
 * writer produces. `p95ByScenario` is the pre-provenance shape the committed
 * baselines are still in; those entries are lifted with the file's
 * `generatedAt` as their measurement date, which is true of them and only of
 * them — the whole-matrix writer that produced that shape wrote every entry in
 * one pass, so the file date IS each entry's date. Their machine stays null,
 * because it was never recorded and inventing one is the defect this exists to
 * prevent: a legacy entry must never read as "measured here".
 *
 * Provenanced entries win over legacy ones of the same id. Non-finite values
 * are dropped rather than carried, so a corrupt entry reads as an absent
 * reference instead of poisoning a comparison.
 */
export function readBaselineEntries(
  baseline: BaselineSummary | null
): Record<string, BaselineEntry> {
  if (!baseline) return {};

  const entries: Record<string, BaselineEntry> = {};

  for (const [scenarioId, p95Ms] of Object.entries(baseline.p95ByScenario ?? {})) {
    if (typeof p95Ms !== "number" || !Number.isFinite(p95Ms)) continue;
    entries[scenarioId] = { p95Ms, measuredAt: baseline.generatedAt, machine: null };
  }

  for (const [scenarioId, entry] of Object.entries(baseline.scenarios ?? {})) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.p95Ms !== "number" || !Number.isFinite(entry.p95Ms)) continue;
    entries[scenarioId] = {
      p95Ms: entry.p95Ms,
      measuredAt: entry.measuredAt,
      machine: entry.machine ?? null,
    };
  }

  return entries;
}

/**
 * Baseline entries measured longer ago than `thresholdDays`, oldest first.
 *
 * Per-entry rather than per-file, because the file-wide `generatedAt` stopped
 * describing the entries the moment `--update-baseline` began merging: one
 * scenario measured today re-dates a file holding forty references from six
 * months ago, and a check reading that timestamp calls the whole set fresh.
 *
 * An unparseable date is skipped rather than reported. Freshness is advisory,
 * and `verify-baselines.ts` is where a malformed field is a finding.
 */
export function findStaleBaselineEntries(
  baseline: BaselineSummary | null,
  thresholdDays = BASELINE_FRESHNESS_DAYS,
  now = new Date()
): StaleBaselineEntry[] {
  const stale: StaleBaselineEntry[] = [];

  for (const [scenarioId, entry] of Object.entries(readBaselineEntries(baseline))) {
    const measuredAtMs = new Date(entry.measuredAt).getTime();
    if (!Number.isFinite(measuredAtMs)) continue;

    const ageDays = (now.getTime() - measuredAtMs) / MS_PER_DAY;
    if (ageDays <= thresholdDays) continue;

    stale.push({
      scenarioId,
      ageDays: Math.round(ageDays),
      machineLabel: entry.machine?.machineLabel ?? null,
    });
  }

  return stale.sort((a, b) => b.ageDays - a.ageDays || a.scenarioId.localeCompare(b.scenarioId));
}

/**
 * Warn (never fail) about baseline entries older than `thresholdDays`.
 *
 * `focusIds` are the scenarios this run is about. A stale reference for one of
 * them is the only stale entry that affects the numbers on screen, so those are
 * named in full and never elided into the overflow count.
 */
export function checkBaselineFreshness(
  baseline: BaselineSummary | null,
  mode: string,
  thresholdDays = BASELINE_FRESHNESS_DAYS,
  now = new Date(),
  focusIds: readonly string[] = []
): void {
  if (!baseline) return;

  const stale = findStaleBaselineEntries(baseline, thresholdDays, now);
  if (stale.length === 0) return;

  const total = Object.keys(readBaselineEntries(baseline)).length;
  const focus = new Set(focusIds);

  for (const entry of stale.filter((candidate) => focus.has(candidate.scenarioId))) {
    console.warn(
      `[perf:${mode}] WARNING the reference for ${entry.scenarioId} was measured ` +
        `${entry.ageDays} days ago on ${entry.machineLabel ?? "an unrecorded machine"} ` +
        `— regenerate with --update-baseline`
    );
  }

  const rest = stale.filter((candidate) => !focus.has(candidate.scenarioId));
  if (rest.length === 0) return;

  const named = rest
    .slice(0, MAX_NAMED_STALE)
    .map((entry) => `${entry.scenarioId} (${entry.ageDays}d)`);
  const overflow = rest.length - named.length;
  console.warn(
    `[perf:${mode}] WARNING ${stale.length} of ${total} baseline entries are older than ` +
      `${thresholdDays}d: ${named.join(", ")}${overflow > 0 ? `, +${overflow} more` : ""}`
  );
}

/**
 * Why a stored reference cannot be read as a comparison for this run, or null
 * when it can.
 *
 * `lib/comparability.ts` owns the rule and this defers to it: a p95 classifies
 * as `duration`, which is machine-dependent, so a reference measured elsewhere
 * is a number rather than a comparison. The classification is looked up rather
 * than asserted so that this follows the rules if they ever move.
 *
 * The entry is annotated, never dropped: it is frequently the only reference
 * that exists for a scenario, and the part that would be false is the drift
 * VERDICT, not the value. Caller withholds the verdict and reports the reason.
 *
 * An entry with no recorded machine is treated as foreign. It may well have
 * been measured here, but "unknown" resolved in the convenient direction is
 * exactly how a Windows number ends up annotating a Mac run.
 */
export function describeForeignReference(
  entry: BaselineEntry,
  environment: RunEnvironment
): string | null {
  if (isMachineIndependent(classifyMetric("p95Ms"))) return null;
  if (!entry.machine) return "reference has no recorded machine (pre-provenance baseline)";

  // `durationsComparable` and `describeIncomparability` read machineLabel,
  // platform and arch and nothing else, and those three are precisely what a
  // BaselineEntry stores; the spread supplies the fields they do not consult.
  const referenceEnvironment: RunEnvironment = { ...environment, ...entry.machine };
  if (durationsComparable(referenceEnvironment, environment)) return null;

  return describeIncomparability(referenceEnvironment, environment);
}

/**
 * Structural pre-run check: a scenario scheduled for this run that carries a
 * regression budget (`maxRegressionPct`) but is absent from the loaded baseline
 * has no reference to compare against yet. Returns those gaps so the caller can
 * say so; `run.ts` reports them and carries on, because a scenario without a
 * reference value is a normal state — a new scenario, or a newly added OS.
 *
 * Presence is the whole test. A reference measured on another machine is
 * present, and reporting it as absent here would conflate "you have no
 * reference" with "your reference is not comparable" — two different states
 * with two different fixes. `describeForeignReference` is where the second one
 * is reported, per scenario, beside the number it affects.
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

  const entries = readBaselineEntries(baseline);
  const gaps: CoverageGap[] = [];
  for (const scenario of scenariosForThisRun) {
    const budget = getScenarioBudget(budgetConfig, scenario.id);
    if (budget.maxRegressionPct === undefined) continue;

    if (entries[scenario.id] === undefined) {
      gaps.push({ scenarioId: scenario.id });
    }
  }

  return gaps;
}
