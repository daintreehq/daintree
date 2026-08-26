#!/usr/bin/env node

// Compiler bailout two-tier signal flow
// ──────────────────────────────────────
// Both tiers read the SAME scan — `scripts/lib/compiler-scan.mjs` — which runs
// the React Compiler over a declared set of files on disk under the options
// `vite.config.ts` gives it. Neither tier depends on a prior `vite build`.
//
// Tier 1 — Budget gate (this script): diffs that scan against
//   compiler-bailout-baseline.json and fails on any per-file regression.
//   Severity-aware (#8892): Hint-severity "Todo" noise collapses to a per-file
//   hintCount gated by a global budget; Error+Warning bailouts are tracked
//   verbatim in errorBailouts and gated strictly (any per-file/global increase
//   or new strict category fails).
//
// Tier 2 — Critical-errors triage: `npm run compiler-budget:critical` filters
//   the same scan to severity "Error", the load-bearing subset. It used to run
//   its own Babel pass over `src/**` alone and so could not see the
//   `plugins/builtin/*/renderer/**` files this gate tracks.
//
// The gate reads the scan's file list, not just its diagnostics, which is what
// lets it tell three things apart that an event-keyed report cannot:
//   - a baseline entry whose file was deleted        → pruned, and its budget
//                                                      goes with it
//   - a baseline entry whose file is now clean       → pruned as an improvement
//   - a baseline entry whose file is still on disk
//     but was never scanned                          → FAILURE, the collector
//                                                      or the scope moved
// Conflating those is how this baseline silently stopped covering 190 files.
//
// Update the baseline when the regression is intentional (genuine new code
// that can't be optimized, or the React Compiler adds new categories):
//   npm run compiler-budget:update
//
// Usage:
//   node scripts/check-compiler-budget.mjs                    # check mode (local, not wired to CI pre-1.0)
//   node scripts/check-compiler-budget.mjs --update           # write current scan as new baseline

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  scanCompilerDiagnostics,
  getHintCount,
  getStrictBailouts,
  HINT_CATEGORIES,
} from "./lib/compiler-scan.mjs";
import { createProgressReporter } from "./lib/scan-progress.mjs";
import { formatBudgetSummary, writeSummary } from "./budget-summary-lib.mjs";

// Resolved lazily so the gate's read path never pays for Prettier.
async function formatJson(text) {
  const prettier = await import("prettier");
  const options = (await prettier.resolveConfig(BASELINE_FILE)) ?? {};
  return prettier.format(text, { ...options, filepath: BASELINE_FILE });
}

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const BASELINE_FILE = path.join(ROOT, "scripts", "baselines", "compiler-bailout-baseline.json");
// Bumped when the baseline's shape changes. A mismatch is refused rather than
// migrated: the numbers a v1 baseline holds were collected a different way and
// comparing them would report drift that isn't there.
const BASELINE_VERSION = 2;
const SUMMARY_FILE = path.join(ROOT, "dist", "compiler-budget-summary.md");

const COUNT_KEYS = ["success", "skip", "error", "pipeline"];
// Per-file count keys that gate CI directly. `error` is deliberately NOT here:
// it's the raw CompileError event count (cosmetic Hints + real Errors lumped
// together), kept for diagnostics only. Hints gate via the global hintCount
// budget; Error+Warning bailouts gate via the per-file/global strict check
// below. A file that loses successes is logged but doesn't fail by itself.
// A file *disappearing entirely* from the report after being in the baseline
// IS a hard failure — that's how silent coverage loss (path-normalization bug,
// upstream taxonomy change) sneaks past CI.
const REGRESSION_KEYS = ["skip", "pipeline"];

// Per-category counts of strict (Error+Warning) bailouts. The gate diffs these
// rather than the raw length so a count-neutral category swap (e.g. a file's
// lone Refs violation becoming a Hooks violation) still fails — that's a new
// strict violation, not a wash, and "verbatim tracking" means the taxonomy is
// load-bearing, not just the total.
function strictCategoryCounts(entry) {
  const counts = new Map();
  for (const b of getStrictBailouts(entry)) {
    counts.set(b.category, (counts.get(b.category) ?? 0) + 1);
  }
  return counts;
}

