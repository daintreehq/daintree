#!/usr/bin/env node
/**
 * Write the decision BEFORE the measurement that judges it.
 *
 * A freeform run derives its own target, threshold and protocol, which removes
 * the one thing the old fixed-input form was buying: a human had named the
 * metric before any number was on screen. Deriving them is fine — they are in
 * the scenario definition and the probe. Deriving them *after seeing which one
 * moved* is the failure this file exists to make impossible.
 *
 * So the derivation is written here, once, to a file that refuses to be
 * overwritten, and `check-pair.mjs --precommit <file>` compares every later
 * claim against it. A run that decides to judge a different metric, relax its
 * threshold, or change its iteration count has to either say so in the report
 * or fail the gate. It cannot quietly do it.
 *
 * The record also pins the measurement apparatus. `harnessDigest` is a hash of
 * every file under `scripts/perf/` (bar the untracked per-machine history) plus
 * the gate scripts beside this one, so "never edit a measurement surface" stops
 * being an instruction an agent can forget at hour four and becomes a check.
 *
 *   node .agents/skills/optimize/precommit.mjs \
 *     --dir .tmp/opt/PERF-101-spawns \
 *     --scenario PERF-101 \
 *     --target metricStats.spawnsPerWorktreeN50.max \
 *     --predicate refreshMisses --predicate spawnObserverMisses \
 *     --mode smoke --iterations 20 --warmups 3 \
 *     --statistic median --threshold 5 \
 *     --baseline-sha $(git rev-parse HEAD) \
 *     [--higher-is-better] [--guard perChunkUsAt48:10] [--note "..."] [--force]
 *
 * Exit codes:
 *   0  the record was written (or `--print` read one back).
 *   2  usage error, or the record already exists and `--force` was not passed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { harnessDigest } from "./harness-digest.mjs";
import { classifyTarget, isMachineIndependent } from "./metric-class.mjs";

const USAGE =
  "usage: precommit.mjs --dir DIR --scenario ID --target PATH --predicate NAME [...]\n" +
  "                     --mode MODE --iterations N --warmups W --statistic median|count\n" +
  "                     --threshold PCT --baseline-sha SHA\n" +
  "                     [--higher-is-better] [--guard NAME:TOLERANCE_PCT] [--note TEXT] [--force]\n" +
  "       precommit.mjs --print --dir DIR";

function usageError(message) {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

const SINGLE = {
  "--dir": "dir",
  "--scenario": "scenario",
  "--target": "target",
  "--mode": "mode",
  "--iterations": "iterations",
  "--warmups": "warmups",
  "--statistic": "statistic",
  "--threshold": "threshold",
  "--baseline-sha": "baselineSha",
  "--note": "note",
};
const REPEATED = { "--predicate": "predicates", "--guard": "guards" };

function parseArgs(argv) {
  const out = {
    predicates: [],
    guards: [],
    higherIsBetter: false,
    force: false,
    print: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--higher-is-better") out.higherIsBetter = true;
    else if (arg === "--force") out.force = true;
    else if (arg === "--print") out.print = true;
    else if (REPEATED[arg]) {
      const value = argv[(i += 1)];
      if (value === undefined) usageError(`${arg} expects a value`);
      out[REPEATED[arg]].push(value);
    } else if (SINGLE[arg]) {
      const value = argv[(i += 1)];
      if (value === undefined) usageError(`${arg} expects a value`);
      out[SINGLE[arg]] = value;
    } else usageError(`unknown argument ${arg}`);
  }
  if (!out.dir) usageError("--dir is required");
  return out;
}

const args = parseArgs(process.argv.slice(2));
const recordPath = join(args.dir, "precommit.json");

if (args.print) {
  if (!existsSync(recordPath)) {
    console.error(`no precommit record at ${recordPath}`);
    process.exit(2);
  }
  console.log(readFileSync(recordPath, "utf8"));
  process.exit(0);
}

for (const [flag, key] of [
  ["--scenario", "scenario"],
  ["--target", "target"],
  ["--mode", "mode"],
  ["--iterations", "iterations"],
  ["--warmups", "warmups"],
  ["--statistic", "statistic"],
  ["--threshold", "threshold"],
  ["--baseline-sha", "baselineSha"],
]) {
  if (!args[key]) usageError(`${flag} is required`);
}
if (args.predicates.length === 0) usageError("--predicate is required at least once");

const iterations = Number(args.iterations);
const warmups = Number(args.warmups);
const threshold = Number(args.threshold);
if (!Number.isInteger(iterations) || iterations < 1)
  usageError("--iterations must be a positive integer");
if (!Number.isInteger(warmups) || warmups < 0)
  usageError("--warmups must be a non-negative integer");
if (!Number.isFinite(threshold) || threshold <= 0)
  usageError("--threshold must be a positive percent");
if (!["median", "count"].includes(args.statistic)) {
  usageError(
    "--statistic must be `median` (machine-dependent targets) or `count` (deterministic ones)"
  );
}
if (!/^[0-9a-f]{7,40}$/.test(args.baselineSha)) {
  usageError(`--baseline-sha must be a clean commit sha, got "${args.baselineSha}"`);
}

const guards = args.guards.map((entry) => {
  const at = entry.lastIndexOf(":");
  if (at < 1) usageError(`--guard expects NAME:TOLERANCE_PCT, got "${entry}"`);
  const name = entry.slice(0, at);
  const tolerance = Number(entry.slice(at + 1));
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    usageError(`--guard tolerance must be a non-negative percent, got "${entry}"`);
  }
  return { name, tolerancePct: tolerance, class: classifyTarget(name) };
});

// The tail statistic is not a decision the loop gets to make per target: at the
// iteration counts this harness runs, a p95 IS one of the two largest samples.
// Covering the 95th percentile with 95% confidence needs ln(.05)/ln(.95) ≈ 59
// samples, and a p99 needs ~299.
if (/\.(p95Ms|p99Ms|maxMs)$/.test(args.target) && iterations < 59) {
  usageError(
    `--target ${args.target} is a tail statistic and --iterations is ${iterations}. ` +
      "A p95 needs ~59 samples to be an estimate rather than the second-largest reading, and a " +
      "p99 needs ~299. Target the median (`p50Ms`), a metric, or raise the iteration count."
  );
}

if (existsSync(recordPath) && !args.force) {
  console.error(
    `${recordPath} already exists.\n\n` +
      "That file is the lock. Rewriting it after a measurement is how a threshold gets " +
      "re-chosen to fit a result, so this refuses by default. If the target genuinely has to " +
      "change, the old decision is a disproof worth recording: start a new --dir for the new " +
      "target and say in the report why the first was abandoned. `--force` exists for a record " +
      "written wrong before any arm was measured, and its use is reported."
  );
  process.exit(2);
}

const { digest, fileCount } = harnessDigest();
const targetClass = classifyTarget(args.target);
const record = {
  createdAt: new Date().toISOString(),
  scenario: args.scenario,
  target: args.target,
  targetClass,
  crossMachineComparable: isMachineIndependent(targetClass),
  higherIsBetter: args.higherIsBetter,
  predicates: [...args.predicates].sort(),
  guards,
  mode: args.mode,
  iterations,
  warmups,
  statistic: args.statistic,
  thresholdPct: threshold,
  baselineSha: args.baselineSha,
  harnessDigest: digest,
  harnessFileCount: fileCount,
  note: args.note ?? null,
  forced: args.force && existsSync(recordPath),
};

mkdirSync(args.dir, { recursive: true });
writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);

console.log(`Precommitted → ${recordPath}\n`);
console.log(`  scenario     ${record.scenario}`);
console.log(
  `  target       ${record.target}  (${record.targetClass}, ${record.higherIsBetter ? "higher" : "lower"} is better)`
);
console.log(`  predicates   ${record.predicates.join(", ")}`);
console.log(
  `  guards       ${guards.length === 0 ? "(none)" : guards.map((g) => `${g.name} ±${g.tolerancePct}%`).join(", ")}`
);
console.log(
  `  protocol     mode ${record.mode} · ${record.iterations} iterations · ${record.warmups} warmups`
);
console.log(`  statistic    ${record.statistic} · threshold ${record.thresholdPct}%`);
console.log(`  baseline     ${record.baselineSha}`);
console.log(`  harness      ${digest.slice(0, 16)}… over ${fileCount} files`);
console.log(
  `  cross-machine ${record.crossMachineComparable ? "YES — this target compares across machines and operating systems" : "NO — every machine needs its own before/after pair and its own percentage"}`
);
