#!/usr/bin/env node
/**
 * The one check in the optimize loop whose exit code can be trusted.
 *
 * `npm run perf compare` exits 0 when it REFUSES, and `npm run perf <mode>` exits
 * 0 when the apparatus is broken. An unattended run reading exit codes therefore
 * sees success everywhere. This reads the summary files itself and fails loudly,
 * so the loop has one gate that does not depend on an agent noticing a word in a
 * table cell.
 *
 * It is a reader, never a writer: it opens JSON files and exits. Nothing here
 * measures anything, so it is not a measurement surface.
 *
 * Two modes.
 *
 * PAIR — is this before/after pair a result at all?
 *   node .agents/skills/optimize/check-pair.mjs \
 *     --scenario PERF-105 \
 *     --target metricStats.idleGitSpawns.max \
 *     --predicate detectionMisses [--predicate refreshMisses] \
 *     [--expect-before-sha <sha>] [--expect-after-sha <sha>] \
 *     before.json after.json
 *
 * AB — does the interleaved A/B support a claim? Computes the champion-vs-champion
 * drift, the index-paired results and the median-to-median delta, and rules on all
 * three conditions itself, because that arithmetic is exactly the judgement call an
 * agent invested in its own hypothesis gets wrong at hour four.
 *   node .agents/skills/optimize/check-pair.mjs ab \
 *     --scenario PERF-105 \
 *     --target metricStats.idleGitSpawns.max \
 *     --predicate detectionMisses \
 *     --threshold 5 [--higher-is-better] \
 *     --champ champ1.json --champ champ2.json --champ champ3.json \
 *     --cand cand1.json --cand cand2.json --cand cand3.json
 *
 * `--threshold` is required and echoed in the output. A threshold this tool
 * accepted after the numbers were on screen would only move the self-deception one
 * step later, so it has to be named on the command line that produces the verdict.
 *
 * Exit codes:
 *   0  every check passed — PAIR: comparable and healthy. AB: CLAIM.
 *   1  at least one check FAILED — the files are not a result. Fix and re-measure.
 *   2  usage error
 *   3  everything else passed, but `sourceSha` is missing, so the files cannot be
 *      tied to a checkpoint. Only proceed when every arm was measured in this
 *      session, interleaved, and say so in the report.
 *   4  AB only: measured cleanly, but at least one of the three conditions failed.
 *      NO CLAIM. Distinct from 1 so an unattended caller cannot read a sound
 *      measurement that disproved the hypothesis as a broken one worth retrying.
 *
 * Precedence when several apply: 1 beats 4 beats 3.
 */

import { readFileSync } from "node:fs";

const USAGE =
  "usage: check-pair.mjs --scenario ID --target PATH --predicate NAME [...] A.json B.json\n" +
  "       check-pair.mjs ab --scenario ID --target PATH --predicate NAME --threshold PCT " +
  "--champ F [...] --cand F [...]";

function usageError(message) {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

const SINGLE = {
  "--scenario": "scenario",
  "--target": "target",
  "--expect-before-sha": "expectBeforeSha",
  "--expect-after-sha": "expectAfterSha",
  "--threshold": "threshold",
};
const REPEATED = {
  "--predicate": "predicates",
  "--champ": "champs",
  "--cand": "cands",
};

function parseArgs(argv) {
  const out = { predicates: [], champs: [], cands: [], files: [], higherIsBetter: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--higher-is-better") {
      out.higherIsBetter = true;
    } else if (REPEATED[arg]) {
      const value = argv[(i += 1)];
      if (value === undefined) usageError(`${arg} expects a value`);
      out[REPEATED[arg]].push(value);
    } else if (SINGLE[arg]) {
      const value = argv[(i += 1)];
      if (value === undefined) usageError(`${arg} expects a value`);
      out[SINGLE[arg]] = value;
    } else if (arg.startsWith("--")) {
      usageError(`unknown flag ${arg}`);
    } else {
      out.files.push(arg);
    }
  }
  if (!out.scenario) usageError("--scenario is required");
  if (!out.target) usageError("--target is required");
  if (out.predicates.length === 0) usageError("--predicate is required at least once");
  return out;
}

const checks = [];
function check(ok, label, detail) {
  checks.push({ ok, label, detail });
}