// Returns the strict categories whose per-file count increased (or newly
// appeared) in `entry` relative to `base`. Empty array = no strict regression.
// Exported for tests: this is the count-neutral swap gate, and nothing else
// distinguishes a wash from a taxonomy change.
export function regressedStrictCategories(entry, base) {
  const current = strictCategoryCounts(entry);
  const prior = strictCategoryCounts(base);
  const regressed = [];
  for (const [category, count] of current) {
    if (count > (prior.get(category) ?? 0))
      regressed.push({ category, from: prior.get(category) ?? 0, to: count });
  }
  return regressed;
}

function readJson(file, label) {
  if (!existsSync(file)) {
    console.error(`::error::${label} not found at ${path.relative(ROOT, file)}`);
    console.error("   Run `npm run compiler-budget:update` to create the baseline.");
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.error(
      `::error file=${path.relative(ROOT, file)}::failed to parse ${label}: ${err.message}`
    );
    process.exit(1);
  }
}

function validateShape(data, label, file) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    console.error(
      `::error file=${path.relative(ROOT, file)}::${label} must be a JSON object keyed by filename`
    );
    process.exit(1);
  }
  for (const [filename, entry] of Object.entries(data)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      console.error(
        `::error file=${path.relative(ROOT, file)}::${label} entry for "${filename}" must be an object`
      );
      process.exit(1);
    }
    for (const key of COUNT_KEYS) {
      if (typeof entry[key] !== "number" || entry[key] < 0 || !Number.isFinite(entry[key])) {
        console.error(
          `::error file=${path.relative(ROOT, file)}::${label} entry for "${filename}" has invalid ${key}: ${JSON.stringify(entry[key])}`
        );
        process.exit(1);
      }
    }
    // hintCount is optional for backward-compat with pre-severity baselines,
    // but when present it must be a valid non-negative finite number.
    if (
      "hintCount" in entry &&
      (typeof entry.hintCount !== "number" ||
        entry.hintCount < 0 ||
        !Number.isFinite(entry.hintCount))
    ) {
      console.error(
        `::error file=${path.relative(ROOT, file)}::${label} entry for "${filename}" has invalid hintCount: ${JSON.stringify(entry.hintCount)}`
      );
      process.exit(1);
    }
  }
}

async function writeBaseline(scan) {
  // Sort keys deterministically so diffs stay clean across runs. Preserve the
  // diagnostic arrays alongside the gating counts — the explicit field list
  // (no spread) prevents unintended propagation if the scan shape gains future
  // fields that aren't yet vetted for the baseline.
  const files = Object.keys(scan.files)
    .sort()
    .reduce((acc, k) => {
      const e = scan.files[k];
      acc[k] = {
        success: e.success,
        skip: e.skip,
        error: e.error,
        pipeline: e.pipeline,
        hintCount: getHintCount(e),
        errorBailouts: Array.isArray(e.errorBailouts) ? e.errorBailouts : [],
        skipReasons: Array.isArray(e.skipReasons) ? e.skipReasons : [],
        pipelineErrors: Array.isArray(e.pipelineErrors) ? e.pipelineErrors : [],
      };
      return acc;
    }, {});

  // The fingerprint rides along so the gate can refuse to compare numbers that
  // were collected under different options, a different scan scope, or a
  // different compiler version. The old shrinkage guard tried to catch that
  // statistically — "refuse if the file count drops more than 10%" — which
  // both blocked honest large deletions and would happily accept a 9% silent
  // loss of coverage. Stating the configuration is the check.
  const baseline = {
    version: BASELINE_VERSION,
    fingerprint: scan.fingerprint,
    // Not decoration. Without a record of how much the scan looked at, a run
    // that collects nothing is indistinguishable from a codebase that got
    // clean, and both modes accept it: check retires every entry as an
    // improvement, update writes an empty baseline over a good one.
    coverage: coverageOf(scan),
    files,
  };
  // Written through Prettier rather than raw `JSON.stringify`, which always
  // expands short arrays and so produced a file that `npm run check`'s
  // format gate immediately rejected — an update that fails the repo's own
  // checks is an update nobody runs.
  writeFileSync(BASELINE_FILE, await formatJson(JSON.stringify(baseline, null, 2)));

  const totals = COUNT_KEYS.reduce((t, k) => {
    t[k] = Object.values(files).reduce((sum, e) => sum + e[k], 0);
    return t;
  }, {});
  const hintTotal = Object.values(files).reduce((sum, e) => sum + getHintCount(e), 0);
  const strictTotal = Object.values(files).reduce((sum, e) => sum + getStrictBailouts(e).length, 0);
  console.log(
    `[check-compiler-budget] baseline updated: ${Object.keys(files).length} files with diagnostics ` +
      `out of ${scan.scanned.length} scanned (success=${totals.success}, skip=${totals.skip}, ` +
      `hints=${hintTotal}, strictErrors=${strictTotal}, pipeline=${totals.pipeline})`
  );
}

