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
 *     [--precommit .tmp/opt/<target>/precommit.json] \
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
 *     [--precommit .tmp/opt/<target>/precommit.json] \
 *     [--max-drift <pct>] [--max-cv <pct>] [--cross-machine] \
 *     --expect-champ-sha <sha> --expect-cand-sha <sha> \
 *     --champ champ1.json --champ champ2.json --champ champ3.json \
 *     --cand cand1.json --cand cand2.json --cand cand3.json
 *
 * `--threshold` is required and echoed in the output. A threshold this tool
 * accepted after the numbers were on screen would only move the self-deception one
 * step later, so it has to be named on the command line that produces the verdict.
 *
 * The verdict arithmetic is only worth anything if the six files are six runs, so
 * `ab` establishes that before it computes: every arm a distinct file, a distinct
 * content digest and a distinct `generatedAt`; the sides genuinely alternating in
 * time rather than three of one then three of the other; every arm filtered to the
 * scenario being claimed; and every arm's `sourceSha` clean and equal to the tree
 * the caller says it measured. Six copies of one thermally biased pair otherwise
 * produce a tidy CLAIM with a drift of zero.
 *
 * Exit codes:
 *   0  every check passed — PAIR: comparable and healthy. AB: CLAIM.
 *   1  at least one check FAILED — the files are not a result. Fix and re-measure.
 *   2  usage error. The split is by what the tool had to read to know: anything
 *      decidable from the command line alone (a missing flag, the same path passed
 *      as two arms, an expected sha that is not a sha) is 2; anything that needed
 *      the summaries themselves (duplicate content, a broken interleave, a dirty
 *      or mismatched sha, the wrong scenario selection) is 1.
 *   3  everything else passed, but `sourceSha` is missing, so the files cannot be
 *      tied to a checkpoint. Only proceed when every arm was measured in this
 *      session, interleaved, and say so in the report.
 *   4  AB only: measured cleanly, but at least one of the three conditions failed.
 *      NO CLAIM. Distinct from 1 so an unattended caller cannot read a sound
 *      measurement that disproved the hypothesis as a broken one worth retrying.
 *   5  AB only: the machine drifted more than `--max-drift` between champion
 *      arms, so it could not resolve a difference of the size being claimed.
 *      NOT a disproof — the hypothesis was never tested. Cool the machine,
 *      close what else is running, and measure the pair again. Distinct from 4
 *      because recording an unusable measurement as a disproof throws away a
 *      hypothesis that may well be right.
 *
 * Precedence when several apply: 1 beats 5 beats 4 beats 3.
 *
 * `--precommit` is the anti-hindsight gate. A freeform run derives its own
 * target, predicate, threshold and protocol; passing the record written by
 * `precommit.mjs` before the baseline proves those were the terms chosen BEFORE
 * any number existed, and that the measurement apparatus has not been edited
 * since. Without it the flags on this command line are simply whatever the
 * caller believes today.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { harnessDigest } from "./harness-digest.mjs";
import { classifyTarget, isMachineIndependent } from "./metric-class.mjs";

const USAGE =
  "usage: check-pair.mjs --scenario ID --target PATH --predicate NAME [...] " +
  "[--precommit REC] A.json B.json\n" +
  "       check-pair.mjs ab --scenario ID --target PATH --predicate NAME --threshold PCT " +
  "[--precommit REC] [--max-drift PCT] [--max-cv PCT] [--cross-machine] " +
  "--expect-champ-sha SHA --expect-cand-sha SHA --champ F [...] --cand F [...]";

