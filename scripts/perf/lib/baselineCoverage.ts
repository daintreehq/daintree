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
    // An entry that cannot say WHEN it was measured is dropped, not carried:
    // the freshness check skips an unparseable date silently, so keeping the
    // value would make an undateable reference behave exactly like a fresh one.
    // Absent is a state the harness already reports honestly.
    if (typeof entry.measuredAt !== "string" || !Number.isFinite(Date.parse(entry.measuredAt))) {
      continue;
    }
    entries[scenarioId] = {
      p95Ms: entry.p95Ms,
      measuredAt: entry.measuredAt,
      machine: normalizeMachine(entry.machine),
    };
  }

  return entries;
}

/**
 * A stored machine identity, or null when it cannot stand for one.
 *
 * All three fields or nothing. A half-filled identity is the dangerous case:
 * `describeForeignReference` compares label, platform and arch, so an entry
 * carrying only a `machineLabel` that happens to match would be read as local
 * on the strength of one field, with the other two supplied by the machine
 * asking the question. Partial provenance degrades to null, which is treated as
 * foreign — the same direction every other unknown resolves in here.
 */
function normalizeMachine(machine: BaselineEntry["machine"]): BaselineEntry["machine"] {
  if (!machine || typeof machine !== "object") return null;
  const { machineLabel, platform, arch } = machine;
  if (typeof machineLabel !== "string" || machineLabel.trim() === "") return null;
  if (typeof platform !== "string" || platform.trim() === "") return null;
  if (typeof arch !== "string" || arch.trim() === "") return null;
  return { machineLabel, platform: platform as NodeJS.Platform, arch };
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
  // Covers both causes without claiming to know which: a pre-provenance file,
  // and an entry whose machine was present but incomplete and was nulled on
  // read. Either way the reference cannot say where it came from.
  if (!entry.machine) return "reference carries no usable machine identity";

  // Compared field by field rather than by spreading the stored machine over
  // the current environment. The spread was the defect: it filled anything the
  // entry did not carry from the machine asking the question, so an identity
  // holding only a matching `machineLabel` came out local. `readBaselineEntries`
  // now nulls a partial machine, and this no longer relies on it having.
  const { machineLabel, platform, arch } = entry.machine;
  if (
    machineLabel === environment.machineLabel &&
    platform === environment.platform &&
    arch === environment.arch
  ) {
    return null;
  }

  const referenceEnvironment: RunEnvironment = { ...environment, machineLabel, platform, arch };
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