/**
 * Sort baseline entries that produced nothing this run into the three things
 * they can actually be.
 *
 * Exported for tests: this is the judgement the whole rewrite turns on, and
 * getting it wrong in either direction is what rotted the old baseline —
 * failing on deletions drove people to hand-edit, and accepting everything
 * would let coverage vanish silently.
 */
export function classifyBaselineEntries({ baselineFiles, reportFiles, scan, fileExists }) {
  // Files the scan reached a decision about: either it compiled them, or its
  // source filter deliberately rejected them. A baseline file in neither list
  // was never actually looked at.
  const decidedSet = new Set([...scan.scanned, ...scan.filtered]);
  const deletedFiles = [];
  const cleanedFiles = [];
  const uncovered = [];
  for (const file of Object.keys(baselineFiles)) {
    if (file in reportFiles) continue;
    if (!fileExists(file)) {
      deletedFiles.push(file);
    } else if (decidedSet.has(file)) {
      // Scanned and clean, or rejected by the source filter because it no
      // longer holds anything the compiler recognises as React. Both mean the
      // file has nothing left to report, which is an improvement.
      cleanedFiles.push(file);
    } else {
      // On disk, but outside the declared scan set entirely. Either the scope
      // moved or the collector lost it — both mean this gate is no longer
      // covering what its baseline claims it covers.
      uncovered.push(file);
    }
  }
  return { deletedFiles, cleanedFiles, uncovered };
}

/**
 * How far the scan's coverage fell short of what the baseline implies should
 * still be there, after allowing for files that were legitimately deleted.
 * Returns 0 when there is nothing to compare against.
 */
export function coverageShortfall({ baselineFiles, baselineCoverage, scannedCount, fileExists }) {
  if (!baselineCoverage || typeof baselineCoverage.scanned !== "number") return 0;
  if (baselineCoverage.scanned === 0) return 0;
  const keys = Object.keys(baselineFiles ?? {});
  const deleted = keys.filter((f) => !fileExists(f)).length;
  const expected = baselineCoverage.scanned - deleted;
  if (expected <= 0) return 0;
  return (expected - scannedCount) / expected;
}

function reportBaselineVersionMismatch(baseline) {
  console.error(
    `::error::baseline is version ${baseline?.version ?? "1 (unversioned)"}, this gate reads version ${BASELINE_VERSION}.`
  );
  console.error(
    "   The older baseline was collected from the bundler's module graph rather than a scan, so its numbers are not comparable."
  );
  console.error("   Run `npm run compiler-budget:update` to write a comparable one.");
  process.exit(1);
}

function coverageOf(scan) {
  return {
    discovered: scan.discovered.length,
    scanned: scan.scanned.length,
    filtered: scan.filtered.length,
    withEvents: Object.keys(scan.files).length,
  };
}