function usageError(message) {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

const SINGLE = {
  "--scenario": "scenario",
  "--target": "target",
  "--expect-before-sha": "expectBeforeSha",
  "--expect-after-sha": "expectAfterSha",
  "--expect-champ-sha": "expectChampSha",
  "--expect-cand-sha": "expectCandSha",
  "--threshold": "threshold",
  "--precommit": "precommit",
  "--max-drift": "maxDrift",
  "--max-cv": "maxCv",
};
const REPEATED = {
  "--predicate": "predicates",
  "--champ": "champs",
  "--cand": "cands",
};

function parseArgs(argv) {
  const out = {
    predicates: [],
    champs: [],
    cands: [],
    files: [],
    higherIsBetter: false,
    crossMachine: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--higher-is-better") {
      out.higherIsBetter = true;
    } else if (arg === "--cross-machine") {
      out.crossMachine = true;
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

/** The digest travels with the summary: a copied arm is not a second measurement. */
function load(path) {
  try {
    const raw = readFileSync(path, "utf8");
    return { summary: JSON.parse(raw), digest: createHash("sha256").update(raw).digest("hex") };
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

/**
 * The terms of the claim against the record written before the baseline.
 *
 * Every field here is one an unattended run could otherwise revise after seeing
 * a number: the metric it judges, the miss counts it calls health, the size of
 * difference it calls real, and the sampling that produced it. A protocol
 * change alone can manufacture an improvement — fewer warmups leaves cold-start
 * cost in the champion arm — so the iteration and warmup counts are part of the
 * lock rather than context beside it.
 *
 * `harnessDigest` closes the last door. A benchmark edited to measure less
 * produces a smaller number with every other check still passing, because the
 * files agree with each other; only a hash taken before the edit disagrees.
 */
function precommitChecks(args, arms) {
  if (!args.precommit) return null;
  let record;
  try {
    record = JSON.parse(readFileSync(args.precommit, "utf8"));
  } catch (error) {
    console.error(`cannot read precommit record ${args.precommit}: ${String(error)}`);
    process.exit(2);
  }

  const same = (label, expected, actual) =>
    check(
      expected === actual,
      `precommit: ${label}`,
      expected === actual
        ? String(actual)
        : `precommitted ${String(expected)}, claimed ${String(actual)}`
    );

  same("scenario", record.scenario, args.scenario);
  same("target", record.target, args.target);
  same("direction", Boolean(record.higherIsBetter), args.higherIsBetter);

  const locked = [...(record.predicates ?? [])].sort().join(",");
  const claimed = [...args.predicates].sort().join(",");
  check(
    locked === claimed,
    "precommit: predicate set",
    locked === claimed ? claimed : `precommitted ${locked}, claimed ${claimed}`
  );

  if (args.threshold !== undefined) {
    const lockedPct = Number(record.thresholdPct);
    const claimedPct = Number(args.threshold);
    check(
      lockedPct === claimedPct,
      "precommit: threshold",
      lockedPct === claimedPct
        ? `${claimedPct}%`
        : `precommitted ${lockedPct}%, claimed ${claimedPct}% — a threshold re-chosen after the numbers is not a threshold`
    );
  }

  // The protocol as the runner recorded it, not as the caller remembers it.
  for (const arm of arms) {
    const iterations = arm.summary.protocol?.iterations ?? null;
    const warmups = arm.summary.protocol?.warmups ?? null;
    check(
      iterations === record.iterations,
      `precommit: ${arm.label} --iterations`,
      iterations === record.iterations
        ? String(iterations)
        : `precommitted ${record.iterations}, measured ${String(iterations)}`
    );
    check(
      warmups === record.warmups,
      `precommit: ${arm.label} --warmups`,
      warmups === record.warmups
        ? String(warmups)
        : `precommitted ${record.warmups}, measured ${String(warmups)}`
    );
    check(
      arm.summary.mode === record.mode,
      `precommit: ${arm.label} mode`,
      arm.summary.mode === record.mode
        ? String(record.mode)
        : `precommitted ${record.mode}, measured ${String(arm.summary.mode)}`
    );
  }

  const { digest, fileCount } = harnessDigest();
  check(
    digest === record.harnessDigest,
    "precommit: measurement apparatus unchanged",
    digest === record.harnessDigest
      ? `${digest.slice(0, 16)}… over ${fileCount} files`
      : `precommitted ${String(record.harnessDigest).slice(0, 16)}…, now ${digest.slice(0, 16)}… — scripts/perf or a gate script was edited during the run, so these numbers measure a different apparatus`
  );

  return record;
}

/**
 * Coefficient of variation of the scenario's own duration, per arm.
 *
 * Not the target — a stability reading for the machine while that arm ran. An
 * arm whose iterations disagree with each other by more than the difference
 * being claimed cannot support the claim, whatever the medians say, and a
 * spread that appears in one arm only is the shape of something else starting
 * on the box mid-measurement.
 */
function coefficientOfVariation(arm, scenario) {
  const aggregate = (arm.summary.aggregates ?? []).find((entry) => entry.id === scenario);
  if (!aggregate) return null;
  const { meanMs, stdDevMs } = aggregate;
  if (typeof meanMs !== "number" || typeof stdDevMs !== "number" || meanMs <= 0) return null;
  return (stdDevMs / meanMs) * 100;
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
    // All three. `count` tallies the iterations that emitted the metric, not
    // the iterations that ran, so one healthy sample among fifteen absent ones
    // aggregates to `max: 0` and reads as perfect health. And `max` alone is
    // not "every sample was zero": some predicates are signed subtractions
    // where a negative means the subject overproduced, so a mixed [-1, 0] run
    // has a max of 0 and a full count while being plainly unhealthy.
    check(
      stat.count === aggregate.runs && stat.min === 0 && stat.max === 0,
      `${arm.label}: predicate ${predicate}`,
      `count ${stat.count}/${aggregate.runs}, min ${stat.min}, max ${stat.max}`
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

// A `-dirty` sha says the measured tree was not the commit it names, so the arm
// belongs to no checkpoint at all; `-dirty-unknown` says the probe could not even
// tell. Both are the shape of forgetting to commit the candidate.
const DIRTY_SHA = /-dirty(?:-unknown)?$/;

/** Fail an arm whose sha cannot stand for a commit. Null means "not recorded", handled elsewhere. */
function checkNotDirty(label, sha) {
  if (sha === null || !DIRTY_SHA.test(sha)) return false;
  const named = sha.replace(DIRTY_SHA, "");
  const why = sha.endsWith("-dirty-unknown")
    ? "the runner could not determine whether the tree was dirty"
    : "the tree carried uncommitted changes";
  check(
    false,
    `${label}: tree is the commit it names`,
    `${sha} — ${why}, so this is not a measurement of ${named}`
  );
  return true;
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
  if (args.expectChampSha || args.expectCandSha) {
    usageError(
      "--expect-champ-sha/--expect-cand-sha belong to the `ab` subcommand; " +
        "pair mode uses --expect-before-sha/--expect-after-sha"
    );
  }
  const arms = [
    { label: "before", path: args.files[0], summary: load(args.files[0]).summary },
    { label: "after", path: args.files[1], summary: load(args.files[1]).summary },
  ];

  comparabilityChecks(arms);
  precommitChecks(args, arms);

  const [beforeSha, afterSha] = arms.map(shaOf);
  // Checked whether or not an expectation was passed. Exact equality against an
  // --expect-*-sha already rejects a dirty suffix, but only when the caller
  // supplies one; a pair compared without expectations was otherwise free to be
  // two uncommitted trees, which is the same hole `ab` closes.
  const beforeDirty = checkNotDirty("before", beforeSha);
  const afterDirty = checkNotDirty("after", afterSha);
  if (args.expectBeforeSha && !beforeDirty) {
    check(
      beforeSha === args.expectBeforeSha,
      `before sourceSha is ${args.expectBeforeSha}`,
      beforeSha === null ? "(not recorded)" : beforeSha
    );
  }
  if (args.expectAfterSha && !afterDirty) {
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
if (args.expectBeforeSha || args.expectAfterSha) {
  usageError(
    "--expect-before-sha/--expect-after-sha belong to pair mode; " +
      "`ab` uses --expect-champ-sha/--expect-cand-sha"
  );
}
if (args.files.length > 0) usageError("`ab` takes arms via --champ/--cand, not positionally");

// Default 2x the threshold. A machine whose champion arms disagree by twice the
// difference being claimed is not a quiet machine, and condition 3 would reject
// the pair anyway — but as a NO CLAIM, which records a hypothesis as disproved
// when it was never actually tested. Named on the command line so the number
// appears in the verdict rather than living only here.
const maxDrift = args.maxDrift === undefined ? threshold * 2 : Number(args.maxDrift);
if (!Number.isFinite(maxDrift) || maxDrift <= 0) {
  usageError("--max-drift must be a positive number of percent");
}
const maxCv = args.maxCv === undefined ? null : Number(args.maxCv);
if (maxCv !== null && (!Number.isFinite(maxCv) || maxCv <= 0)) {
  usageError("--max-cv must be a positive number of percent");
}

// The cross-machine leg claims one number for every operating system it ran on,
// which only holds for the deterministic classes. A duration compared across two
// machines is mostly the two machines; `scripts/perf/lib/comparability.ts` is the
// authority and `metric-class.mjs` mirrors it.
if (args.crossMachine) {
  const cls = classifyTarget(args.target);
  if (!isMachineIndependent(cls)) {
    usageError(
      `--cross-machine refuses ${args.target}: it classifies as \`${cls}\`, which is meaningful ` +
        "only against another run on the SAME machine. Counts, sizes and structural ratios travel; " +
        "durations, memory and derived ratios do not, and no amount of averaging makes them."
    );
  }
}
if (args.champs.length !== args.cands.length) {
  usageError("`ab` needs the same number of --champ and --cand arms — they are paired by index");
}
// Odd, so the median is a real arm rather than an average of two that nothing
// measured, and at least three so a drift figure exists at all.
if (args.champs.length < 3 || args.champs.length % 2 === 0) {
  usageError("`ab` needs an odd number of pairs, at least 3");
}

// Naming both trees on the command line is what ties the six arms to the two
// checkpoints being claimed. Without it any two distinct trees pass as champion
// and candidate, and nothing says which one the caller believed it was measuring.
const CLEAN_SHA = /^[0-9a-f]{7,40}$/;
for (const [flag, value] of [
  ["--expect-champ-sha", args.expectChampSha],
  ["--expect-cand-sha", args.expectCandSha],
]) {
  if (!value) {
    usageError(`${flag} is required for \`ab\` — the sha those arms were measured at`);
  }
  if (!CLEAN_SHA.test(value)) {
    usageError(
      `${flag} must be a commit sha as \`git rev-parse\` prints it, got "${value}" — ` +
        "a -dirty suffix is never a valid expectation"
    );
  }
}
if (args.expectChampSha === args.expectCandSha) {
  usageError(
    `--expect-champ-sha and --expect-cand-sha are both ${args.expectChampSha} — ` +
      "one tree cannot be an A/B against itself"
  );
}

const armPaths = new Map();
function abArm(side, index, path) {
  const label = `${side}${index + 1}`;
  const key = resolvePath(path);
  const seen = armPaths.get(key);
  if (seen) {
    usageError(
      `${seen} and ${label} are the same file (${key}) — ` +
        "each arm is one measurement, and repeating one is not a second"
    );
  }
  armPaths.set(key, label);
  const { summary, digest } = load(path);
  return { side, index, label, path, summary, digest, time: Date.parse(summary.generatedAt ?? "") };
}

const champArms = args.champs.map((path, i) => abArm("champ", i, path));
const candArms = args.cands.map((path, i) => abArm("cand", i, path));
const allArms = [...champArms, ...candArms];

comparabilityChecks(allArms);
const precommit = precommitChecks(args, allArms);
if (precommit && precommit.baselineSha && args.expectChampSha) {
  // Only informational: the champion is the branch point on round one and moves
  // with every kept hypothesis afterwards, so a mismatch is expected mid-run and
  // is a FAIL only for the headline A/B, where the caller passes the branch point
  // back in deliberately.
  const atBaseline =
    precommit.baselineSha.startsWith(args.expectChampSha) ||
    args.expectChampSha.startsWith(precommit.baselineSha);
  check(
    true,
    "precommit: champion is the baseline tree",
    atBaseline
      ? `yes — ${args.expectChampSha} (headline A/B shape)`
      : `no — champion ${args.expectChampSha}, baseline ${precommit.baselineSha} (mid-run shape)`
  );
}

/**
 * A copy under a second name is not a second run. Paths are already deduped, so
 * what is left is the same measurement supplied twice: identical bytes, or the
 * same instant stamped by the runner.
 */
function distinctAcross(label, get, describe) {
  const groups = new Map();
  for (const arm of allArms) {
    const key = get(arm);
    groups.set(key, [...(groups.get(key) ?? []), arm.label]);
  }
  const repeats = [...groups].filter(([, labels]) => labels.length > 1);
  check(
    repeats.length === 0,
    label,
    repeats.length === 0
      ? `${allArms.length} distinct`
      : repeats.map(([key, labels]) => `${labels.join(" = ")} (${describe(key)})`).join("; ")
  );
}

distinctAcross(
  "every arm is its own measurement",
  (arm) => arm.digest,
  (digest) => `identical content, sha256 ${String(digest).slice(0, 12)}`
);
distinctAcross(
  "every arm has its own generatedAt",
  (arm) => arm.summary.generatedAt ?? null,
  (stamp) => (stamp === null ? "generatedAt absent" : `both generated at ${stamp}`)
);

const untimed = allArms.filter((arm) => !Number.isFinite(arm.time));
check(
  untimed.length === 0,
  "every arm stamps a readable generatedAt",
  untimed.length === 0
    ? "yes"
    : `${untimed.map((arm) => arm.label).join(", ")} — chronology cannot be checked without it`
);

// Three champion runs then three candidate runs is the exact shape the interleave
// exists to defeat: it cannot separate the change from the hour that passed.
if (untimed.length === 0) {
  const ordered = [...allArms].sort((a, b) => a.time - b.time);
  const sequence = ordered.map((arm) => arm.label).join(" → ");
  const pairs = [];
  for (let i = 0; i < ordered.length; i += 2) pairs.push(ordered.slice(i, i + 2));

  const interleaved = pairs.every(([first, second]) => first.side !== second.side);
  check(
    interleaved,
    "champion and candidate arms alternate in time",
    interleaved
      ? sequence
      : `${sequence} — one side ran twice in a row, so this measures thermal drift as well as the change`
  );

  if (interleaved) {
    // Condition 1 below compares champ_k with cand_k. That pairing only means
    // anything if those two arms were the two runs measured back to back.
    const adjacent = pairs.every((pair, i) => pair.every((arm) => arm.index === i));
    check(
      adjacent,
      "index-paired arms were measured back to back",
      adjacent
        ? sequence
        : `${sequence} — champ<k>/cand<k> are compared as a pair, so pass --champ/--cand in measurement order`
    );

    const leaders = new Set(pairs.map((pair) => pair[0].side));
    check(
      leaders.size === 2,
      "pair order reverses at least once",
      leaders.size === 2
        ? sequence
        : `${sequence} — every pair led with ${pairs[0][0].side}; the first arm of a pair is the coldest, and a fixed order hands that handicap to the same side every time`
    );
  }
}

// Six arms of the whole matrix are not evidence about one scenario the way six
// filtered runs are: they carry every other scenario's work in the same process.
for (const arm of allArms) {
  const selection = selectionOf(arm.summary);
  check(
    selection === args.scenario,
    `${arm.label}: run filtered to ${args.scenario}`,
    selection === args.scenario
      ? `--scenario ${args.scenario}`
      : `expected selection ${args.scenario}, found ${selection}`
  );
}

let provenanceMissing = false;
for (const arm of allArms) {
  const sha = shaOf(arm);
  if (sha === null) {
    provenanceMissing = true;
    continue;
  }
  if (checkNotDirty(arm.label, sha)) continue;
  const expected = arm.side === "champ" ? args.expectChampSha : args.expectCandSha;
  check(
    sha === expected,
    `${arm.label}: sourceSha is ${expected}`,
    sha === expected ? sha : `found ${sha}`
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

const cvs = allArms.map((arm) => ({
  label: arm.label,
  cv: coefficientOfVariation(arm, args.scenario),
}));
const worstCv = cvs.reduce(
  (worst, entry) =>
    entry.cv !== null && entry.cv > worst.cv ? { label: entry.label, cv: entry.cv } : worst,
  { label: "", cv: 0 }
);
if (maxCv !== null) {
  check(
    worstCv.cv <= maxCv,
    "within-arm spread under --max-cv",
    worstCv.cv <= maxCv
      ? `worst ${worstCv.cv.toFixed(1)}% (${worstCv.label}) <= ${maxCv}%`
      : `${worstCv.label} varied ${worstCv.cv.toFixed(1)}% across its own iterations, over the ${maxCv}% allowed — that arm measured the machine, not the code`
  );
}

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
  `Drift ceiling (--max-drift): ${pct(maxDrift)}${args.maxDrift === undefined ? " (default, 2x threshold)" : ""}`,
  `Worst within-arm spread: ${worstCv.cv === 0 ? "(not computable)" : `${worstCv.cv.toFixed(1)}% on ${worstCv.label}`}${maxCv === null ? "" : ` · ceiling ${maxCv}%`}`,
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

const tooNoisy = drift > maxDrift;
const claim = conditions.every((condition) => condition.ok);
lines.push("", `VERDICT: ${tooNoisy ? "NO MEASUREMENT" : claim ? "CLAIM" : "NO CLAIM"}`);

if (tooNoisy) {
  report(
    lines,
    5,
    `\nNO MEASUREMENT — the champion arms disagree by ${pct(drift)} against a ${pct(maxDrift)} ceiling, ` +
      "so this machine could not resolve a difference of the size being claimed. The hypothesis was " +
      "NOT tested and this is not a disproof: do not revert on it and do not record it as one. Close " +
      "what else is running, let the machine cool, and measure the same pair again. If it will not " +
      "settle, the target needs more iterations per arm or a quieter machine — decide which, record " +
      "the decision, and say so in the report."
  );
}

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
