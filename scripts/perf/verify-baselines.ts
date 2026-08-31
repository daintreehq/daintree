import path from "node:path";
import { findStaleBaselineEntries, readBaselineEntries } from "./lib/baselineCoverage";
import { readJson } from "./lib/io";
import { getScenariosForMode } from "./scenarios";
import type { BaselineSummary, PerfMode } from "./types";

/**
 * Integrity check for the committed baseline files, run by hand.
 *
 * This is the one place in `scripts/perf` that exits non-zero, and the
 * distinction is deliberate: it does not judge a NUMBER, it judges whether the
 * FILES are usable. A reference that is zero, non-finite, or shaped like
 * something the readers cannot parse is not a slow measurement, it is a file
 * that will mislead the next person who reads a run.
 *
 * What it does NOT assert any more is completeness or global freshness. Both
 * claims needed a whole-matrix run behind them, and there is no such run:
 * `--scenario` takes exactly one id, nothing is scheduled, and no workflow
 * harvests anything. Baselines accumulate one scenario at a time on whichever
 * machines a developer measured on, so a missing scenario is the normal state
 * and an old entry is a fact about that entry, not a broken regen step.
 * Coverage and age are still reported — as counts, below the verdict — because
 * they are worth seeing before committing. They cannot fail the run.
 */

const MODES: PerfMode[] = ["smoke", "ci", "nightly", "soak"];

/** Entries older than this are counted in the informational age line. */
const AGE_REPORT_DAYS = 30;

interface ModeReport {
  problems: string[];
  notes: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Shape check on the raw JSON, before `readBaselineEntries` normalises it.
 *
 * The reader deliberately drops anything it cannot use, so a corrupt entry
 * reads there as an absent reference. That is the right behaviour at run time
 * and the wrong one here — this is the check whose whole job is to notice that
 * an entry went missing on the way in.
 */
function inspectEntries(baseline: BaselineSummary): string[] {
  const problems: string[] = [];

  for (const [scenarioId, value] of Object.entries(baseline.p95ByScenario ?? {})) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      problems.push(`${scenarioId}: legacy p95 is not a finite number (${String(value)})`);
    }
  }

  for (const [scenarioId, entry] of Object.entries(baseline.scenarios ?? {})) {
    if (!isRecord(entry)) {
      problems.push(`${scenarioId}: entry is not an object (${String(entry)})`);
      continue;
    }
    if (typeof entry.p95Ms !== "number" || !Number.isFinite(entry.p95Ms)) {
      problems.push(`${scenarioId}: p95Ms is not a finite number (${String(entry.p95Ms)})`);
    }
    if (typeof entry.measuredAt !== "string" || !Number.isFinite(Date.parse(entry.measuredAt))) {
      // An entry that cannot say when it was measured is exactly the state this
      // whole format exists to remove, and the freshness check silently skips
      // it — so it has to be caught before the file is committed.
      problems.push(`${scenarioId}: measuredAt is unparseable (${String(entry.measuredAt)})`);
    }
    // `machine: null` is legal and means "lifted from a pre-provenance file".
    // A machine that is present but incomplete is not: a half-filled identity
    // would be compared against the current one and silently decide a
    // cross-machine reference was local.
    if (entry.machine !== null && entry.machine !== undefined) {
      if (!isRecord(entry.machine)) {
        problems.push(`${scenarioId}: machine is neither an object nor null`);
      } else {
        for (const field of ["machineLabel", "platform", "arch"] as const) {
          const fieldValue = entry.machine[field];
          if (typeof fieldValue !== "string" || fieldValue.trim() === "") {
            problems.push(`${scenarioId}: machine.${field} is missing or empty`);
          }
        }
      }
    }
  }

  return problems;
}