// The floor under everything else. A scan that compiled files but recorded no
// events at all has lost its logger, and every downstream comparison would
// read that as the whole repo becoming clean.
function assertScanLiveness(scan) {
  if (scan.scanned.length === 0) {
    console.error(
      "::error::compiler scan matched no files — the scan patterns match nothing in this checkout."
    );
    process.exit(1);
  }
  if (Object.keys(scan.files).length === 0) {
    console.error(
      `::error::compiler scan compiled ${scan.scanned.length} file(s) but recorded zero diagnostics — the logger is not connected.`
    );
    console.error(
      "   Every baseline entry would otherwise look like it had been cleaned up. Refusing to report a budget."
    );
    process.exit(1);
  }
}

// Coverage may shrink for honest reasons (files deleted), so the guard is
// measured against what the baseline expected to still be there. This replaces
// the old flat 10%-of-file-count guard, which both blocked honest large
// deletions and would have accepted a 9% silent loss.
const COVERAGE_COLLAPSE_THRESHOLD = 0.1;

function assertCoverageHolds(baseline, scan, { isUpdate, acceptCoverageDrop }) {
  const drop = coverageShortfall({
    baselineFiles: baseline?.files,
    baselineCoverage: baseline?.coverage,
    scannedCount: scan.scanned.length,
    fileExists: (file) => existsSync(path.join(ROOT, file)),
  });
  if (drop <= COVERAGE_COLLAPSE_THRESHOLD) return;
  // The shortfall is measured against the baseline's *scanned* count, but only
  // files that had diagnostics are named in it, so deleting a large directory
  // of clean files reads as a collapse the guard cannot attribute. Without an
  // escape, the only way through is hand-editing `coverage.scanned` — the
  // exact incentive this gate exists to remove. Check mode stays fail-closed.
  if (isUpdate && acceptCoverageDrop) {
    console.warn(
      `[check-compiler-budget] coverage is ${(drop * 100).toFixed(1)}% short of what the baseline implies, accepted via --accept-coverage-drop.`
    );
    return;
  }
  console.error(
    `::error::compiler scan coverage collapsed — scanned ${scan.scanned.length} file(s), ${(drop * 100).toFixed(1)}% short of what the baseline implies should still be there.`
  );
  console.error(
    "   That is a scan-set or collector problem, not a code change. Fix the scan before" +
      (isUpdate ? " writing a baseline over the good one." : " trusting this result.")
  );
  if (isUpdate) {
    console.error(
      "   If the shortfall is an honest bulk deletion of clean files, re-run with --accept-coverage-drop."
    );
  }
  process.exit(1);
}

// A scan that could not read or parse a file is not a scan with fewer
// diagnostics — it is a scan with a hole in it, and a hole reports as "clean".
// Both modes refuse to proceed on one.
function assertScanComplete(scan) {
  if (scan.failures.length === 0) return;
  for (const { file, stage, message } of scan.failures) {
    console.error(`::error file=${file}::compiler scan failed at ${stage}: ${message}`);
  }
  console.error(
    `::error::${scan.failures.length} file(s) could not be scanned — refusing to report a budget over an incomplete scan.`
  );
  process.exit(1);
}

// Every CompileError event must be accounted for by the two severity buckets.
// Only a shortfall is a violation: a multi-location diagnostic legitimately
// expands one event into several bucketed entries (one per `options.details`
// child), so `bucketed > error` is expected. `bucketed < error` means the
// severity split dropped something, which would silently retire debt.
function assertScanInvariants(scan) {
  for (const [file, e] of Object.entries(scan.files)) {
    const bucketed =
      getHintCount(e) + (Array.isArray(e.errorBailouts) ? e.errorBailouts.length : 0);
    if (bucketed < e.error) {
      console.error(
        `::error file=${file}::scan invariant violated — ${e.error} CompileError event(s) but only ${bucketed} bucketed by severity`
      );
      process.exit(1);
    }
  }
}

