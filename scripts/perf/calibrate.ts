import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyMetric, comparabilityMarker, isMachineIndependent } from "./lib/comparability";
import { percentile, round } from "./lib/stats";
import type { PerfMode, PerfRunSummary } from "./types";

/**
 * `npm run perf calibrate` — how much a number moves when NOTHING changed.
 *
 * Runs one scenario several times against the current tree, each in its own
 * process exactly as `run.ts` drives it, and reports the spread. Every figure it
 * produces is noise by construction: same commit, same machine, same protocol.
 *
 * WHY THIS EXISTS
 *   A threshold set without it is a guess. The harness has no gates today and
 *   should not gain one until somebody can say what normal variation looks like
 *   on the machine the gate would run on — and the failure mode of guessing is
 *   documented history here: the old cron gate ran red for fifteen consecutive
 *   days over ~2% overshoots, which trained everyone to ignore it. A threshold
 *   below noise does that. A threshold widened until it can never fire is the
 *   other half of the same mistake.
 *
 *   It is also the tool for the question this harness keeps raising and could
 *   not answer: is this predicate flaky, or did the subject actually break?
 *   Run the scenario ten times. If a correctness term is nonzero in three of
 *   them on an untouched tree, the term is measuring the machine.
 *
 * WHAT IT DOES NOT DO
 *   It does not set anything. There is no gate to feed and no baseline written.
 *   It prints what the noise floor is and leaves the judgement to a person,
 *   which is the same stance as the rest of the suite.
 *
 *   It also does not establish a stable noise BOUND. N runs back to back in one
 *   session, on one machine, in one thermal and background state, show the
 *   spread THAT SESSION had. Between-session variation is strictly wider and is
 *   not sampled here, so nothing this prints is a floor anyone should treat as
 *   settled — the guide's own instruction is to repeat this across sessions
 *   before trusting a number, and this command is one session of that.
 *
 *   Nor can it separate within-run from between-run variation, because the
 *   harness takes one sample set per process. What it reports is between-run
 *   spread at the scenario's own iteration count, which is the quantity a
 *   before/after comparison is actually exposed to.
 */

const perfDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(perfDir, "..", "..");

/** Enough rounds for a spread to mean something, few enough to finish. */
const DEFAULT_ROUNDS = 7;

/**
 * Rounds below which an interquartile range is not worth printing.
 *
 * Quartiles from four samples are two samples wearing a statistical name.
 */
const MIN_ROUNDS_FOR_IQR = 5;

class UsageError extends Error {}

interface CalibrateOptions {
  scenarioId: string;
  rounds: number;
  mode: PerfMode;
}

function parseArgs(argv: string[]): CalibrateOptions {
  let scenarioId: string | undefined;
  let rounds = DEFAULT_ROUNDS;
  let mode: PerfMode = "smoke";

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`${token} expects a value`);
      }
      i += 1;
      return value;
    };
    if (token === "--scenario") {
      scenarioId = next().toUpperCase();
      continue;
    }
    if (token === "--rounds") {
      const value = Number(next());
      if (!Number.isInteger(value) || value < MIN_ROUNDS_FOR_IQR) {
        throw new UsageError(
          `--rounds expects an integer >= ${MIN_ROUNDS_FOR_IQR}; fewer cannot show a spread ` +
            "worth reading, and quartiles from four samples are two samples with a statistical name"
        );
      }
      rounds = value;
      continue;
    }
    if (token === "--mode") {
      const value = next();
      if (!["smoke", "ci", "nightly", "soak"].includes(value)) {
        throw new UsageError(`unknown --mode ${value}`);
      }
      mode = value as PerfMode;
      continue;
    }
    throw new UsageError(`unknown flag ${token}. Known: --scenario, --rounds, --mode`);
  }

  if (!scenarioId) {
    throw new UsageError(
      "--scenario is required and takes exactly one id, the same as every other command here"
    );
  }
  return { scenarioId, rounds, mode };
}

function runOnce(options: CalibrateOptions, jsonPath: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "--expose-gc",
        "--import",
        "tsx",
        path.join(perfDir, "run.ts"),
        "--mode",
        options.mode,
        "--scenario",
        options.scenarioId,
        "--json",
        jsonPath,
        "--out-dir",
        path.dirname(jsonPath),
      ],
      { stdio: ["ignore", "ignore", "inherit"], cwd: repoRoot }
    );
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

interface Spread {
  name: string;
  samples: number[];
  medianValue: number;
  min: number;
  max: number;
  /** Absolute gap between the extreme runs. */
  range: number;
  /** Range as a share of the median, or null when the median is zero. */
  rangePct: number | null;
}

function describeSpread(name: string, samples: number[]): Spread {
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const medianValue = percentile(samples, 50);
  return {
    name,
    samples,
    medianValue,
    min,
    max,
    range: max - min,
    rangePct: medianValue === 0 ? null : ((max - min) / Math.abs(medianValue)) * 100,
  };
}