function load(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`cannot read ${path}: ${String(error)}`);
    process.exit(2);
  }
}

function selectionOf(summary) {
  const selection = summary.protocol?.scenarioSelection;
  if (selection === undefined) return "(no protocol block)";
  if (selection === null) return "(whole matrix)";
  return [...selection].sort().join(",");
}

function resolve(aggregate, path) {
  let node = aggregate;
  for (const key of path.split(".")) {
    if (node === null || node === undefined || typeof node !== "object") return undefined;
    node = node[key];
  }
  return node;
}

/**
 * Every arm against the first, field by field, so a failure names the field
 * rather than only saying "not comparable".
 */
function sameAcross(label, arms, get, describe = (value) => String(value)) {
  const values = arms.map((arm) => get(arm.summary));
  const ok = values.every((value) => value === values[0]);
  const detail = ok ? describe(values[0]) : [...new Set(values.map(describe))].join(" vs ");
  check(ok, label, detail);
}

/**
 * Protocol, machine and toolchain. A run that differs here did not do the same
 * work, and `perf compare` refuses on only some of it: scenario selection is
 * recorded and never checked, and a git upgrade moves subprocess counts on its own
 * with no source change at all.
 */
function comparabilityChecks(arms) {
  sameAcross("mode", arms, (s) => s.mode);
  sameAcross("machine label", arms, (s) => s.environment?.machineLabel);
  sameAcross("platform", arms, (s) => s.environment?.platform);
  sameAcross("arch", arms, (s) => s.environment?.arch);
  check(
    arms.every((arm) => Boolean(arm.summary.protocol)),
    "protocol recorded on every arm",
    arms.every((arm) => arm.summary.protocol) ? "yes" : "a summary predates protocol recording"
  );
  sameAcross(
    "--iterations",
    arms,
    (s) => s.protocol?.iterations ?? null,
    (v) => (v === null ? "(per-mode default)" : String(v))
  );
  sameAcross(
    "--warmups",
    arms,
    (s) => s.protocol?.warmups ?? null,
    (v) => (v === null ? "(per-scenario default)" : String(v))
  );
  sameAcross("--scenario selection", arms, selectionOf);
  sameAcross("node version", arms, (s) => s.environment?.nodeVersion);
  sameAcross("git version", arms, (s) => s.environment?.gitVersion ?? null);
  sameAcross("electron version", arms, (s) => s.environment?.electronVersion ?? null);
}

/** Returns the arm's target value, or null when the arm is unusable. */
function healthChecks(arm, args) {
  const aggregate = (arm.summary.aggregates ?? []).find((entry) => entry.id === args.scenario);
  if (!aggregate) {
    check(false, `${arm.label}: ${args.scenario} present`, `not in ${arm.path}`);
    return null;
  }

  const issues = aggregate.measurementIssues ?? [];
  check(
    issues.length === 0,
    `${arm.label}: apparatus healthy`,
    issues.length === 0 ? "no measurement issues" : issues.join("; ")
  );

  for (const predicate of args.predicates) {
    const stat = aggregate.metricStats?.[predicate];
    if (!stat) {
      // A miss count emitted only on the failure path supplies nothing on a
      // healthy run, so there is nothing to check and the scenario cannot be
      // optimised against.
      check(false, `${arm.label}: predicate ${predicate}`, "not emitted at all");
      continue;
    }
    // BOTH halves. `count` tallies the iterations that emitted the metric, not
    // the iterations that ran, so one healthy sample among fifteen absent ones
    // aggregates to `max: 0` and reads as perfect health.
    check(
      stat.count === aggregate.runs && stat.max === 0,
      `${arm.label}: predicate ${predicate}`,
      `count ${stat.count}/${aggregate.runs}, max ${stat.max}`
    );
  }

  const value = resolve(aggregate, args.target);
  const usable = typeof value === "number" && Number.isFinite(value);
  check(
    usable,
    `${arm.label}: target ${args.target}`,
    value === undefined ? "does not resolve" : String(value)
  );
  const metricName = args.target.startsWith("metricStats.") ? args.target.split(".")[1] : null;
  if (metricName) {
    const stat = aggregate.metricStats?.[metricName];
    if (stat) {
      check(
        stat.count === aggregate.runs,
        `${arm.label}: target ${metricName} emitted every iteration`,
        `count ${stat.count}/${aggregate.runs}`
      );
    }
  }
  return usable ? value : null;
}

