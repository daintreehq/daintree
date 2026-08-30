#!/usr/bin/env node
/**
 * The one check in the optimize loop whose exit code can be trusted.
 *
 * `npm run perf compare` exits 0 when it REFUSES, and `npm run perf <mode>` exits
 * 0 when the apparatus is broken. An unattended run reading exit codes therefore
 * sees success everywhere. This reads the two summary files itself and fails
 * loudly, so the loop has one gate that does not depend on an agent noticing a
 * word in a table cell.
 *
 * It is a reader, never a writer: it opens two JSON files and exits. Nothing here
 * measures anything, so it is not a measurement surface.
 *
 * Usage:
 *   node .agents/skills/optimize/check-pair.mjs \
 *     --scenario PERF-105 \
 *     --target metricStats.idleGitSpawns.max \
 *     --predicate detectionMisses \
 *     [--predicate refreshMisses] \
 *     [--expect-before-sha <sha>] [--expect-after-sha <sha>] \
 *     before.json after.json
 *
 * Exit codes:
 *   0  every check passed — the pair is comparable and both sides are healthy
 *   1  at least one check FAILED — do not read the comparison as a result
 *   2  usage error
 *   3  everything else passed, but neither file records a `sourceSha`, so it
 *      cannot be tied to a checkpoint. Only proceed when BOTH arms were measured
 *      in this session, interleaved, and say so in the report.
 */

import { readFileSync } from "node:fs";

const USAGE =
  "usage: check-pair.mjs --scenario ID --target PATH --predicate NAME [...] A.json B.json";

function usageError(message) {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

const takesValue = {
  "--scenario": "scenario",
  "--target": "target",
  "--expect-before-sha": "expectBeforeSha",
  "--expect-after-sha": "expectAfterSha",
};

function parseArgs(argv) {
  const out = { predicates: [], files: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--predicate") {
      const value = argv[(i += 1)];
      if (value === undefined) usageError("--predicate expects a metric name");
      out.predicates.push(value);
    } else if (takesValue[arg]) {
      const value = argv[(i += 1)];
      if (value === undefined) usageError(`${arg} expects a value`);
      out[takesValue[arg]] = value;
    } else if (arg.startsWith("--")) {
      usageError(`unknown flag ${arg}`);
    } else {
      out.files.push(arg);
    }
  }
  if (!out.scenario) usageError("--scenario is required");
  if (!out.target) usageError("--target is required");
  if (out.predicates.length === 0) usageError("--predicate is required at least once");
  if (out.files.length !== 2) usageError("expected exactly two summary file paths");
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

/** Field-by-field so the failure names the field, not just "not comparable". */
function same(label, a, b, describe = (v) => String(v)) {
  check(a === b, label, a === b ? describe(a) : `${describe(a)} vs ${describe(b)}`);
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

const args = parseArgs(process.argv.slice(2));
const [beforePath, afterPath] = args.files;
const before = load(beforePath);
const after = load(afterPath);

// A pair that is not comparable is not a result. Protocol and provenance first,
// because every row below them is meaningless once one of these is wrong.
same("mode", before.mode, after.mode);
same("machine label", before.environment?.machineLabel, after.environment?.machineLabel);
same("platform", before.environment?.platform, after.environment?.platform);
same("arch", before.environment?.arch, after.environment?.arch);

check(
  Boolean(before.protocol) && Boolean(after.protocol),
  "protocol recorded on both sides",
  before.protocol && after.protocol ? "yes" : "a summary predates protocol recording"
);
same(
  "--iterations",
  before.protocol?.iterations ?? null,
  after.protocol?.iterations ?? null,
  (v) => (v === null ? "(per-mode default)" : String(v))
);
same("--warmups", before.protocol?.warmups ?? null, after.protocol?.warmups ?? null, (v) =>
  v === null ? "(per-scenario default)" : String(v)
);
// `perf compare` does not refuse on this, despite selection being recorded: a
// filtered run and a whole-matrix run share a machine and a protocol but did not
// do the same work, and neighbouring scenarios change cache and process state.
same("--scenario selection", selectionOf(before), selectionOf(after));

// A toolchain move is a confound, not a result: a git upgrade changes subprocess
// counts and an Electron bump changes IPC cost with no source change at all.
same("node version", before.environment?.nodeVersion, after.environment?.nodeVersion);
same("git version", before.environment?.gitVersion ?? null, after.environment?.gitVersion ?? null);
same(
  "electron version",
  before.environment?.electronVersion ?? null,
  after.environment?.electronVersion ?? null
);

const beforeSha = before.environment?.sourceSha ?? null;
const afterSha = after.environment?.sourceSha ?? null;
const provenanceMissing = beforeSha === null || afterSha === null;
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

for (const [side, summary, path] of [
  ["before", before, beforePath],
  ["after", after, afterPath],
]) {
  const aggregate = (summary.aggregates ?? []).find((entry) => entry.id === args.scenario);
  if (!aggregate) {
    check(false, `${side}: ${args.scenario} present`, `not in ${path}`);
    continue;
  }

  const issues = aggregate.measurementIssues ?? [];
  check(
    issues.length === 0,
    `${side}: apparatus healthy`,
    issues.length === 0 ? "no measurement issues" : issues.join("; ")
  );

  for (const predicate of args.predicates) {
    const stat = aggregate.metricStats?.[predicate];
    if (!stat) {
      // A miss count emitted only on the failure path supplies nothing on a
      // healthy run, so there is nothing to check and the scenario cannot be
      // optimised against.
      check(false, `${side}: predicate ${predicate}`, "not emitted at all");
      continue;
    }
    // BOTH halves. `count` tallies the iterations that emitted the metric, not
    // the iterations that ran, so one healthy sample among fifteen absent ones
    // aggregates to `max: 0` and reads as perfect health.
    check(
      stat.count === aggregate.runs && stat.max === 0,
      `${side}: predicate ${predicate}`,
      `count ${stat.count}/${aggregate.runs}, max ${stat.max}`
    );
  }

  const value = resolve(aggregate, args.target);
  check(
    typeof value === "number" && Number.isFinite(value),
    `${side}: target ${args.target}`,
    value === undefined ? "does not resolve" : String(value)
  );
  const metricName = args.target.startsWith("metricStats.") ? args.target.split(".")[1] : null;
  if (metricName) {
    const stat = aggregate.metricStats?.[metricName];
    if (stat) {
      check(
        stat.count === aggregate.runs,
        `${side}: target ${metricName} emitted every iteration`,
        `count ${stat.count}/${aggregate.runs}`
      );
    }
  }
  // A zero on the before side means the scenario measured nothing, which is this
  // loop's most dangerous starting state: it looks like a perfect score and
  // every later "improvement" is measured against nothing.
  if (side === "before") {
    check(value !== 0, "before-side target is not degenerate", `${args.target} = ${String(value)}`);
  }
}

for (const entry of checks) {
  console.log(`${entry.ok ? "PASS" : "FAIL"}  ${entry.label} — ${entry.detail}`);
}

const failed = checks.filter((entry) => !entry.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length} check(s) FAILED — this pair is not a result.`);
  process.exit(1);
}
if (provenanceMissing) {
  console.error(
    "\nNo `sourceSha` on at least one side: this pair cannot be tied to a checkpoint. " +
      "Only proceed if both arms were measured in this session, interleaved, and record " +
      "the limitation in the report."
  );
  process.exit(3);
}
console.log("\nAll checks passed.");