function verifyMode(mode: PerfMode): ModeReport {
  const baselinePath = path.resolve(process.cwd(), `scripts/perf/config/baseline.${mode}.json`);
  const problems: string[] = [];
  const notes: string[] = [];

  let baseline: BaselineSummary | null;
  try {
    baseline = readJson<BaselineSummary>(baselinePath);
  } catch (error) {
    return { problems: [`unreadable or malformed JSON (${(error as Error).message})`], notes };
  }

  // Absent is a fact, not a fault. A machine that has never measured a mode has
  // no file for it, and that is the starting state of every new machine.
  if (!baseline) return { problems, notes: [`no baseline file yet (${baselinePath})`] };

  if (!isRecord(baseline)) return { problems: ["file does not contain a JSON object"], notes };

  if (baseline.mode !== mode) {
    problems.push(`mode field is "${baseline.mode}", expected "${mode}" — wrong file written`);
  }

  if (!Number.isFinite(Date.parse(baseline.generatedAt))) {
    problems.push(`generatedAt is unparseable ("${baseline.generatedAt}")`);
  }

  problems.push(...inspectEntries(baseline));

  const entries = readBaselineEntries(baseline);
  const ids = Object.keys(entries);

  // An existing file holding nothing is a broken write, not an empty start —
  // the absent-file case returned above.
  if (ids.length === 0) {
    problems.push("file exists but holds no references");
  }

  // A literal-zero p95 sinks the scenario under gate.ts's
  // MIN_REGRESSION_BASELINE_MS floor, so its drift annotation silently stops
  // meaning anything. This is how the `durationMs: 0` sentinel regression
  // stayed invisible. A negative p95 is not a measurement at all.
  const nonPositive = ids.filter((id) => (entries[id]?.p95Ms ?? 0) <= 0);
  if (nonPositive.length > 0) {
    problems.push(
      `p95 values at or below zero (drift annotation would be silently skipped): ${nonPositive.join(", ")}`
    );
  }

  const matrixIds = getScenariosForMode(mode).map((scenario) => scenario.id);
  const covered = matrixIds.filter((id) => entries[id] !== undefined);
  notes.push(`${covered.length}/${matrixIds.length} scenarios in this mode have a reference`);

  const unprovenanced = ids.filter((id) => entries[id]?.machine === null);
  if (unprovenanced.length > 0) {
    notes.push(
      `${unprovenanced.length}/${ids.length} entries carry no machine (pre-provenance); ` +
        "each is read as measured elsewhere until it is re-measured"
    );
  }

  const machineLabels = new Set(
    ids.map((id) => entries[id]?.machine?.machineLabel).filter((label): label is string => !!label)
  );
  if (machineLabels.size > 1) {
    // Legal, and the expected shape for anyone measuring on two laptops. Worth
    // saying out loud so nobody reads the file as one machine's record.
    notes.push(`references from ${machineLabels.size} machines: ${[...machineLabels].join(", ")}`);
  }

  const stale = findStaleBaselineEntries(baseline, AGE_REPORT_DAYS);
  if (stale.length > 0) {
    notes.push(
      `${stale.length}/${ids.length} entries older than ${AGE_REPORT_DAYS}d ` +
        `(oldest ${stale[0]?.scenarioId} at ${stale[0]?.ageDays}d)`
    );
  }

  const orphans = ids.filter((id) => !matrixIds.includes(id));
  if (orphans.length > 0) {
    // Not a fault either: a scenario can be renamed or retired while its old
    // reference sits in the file, and the merge carries it forward forever
    // because nothing measures it any more.
    notes.push(
      `${orphans.length} reference(s) for ids no longer in this mode: ${orphans.join(", ")}`
    );
  }

  return { problems, notes };
}

function main(): void {
  const extra = process.argv.slice(2);
  if (extra.length > 0) {
    // `--max-age-minutes` used to assert a regen step had just rewritten the
    // file. There is no regen step, so the flag is gone rather than accepted
    // and ignored.
    console.error(`[perf:verify-baselines] unexpected argument(s): ${extra.join(" ")}`);
    process.exit(1);
  }

  let failed = false;

  for (const mode of MODES) {
    const { problems, notes } = verifyMode(mode);
    if (problems.length === 0) {
      console.log(`[perf:verify-baselines] OK ${mode}`);
    } else {
      failed = true;
      for (const problem of problems) {
        console.error(`[perf:verify-baselines] FAIL ${mode}: ${problem}`);
      }
    }
    for (const note of notes) {
      console.log(`[perf:verify-baselines] ${mode}: ${note}`);
    }
  }

  if (failed) {
    console.error(
      "[perf:verify-baselines] these baseline files are not fit to commit — a reference that is " +
        "zero, non-finite or missing its provenance will mislead every run that reads it"
    );
    process.exit(1);
  }

  console.log(`[perf:verify-baselines] ${MODES.length} baseline files are usable`);
}

main();