function shaOf(arm) {
  return arm.summary.environment?.sourceSha ?? null;
}

function report(extraLines, exitCode, closing) {
  for (const entry of checks) {
    console.log(`${entry.ok ? "PASS" : "FAIL"}  ${entry.label} — ${entry.detail}`);
  }
  for (const line of extraLines) console.log(line);
  if (exitCode === 0) console.log(closing);
  else console.error(closing);
  process.exit(exitCode);
}

const PROVENANCE_NOTE =
  "\nNo `sourceSha` on at least one arm: these files cannot be tied to a checkpoint. " +
  "Only proceed if every arm was measured in this session, interleaved, and record " +
  "the limitation in the report.";

const argv = process.argv.slice(2);
const mode = argv[0] === "ab" ? "ab" : "pair";
const args = parseArgs(mode === "ab" ? argv.slice(1) : argv);

if (mode === "pair") {
  if (args.files.length !== 2) usageError("expected exactly two summary file paths");
  if (args.champs.length > 0 || args.cands.length > 0) {
    usageError("--champ/--cand belong to the `ab` subcommand");
  }
  const arms = [
    { label: "before", path: args.files[0], summary: load(args.files[0]) },
    { label: "after", path: args.files[1], summary: load(args.files[1]) },
  ];

  comparabilityChecks(arms);

  const [beforeSha, afterSha] = arms.map(shaOf);
  if (args.expectBeforeSha) {
    check(
      beforeSha === args.expectBeforeSha,
      `before sourceSha is ${args.expectBeforeSha}`,
      beforeSha === null ? "(not recorded)" : beforeSha
    );
  }
  if (args.expectAfterSha) {
    check(
      afterSha === args.expectAfterSha,
      `after sourceSha is ${args.expectAfterSha}`,
      afterSha === null ? "(not recorded)" : afterSha
    );
  }

  const values = arms.map((arm) => healthChecks(arm, args));
  // A zero on the before side means the scenario measured nothing, which is this
  // loop's most dangerous starting state: it looks like a perfect score and every
  // later "improvement" is measured against nothing.
  check(
    values[0] !== 0,
    "before-side target is not degenerate",
    `${args.target} = ${String(values[0])}`
  );

  const failed = checks.filter((entry) => !entry.ok);
  if (failed.length > 0) {
    report([], 1, `\n${failed.length} check(s) FAILED — this pair is not a result.`);
  }
  if (beforeSha === null || afterSha === null) report([], 3, PROVENANCE_NOTE);
  report([], 0, "\nAll checks passed.");
}

if (!args.threshold) usageError("--threshold is required for `ab`, in percent, e.g. --threshold 5");
const threshold = Number(args.threshold);
if (!Number.isFinite(threshold) || threshold <= 0) {
  usageError("--threshold must be a positive number of percent");
}
if (args.files.length > 0) usageError("`ab` takes arms via --champ/--cand, not positionally");
if (args.champs.length !== args.cands.length) {
  usageError("`ab` needs the same number of --champ and --cand arms — they are paired by index");
}
// Odd, so the median is a real arm rather than an average of two that nothing
// measured, and at least three so a drift figure exists at all.
if (args.champs.length < 3 || args.champs.length % 2 === 0) {
  usageError("`ab` needs an odd number of pairs, at least 3");
}

const champArms = args.champs.map((path, i) => ({
  label: `champ${i + 1}`,
  path,
  summary: load(path),
}));
const candArms = args.cands.map((path, i) => ({
  label: `cand${i + 1}`,
  path,
  summary: load(path),
}));

comparabilityChecks([...champArms, ...candArms]);