function formatSpread(spread: Spread): string {
  const cls = classifyMetric(spread.name);
  const pct = spread.rangePct === null ? "n/a" : `${round(spread.rangePct, 1)}%`;
  // Correctness predicates get no effect-size reference. They are structural
  // facts with one correct value, so "a movement worth calling" is a category
  // error: any nonzero reading matters and no multiple of a spread applies.
  const isPredicate = spread.name.endsWith("Misses");
  const reference = isPredicate
    ? "n/a (predicate)"
    : spread.range === 0
      ? "no spread this session"
      : `2x ${round(spread.range, 3)}${spread.rangePct === null ? "" : ` (${round(spread.rangePct, 1)}%)`}`;
  return [
    spread.name,
    `${comparabilityMarker(cls)} ${cls}`,
    round(spread.medianValue, 3),
    round(spread.min, 3),
    round(spread.max, 3),
    pct,
    reference,
  ].join(" | ");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-calibrate-"));

  console.log(
    `[calibrate] ${options.scenarioId} — ${options.rounds} rounds, mode ${options.mode}, ` +
      `same commit and same machine. Everything below is noise.\n`
  );

  const summaries: PerfRunSummary[] = [];
  try {
    for (let round_ = 1; round_ <= options.rounds; round_ += 1) {
      const jsonPath = path.join(dir, `round-${round_}.json`);
      process.stdout.write(`[calibrate] round ${round_}/${options.rounds}… `);
      const code = await runOnce(options, jsonPath);
      if (code !== 0) {
        console.log("FAILED");
        console.error(
          `[calibrate] round ${round_} exited ${code}. A scenario that cannot complete ` +
            `cannot be calibrated; fix the run before reading a spread.`
        );
        process.exitCode = 1;
        return;
      }
      const summary = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as PerfRunSummary;
      summaries.push(summary);
      const aggregate = summary.aggregates[0];
      console.log(`p50 ${aggregate ? round(aggregate.p50Ms, 2) : "?"}ms`);
    }

    const aggregates = summaries.map((summary) => summary.aggregates[0]).filter(Boolean);
    if (aggregates.length !== options.rounds) {
      console.error("[calibrate] a round produced no aggregate; nothing to compare");
      process.exitCode = 1;
      return;
    }

    // Correctness first: a term that is nonzero on an untouched tree is
    // measuring the machine, and that is the single most useful thing this
    // command can tell anyone.
    const unstablePredicates: string[] = [];
    for (const [name, stat] of Object.entries(aggregates[0]!.metricStats)) {
      if (!name.endsWith("Misses")) continue;
      void stat;
      const values = aggregates.map((a) => a.metricStats[name]?.max ?? 0);
      if (values.some((value) => value !== 0)) {
        const bad = values.filter((value) => value !== 0).length;
        unstablePredicates.push(`${name} nonzero in ${bad}/${options.rounds} rounds`);
      }
    }

    console.log("");
    if (unstablePredicates.length > 0) {
      console.log("## Predicate violations observed\n");
      for (const line of unstablePredicates) console.log(`- ${line}`);
      console.log(
        "\nA correctness term is a structural fact with one correct value, so a nonzero " +
          "reading on an unchanged tree means something is non-deterministic: the fixture, " +
          "the predicate's own timing assumptions, or the subject. Which one it is takes " +
          "reading; what is certain is that the numbers below cannot be trusted until it " +
          "is settled.\n"
      );
    } else {
      console.log(
        `## Predicates\n\nEvery correctness term read 0 in all ${options.rounds} rounds.\n`
      );
    }

    const durations = aggregates.map((a) => a.p50Ms);
    const spreads: Spread[] = [describeSpread("p50Ms", durations)];
    for (const name of Object.keys(aggregates[0]!.metricStats).sort()) {
      spreads.push(
        describeSpread(
          name,
          aggregates.map((a) => a.metricStats[name]?.max ?? 0)
        )
      );
    }

    console.log(`## Spread across ${options.rounds} identical runs, this session\n`);
    console.log(
      "The reference column is exploratory, not a threshold: twice THIS session's observed " +
        "range. Range is sensitive to how many rounds ran, and a between-session spread is " +
        "wider than anything measurable here.\n"
    );
    console.log("Metric | Comparable | median | min | max | range | effect-size reference");
    console.log("--- | --- | ---: | ---: | ---: | ---: | ---");
    for (const spread of spreads) console.log(formatSpread(spread));

    const durationSpread = spreads[0]!;
    console.log(
      `\nIn this session, ${options.scenarioId}'s median moved ${round(durationSpread.range, 3)}ms ` +
        `across ${options.rounds} identical runs` +
        (durationSpread.rangePct === null
          ? ""
          : `, ${round(durationSpread.rangePct, 1)}% of its own median`) +
        `. A threshold below that fires on nothing having changed.`
    );
    console.log(
      "\nThis command sets nothing. It is one input to a judgement about whether a number " +
        "from this scenario can carry a claim, and every figure it prints describes this " +
        "machine in this session rather than a settled floor. Repeat it across sessions " +
        "before trusting any of it."
    );

    const independent = spreads.filter(
      (spread) => isMachineIndependent(classifyMetric(spread.name)) && spread.range !== 0
    );
    if (independent.length > 0) {
      console.log(
        `\nWorth a second look: ${independent.map((s) => s.name).join(", ")} ` +
          `${independent.length === 1 ? "is" : "are"} machine-INDEPENDENT and still moved. ` +
          `A count or a size that varies run to run is usually a fixture that is not deterministic.`
      );
    }

    // Interquartile range, printed last because it is the figure a person
    // should actually carry forward: the extremes of seven runs are two
    // samples, and a range built from them is the least stable thing here.
    if (options.rounds >= MIN_ROUNDS_FOR_IQR) {
      const p25 = percentile(durations, 25);
      const p75 = percentile(durations, 75);
      console.log(
        `\nMiddle half of the ${options.rounds} duration samples: ${round(p25, 3)}ms to ` +
          `${round(p75, 3)}ms, by the same nearest-rank percentile the rest of the harness ` +
          `uses (lib/stats.ts). Prefer it over the full range: min and max are one sample each.`
      );
    }

    // Per-round, in order. A spread hides a trend, and a scenario that gets
    // slower every round is a different finding from one that scatters.
    console.log(`\nPer round, in order: ${durations.map((value) => round(value, 2)).join(", ")}ms`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  if (error instanceof UsageError) {
    console.error(`[calibrate] ${error.message}`);
  } else {
    console.error("[calibrate] failed", error);
  }
  process.exit(1);
});