// Numbers collected under a different scope, options or compiler version are
// not comparable to the baseline's. Say so and stop, rather than reporting the
// difference as if the code had changed.
function assertFingerprintMatches(baseline, scan) {
  const before = JSON.stringify(baseline.fingerprint ?? null);
  const after = JSON.stringify(scan.fingerprint);
  if (before === after) return;
  console.error("::error::compiler scan configuration changed since the baseline was written.");
  console.error(`   baseline: ${before}`);
  console.error(`   current:  ${after}`);
  console.error(
    "   The stored numbers are not comparable. Review the change, then run `npm run compiler-budget:update`."
  );
  process.exit(1);
}

// Build and write the markdown summary for downstream PR-comment aggregation.
// Called on both the pass and fail paths so the aggregated comment always
// carries a compiler-budget block.
function emitSummary(
  report,
  {
    regressions,
    improvements,
    successDrops,
    newClean,
    disappeared,
    hintBudgetExceeded,
    reportHintTotal,
    baselineHintTotal,
    reportStrictTotal,
  }
) {
  const totals = COUNT_KEYS.reduce((t, k) => {
    t[k] = Object.values(report).reduce((s, e) => s + e[k], 0);
    return t;
  }, {});
  const ok = regressions.length === 0 && disappeared.length === 0 && !hintBudgetExceeded;
  const fileCount = Object.keys(report).length;

  const failParts = [];
  if (regressions.length > 0) failParts.push(`${regressions.length} regression(s)`);
  if (disappeared.length > 0) failParts.push(`${disappeared.length} file(s) dropped out of scan`);
  if (hintBudgetExceeded) failParts.push("Hint budget exceeded");

  const headerLine = ok
    ? `${fileCount} files (success=${totals.success}, skip=${totals.skip}, hints=${reportHintTotal}, strictErrors=${reportStrictTotal}, pipeline=${totals.pipeline})`
    : failParts.join(", ");

  const sections = [
    {
      heading: "Totals",
      body: [
        `- files:        ${fileCount}`,
        `- success:      ${totals.success}`,
        `- skip:         ${totals.skip}`,
        `- hints:        ${reportHintTotal} (baseline ${baselineHintTotal})`,
        `- strictErrors: ${reportStrictTotal}`,
        `- pipeline:     ${totals.pipeline}`,
      ],
    },
  ];

  if (regressions.length > 0) {
    sections.push({
      heading: "Regressions",
      body: regressions.map(({ file, deltas, isNew }) => {
        const summary = deltas.map(({ key, from, to }) => `${key}: ${from} → ${to}`).join("; ");
        const prefix = isNew ? "new file with bailouts" : "regression";
        return `- \`${file}\` — ${prefix} (${summary})`;
      }),
    });
  }
  if (disappeared.length > 0) {
    sections.push({
      heading: "Files dropped out of the scan",
      body: disappeared.map(
        (file) => `- \`${file}\` — still on disk but outside the scan; coverage was lost`
      ),
    });
  }
  if (hintBudgetExceeded) {
    sections.push({
      heading: "Hint budget",
      body: [
        `- global Hint total grew: ${baselineHintTotal} → ${reportHintTotal}`,
        `- Hint-severity bailouts are cosmetic, but new un-optimizable code likely landed.`,
      ],
    });
  }
  if (improvements.length > 0) {
    sections.push({
      heading: "Improvements",
      body: improvements.map(
        ({ file, base, entry, improvedKeys, baseStrictCount, strictCount }) => {
          const changes = improvedKeys
            .map((k) =>
              k === "strictErrors"
                ? `strictErrors ${baseStrictCount} → ${strictCount}`
                : `${k} ${base[k]} → ${entry[k]}`
            )
            .join(", ");
          return `- \`${file}\` — ${changes}`;
        }
      ),
    });
  }
  if (successDrops.length > 0) {
    sections.push({
      heading: "Success drops",
      body: successDrops.map(({ file, from, to }) => `- \`${file}\` — success ${from} → ${to}`),
    });
  }
  if (newClean.length > 0) {
    sections.push({
      heading: "New clean files",
      body: newClean.map((file) => `- \`${file}\``),
    });
  }

  const markdown = formatBudgetSummary({
    title: "Compiler bailout budget",
    status: ok ? "PASS" : "FAIL",
    headerLine,
    sections,
  });
  writeSummary(SUMMARY_FILE, markdown);
}