const champShas = [...new Set(champArms.map(shaOf))];
const candShas = [...new Set(candArms.map(shaOf))];
const provenanceMissing = [...champShas, ...candShas].includes(null);
if (!provenanceMissing) {
  check(champShas.length === 1, "champion arms are one tree", champShas.join(" vs "));
  check(candShas.length === 1, "candidate arms are one tree", candShas.join(" vs "));
  // The failure this catches is forgetting to commit the candidate: six arms of
  // the same tree produce a tidy and entirely fictitious A/B.
  check(
    champShas[0] !== candShas[0],
    "champion and candidate are different trees",
    champShas[0] === candShas[0] ? `both ${champShas[0]}` : `${champShas[0]} vs ${candShas[0]}`
  );
}

const champValues = champArms.map((arm) => healthChecks(arm, args));
const candValues = candArms.map((arm) => healthChecks(arm, args));
for (const [i, value] of champValues.entries()) {
  // Every percentage below divides by a champion reading.
  check(
    value !== 0,
    `champ${i + 1}: target is not degenerate`,
    `${args.target} = ${String(value)}`
  );
}

if (checks.some((entry) => !entry.ok)) {
  const failed = checks.filter((entry) => !entry.ok).length;
  report([], 1, `\n${failed} check(s) FAILED — these arms are not a result.`);
}

const pct = (value) => `${value >= 0 ? "" : "-"}${Math.abs(value).toFixed(1)}%`;
const num = (value) => String(Math.round(value * 1000) / 1000);
/** Positive means better, whichever direction "better" points. */
const improvement = (base, other) =>
  ((args.higherIsBetter ? other - base : base - other) / base) * 100;

let drift = 0;
let driftPair = "";
for (let i = 0; i < champValues.length; i += 1) {
  for (let j = i + 1; j < champValues.length; j += 1) {
    const spread = Math.abs(((champValues[j] - champValues[i]) / champValues[i]) * 100);
    if (spread >= drift) {
      drift = spread;
      driftPair = `champ${i + 1} v champ${j + 1}`;
    }
  }
}

const pairImprovements = champValues.map((value, i) => improvement(value, candValues[i]));
const wins = pairImprovements.filter((value) => value > 0).length;
const middle = (values) => [...values].sort((a, b) => a - b)[(values.length - 1) / 2];
const champMedian = middle(champValues);
const candMedian = middle(candValues);
const medianImprovement = improvement(champMedian, candMedian);
const combinations = (champValues.length * (champValues.length - 1)) / 2;

const conditions = [
  {
    ok: wins === pairImprovements.length,
    text: `candidate won every index-paired arm — ${wins}/${pairImprovements.length}`,
  },
  {
    ok: medianImprovement >= threshold,
    text: `median-to-median improvement ${pct(medianImprovement)} >= precommitted threshold ${pct(threshold)}`,
  },
  {
    ok: medianImprovement > drift,
    text: `improvement ${pct(medianImprovement)} > champion drift D ${pct(drift)}`,
  },
];

const lines = [
  "",
  `Target: ${args.target} on ${args.scenario} · ${args.higherIsBetter ? "higher" : "lower"} is better`,
  `Champion drift D: ${pct(drift)} (worst of ${combinations}, ${driftPair}) — same code on both sides, so this is the machine`,
  "",
];
for (const [i, value] of pairImprovements.entries()) {
  lines.push(
    `  pair ${i + 1}: ${num(champValues[i])} → ${num(candValues[i])}  ${pct(value)}  ${value > 0 ? "WON" : "LOST"}`
  );
}
lines.push(
  "",
  `  median arm: ${num(champMedian)} → ${num(candMedian)}  improvement ${pct(medianImprovement)}`,
  `  precommitted threshold (--threshold): ${pct(threshold)}`,
  ""
);
for (const [i, condition] of conditions.entries()) {
  lines.push(`  condition ${i + 1}  ${condition.ok ? "PASS" : "FAIL"}  ${condition.text}`);
}

const claim = conditions.every((condition) => condition.ok);
lines.push("", `VERDICT: ${claim ? "CLAIM" : "NO CLAIM"}`);

if (!claim) {
  report(
    lines,
    4,
    "\nNO CLAIM — the arms are sound and they do not support the hypothesis. This is a " +
      "complete result, not a run to retry with more pairs: extending after seeing an " +
      "unfavourable number is the same fallacy as re-choosing the threshold."
  );
}
if (provenanceMissing) report(lines, 3, PROVENANCE_NOTE);
report(lines, 0, "\nCLAIM — all three conditions hold.");