const USAGE = `Usage: node scripts/check-compiler-budget.mjs [--update] [--accept-coverage-drop]

  (no flags)              Scan the source tree and diff it against the committed baseline.
  --update                Scan the source tree and write the result as the new baseline.
  --accept-coverage-drop  With --update only: write the baseline even though coverage fell
                          more than 10% short, for an honest bulk deletion of clean files.
`;

function parseArgs(argv) {
  const known = new Set(["--update", "--accept-coverage-drop", "--help", "-h"]);
  const unknown = argv.filter((a) => !known.has(a));
  if (unknown.length > 0) {
    // Silently ignoring an unknown flag is how `--force` kept looking like it
    // still did something after it was removed.
    console.error(`::error::unknown argument(s): ${unknown.join(", ")}`);
    console.error(USAGE);
    process.exit(2);
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }
  return {
    isUpdate: argv.includes("--update"),
    acceptCoverageDrop: argv.includes("--accept-coverage-drop"),
  };
}

async function main() {
  const { isUpdate, acceptCoverageDrop } = parseArgs(process.argv.slice(2));

  // Read the baseline BEFORE the scan. Everything below takes ~20 seconds, and
  // failing on a missing or unreadable baseline afterwards wastes all of it.
  let priorBaseline = null;
  if (!isUpdate) {
    priorBaseline = readJson(BASELINE_FILE, "compiler bailout baseline");
    if (priorBaseline?.version !== BASELINE_VERSION) {
      reportBaselineVersionMismatch(priorBaseline);
    }
  } else if (existsSync(BASELINE_FILE)) {
    try {
      priorBaseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
    } catch {
      // An unreadable prior baseline is exactly what --update exists to
      // replace; the coverage guard below simply has nothing to compare to.
    }
  }

  const scan = await scanCompilerDiagnostics({
    onProgress: createProgressReporter("[check-compiler-budget] scanning"),
  });
  assertScanComplete(scan);
  assertScanLiveness(scan);
  assertScanInvariants(scan);
  if (priorBaseline?.version === BASELINE_VERSION) {
    assertCoverageHolds(priorBaseline, scan, { isUpdate, acceptCoverageDrop });
  }
  const report = scan.files;

  if (isUpdate) {
    await writeBaseline(scan);
    return;
  }

  const rawBaseline = priorBaseline;
  if (rawBaseline?.version !== BASELINE_VERSION) {
    reportBaselineVersionMismatch(rawBaseline);
  }
  const baseline = rawBaseline.files;
  validateShape(baseline, "baseline", BASELINE_FILE);
  assertFingerprintMatches(rawBaseline, scan);

  const regressions = [];
  const improvements = [];
  const successDrops = [];
  const newClean = [];

  for (const [file, entry] of Object.entries(report)) {
    const base = baseline[file];
    const strictCount = getStrictBailouts(entry).length;
    if (!base) {
      // New file in the report. Allowed only if it has zero gating bailouts —
      // that means zero skip/pipeline AND zero strict (Error+Warning) bailouts.
      // New-file Hints are absorbed by the global Hint budget below, not gated
      // per-file (a brand-new component with cosmetic Todo noise shouldn't fail
      // CI unless it pushes the whole-repo Hint total over its ceiling).
      const deltas = REGRESSION_KEYS.filter((k) => entry[k] > 0).map((k) => ({
        key: k,
        from: 0,
        to: entry[k],
      }));
      for (const { category, from, to } of regressedStrictCategories(entry, undefined)) {
        deltas.push({ key: `strictErrors[${category}]`, from, to });
      }
      if (deltas.length > 0) {
        regressions.push({ file, deltas, isNew: true });
      } else {
        newClean.push(file);
      }
      continue;
    }
    const baseStrictCount = getStrictBailouts(base).length;
    const deltas = REGRESSION_KEYS.filter((k) => entry[k] > base[k]).map((k) => ({
      key: k,
      from: base[k],
      to: entry[k],
    }));
    // Category-aware: catches both a count increase and a count-neutral swap
    // to a different strict category.
    for (const { category, from, to } of regressedStrictCategories(entry, base)) {
      deltas.push({ key: `strictErrors[${category}]`, from, to });
    }
    if (deltas.length > 0) regressions.push({ file, deltas, isNew: false });
    const improvedKeys = REGRESSION_KEYS.filter((k) => entry[k] < base[k]);
    if (strictCount < baseStrictCount) improvedKeys.push("strictErrors");
    if (improvedKeys.length > 0) {
      improvements.push({ file, base, entry, improvedKeys, baseStrictCount, strictCount });
    }
    if (entry.success < base.success) {
      successDrops.push({ file, from: base.success, to: entry.success });
    }
  }

  // Global Hint budget: the implicit sum of per-file hintCount across the
  // baseline is the ceiling. Per-file Hint churn is allowed to move freely (a
  // refactor that shifts Todo noise between files nets to zero), but the
  // whole-repo total may not grow — that's the signal that genuinely new
  // un-optimizable code landed. Refresh with `npm run compiler-budget:update`.
  const reportHintTotal = Object.values(report).reduce((s, e) => s + getHintCount(e), 0);
  // Entries for deleted files are excluded: their budget left with the code.
  // Carrying them is a standing credit against files that no longer exist, and
  // the stale baseline this replaced was doing exactly that.
  const baselineHintTotal = Object.entries(baseline).reduce(
    (s, [file, e]) => (existsSync(path.join(ROOT, file)) ? s + getHintCount(e) : s),
    0
  );
  const hintBudgetExceeded = reportHintTotal > baselineHintTotal;

  // A baseline entry with no diagnostics this run is three different events
  // wearing the same shape, and only one of them is a problem. Resolve it
  // against the filesystem and the scan set rather than failing all three —
  // failing a deletion is what pushed people to hand-edit this baseline
  // instead of regenerating it, and hand-editing is what let coverage rot.
  const { deletedFiles, cleanedFiles, uncovered } = classifyBaselineEntries({
    baselineFiles: baseline,
    reportFiles: report,
    scan,
    fileExists: (file) => existsSync(path.join(ROOT, file)),
  });
  const disappeared = uncovered;

  // Print informational notices first.
  for (const file of deletedFiles) {
    console.log(`::notice::${file} was deleted — baseline entry retired`);
  }
  for (const file of cleanedFiles) {
    console.log(`::notice file=${file}::no compiler diagnostics left — baseline entry retired`);
  }
  for (const file of newClean) {
    console.log(`::notice file=${file}::compiled cleanly (new file in report)`);
  }
  for (const { file, base, entry, improvedKeys, baseStrictCount, strictCount } of improvements) {
    const changes = improvedKeys
      .map((k) =>
        k === "strictErrors"
          ? `strictErrors ${baseStrictCount} → ${strictCount}`
          : `${k} ${base[k]} → ${entry[k]}`
      )
      .join(", ");
    console.log(`::notice file=${file}::compiler bailouts decreased (${changes})`);
  }
  for (const { file, from, to } of successDrops) {
    console.log(`::notice file=${file}::compile success count dropped ${from} → ${to}`);
  }

  const reportStrictTotal = Object.values(report).reduce(
    (s, e) => s + getStrictBailouts(e).length,
    0
  );

  emitSummary(report, {
    regressions,
    improvements,
    successDrops,
    newClean,
    disappeared,
    hintBudgetExceeded,
    reportHintTotal,
    baselineHintTotal,
    reportStrictTotal,
  });

  if (regressions.length === 0 && disappeared.length === 0 && !hintBudgetExceeded) {
    const totals = COUNT_KEYS.reduce((t, k) => {
      t[k] = Object.values(report).reduce((s, e) => s + e[k], 0);
      return t;
    }, {});
    // A drop in the global Hint total is an improvement worth capturing too.
    const improvedCount = improvements.length;
    const hintImproved = reportHintTotal < baselineHintTotal;
    const refreshHint =
      improvedCount > 0 || newClean.length > 0 || hintImproved
        ? "  (consider `npm run compiler-budget:update` to capture improvements)"
        : "";
    console.log(
      `[check-compiler-budget] OK — ${Object.keys(report).length} files, success=${totals.success}, skip=${totals.skip}, hints=${reportHintTotal}, strictErrors=${reportStrictTotal}, pipeline=${totals.pipeline}${refreshHint}`
    );
    return;
  }

  for (const { file, deltas, isNew } of regressions) {
    const summary = deltas.map(({ key, from, to }) => `${key}: was ${from}, now ${to}`).join("; ");
    const prefix = isNew ? "new file with compiler bailouts" : "compiler bailout regression";
    console.error(`::error file=${file}::${prefix} (${summary})`);
    // Surface the diagnostic detail captured by the plugin so failing runs
    // point at the actual cause without re-running the build locally.
    // Backward-compat: the report may pre-date the diagnostic arrays.
    const entry = report[file];
    const errorBailouts = Array.isArray(entry?.errorBailouts) ? entry.errorBailouts : [];
    const skipReasons = Array.isArray(entry?.skipReasons) ? entry.skipReasons : [];
    const pipelineErrors = Array.isArray(entry?.pipelineErrors) ? entry.pipelineErrors : [];
    if (errorBailouts.length > 0) {
      const grouped = new Map();
      for (const item of errorBailouts) {
        if (!item || typeof item !== "object") continue;
        const key = item.category || "(unknown)";
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(item.reason);
      }
      for (const [category, reasons] of grouped) {
        const sample = reasons[0];
        const more = reasons.length > 1 ? ` (+${reasons.length - 1} more)` : "";
        console.error(`   error[${category}]: ${sample}${more}`);
      }
    }
    if (skipReasons.length > 0) {
      // Dedupe so the count reflects distinct reasons; show the first unique
      // reason and indicate additional unique reasons via "(+N more)" for
      // parity with the errorBailouts category display above.
      const unique = [...new Set(skipReasons)];
      const sample = unique[0];
      const more = unique.length > 1 ? ` (+${unique.length - 1} more)` : "";
      console.error(`   skip: ${sample}${more}`);
    }
    if (pipelineErrors.length > 0) {
      console.error(`   pipeline: ${pipelineErrors[0]}`);
    }
  }
  for (const file of disappeared) {
    console.error(
      `::error file=${file}::in the baseline and still on disk, but the scan never looked at it — the scan set or the collector lost coverage`
    );
  }
  if (hintBudgetExceeded) {
    console.error(
      `::error::global Hint compiler bailout budget exceeded (was ${baselineHintTotal}, now ${reportHintTotal}). ` +
        `Hint-severity bailouts are cosmetic, but the whole-repo total grew — new un-optimizable code likely landed.`
    );
  }
  const total = regressions.length + disappeared.length + (hintBudgetExceeded ? 1 : 0);
  const parts = [
    `${regressions.length} regression(s)`,
    `${disappeared.length} file(s) dropped out of scan`,
  ];
  if (hintBudgetExceeded) parts.push("Hint budget exceeded");
  console.error(
    `\n[check-compiler-budget] FAILED — ${total} issue(s): ${parts.join(", ")}. ` +
      `For Error-severity diagnostics, run \`npm run compiler-budget:critical\`; Warning-severity bailouts (which also trip the strict gate) appear only in the errorBailouts detail printed above. ` +
      `Deleted and newly-clean files retire themselves and never appear here. If the change is intentional — an unavoidable strict, skip or pipeline bailout, new cosmetic Hint noise, or a scan set that genuinely moved — run \`npm run compiler-budget:update\` to refresh the baseline.`
  );
  // `exitCode` rather than `process.exit()`: the annotations above can be long,
  // and exiting outright can truncate buffered stdout mid-write.
  process.exitCode = 1;
}

// Only when run as a command. The pure helpers above are exported for tests,
// and importing this file must not kick off a twenty-second scan.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
