#!/usr/bin/env node

// Compiler bailout two-tier signal flow
// ──────────────────────────────────────
// Tier 1 — Budget gate (this script): diffs dist/compiler-bailout-report.json
//   against compiler-bailout-baseline.json and fails on any per-file regression.
//   The baseline records ALL CompileError events (cosmetic + critical) so
//   nothing slips past code review. Most entries are cosmetic "Todo" noise
//   (e.g. `Todo: (BuildHIR::lowerExpression) Handle Import expressions` on
//   anonymous arrows inside `React.lazy(() => import(...))`).
//
// Tier 2 — Critical-errors triage: `npm run compiler-budget:critical` runs
//   scripts/find-critical-compiler-errors.mjs, which re-runs the React Compiler
//   across src/ with a severity: "Error" filter. It surfaces only the
//   load-bearing bailouts (the 2 out of ~196 that actually matter). Use it
//   when the budget gate fires to triage whether the new bailout is cosmetic
//   or needs attention.
//
// Update the baseline when the regression is intentional (genuine new code
// that can't be optimized, or the React Compiler adds new categories):
//   npm run compiler-budget:update
//
// Usage:
//   node scripts/check-compiler-budget.mjs                    # check mode (CI)
//   node scripts/check-compiler-budget.mjs --update           # write current report as new baseline
//   node scripts/check-compiler-budget.mjs --update --force   # bypass the shrinkage guard

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { formatBudgetSummary, writeSummary } from "./budget-summary-lib.mjs";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const REPORT_FILE = path.join(ROOT, "dist", "compiler-bailout-report.json");
const BASELINE_FILE = path.join(ROOT, "compiler-bailout-baseline.json");
const SUMMARY_FILE = path.join(ROOT, "dist", "compiler-budget-summary.md");

const COUNT_KEYS = ["success", "skip", "error", "pipeline"];
// Only these counts gate CI per file. A file that loses successes is logged
// but doesn't fail by itself (could be a deleted function or a removed
// component). However, a file *disappearing entirely* from the report after
// being in the baseline IS a hard failure — that's how silent coverage loss
// (path-normalization bug, upstream taxonomy change) sneaks past CI.
const REGRESSION_KEYS = ["skip", "error", "pipeline"];

// Refuse to overwrite the baseline in --update mode if the report shrinks by
// more than this fraction. Catches the case where a developer reflexively
// updates after a logger bug shrinks the report. Override with --force.
const UPDATE_SHRINKAGE_THRESHOLD = 0.1;

function readJson(file, label) {
  if (!existsSync(file)) {
    console.error(`::error::${label} not found at ${path.relative(ROOT, file)}`);
    if (file === REPORT_FILE) {
      console.error("   Run `npm run compiler-budget:build` first to generate the report.");
    } else {
      console.error("   Run `npm run compiler-budget:update` to create the baseline.");
    }
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
  }
}

function writeBaseline(report, { force }) {
  // Sort keys deterministically so diffs stay clean across runs. Preserve the
  // diagnostic arrays alongside the gating counts — the explicit field list
  // (no spread) prevents unintended propagation if the report shape gains
  // future fields that aren't yet vetted for the baseline.
  const sorted = Object.keys(report)
    .sort()
    .reduce((acc, k) => {
      const e = report[k];
      acc[k] = {
        success: e.success,
        skip: e.skip,
        error: e.error,
        pipeline: e.pipeline,
        errorBailouts: Array.isArray(e.errorBailouts) ? e.errorBailouts : [],
        skipReasons: Array.isArray(e.skipReasons) ? e.skipReasons : [],
        pipelineErrors: Array.isArray(e.pipelineErrors) ? e.pipelineErrors : [],
      };
      return acc;
    }, {});

  // Sanity guard: if the previous baseline existed and the new report covers
  // significantly fewer files, refuse to overwrite unless the caller passed
  // --force. This protects against a logger bug or path-normalization
  // regression silently shrinking coverage.
  if (existsSync(BASELINE_FILE) && !force) {
    let priorCount = 0;
    try {
      const prior = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
      if (prior && typeof prior === "object" && !Array.isArray(prior)) {
        priorCount = Object.keys(prior).length;
      }
    } catch {
      // Unparseable prior baseline — let the update proceed; the previous
      // baseline is unusable anyway.
    }
    const newCount = Object.keys(sorted).length;
    if (priorCount > 0) {
      const drop = (priorCount - newCount) / priorCount;
      if (drop > UPDATE_SHRINKAGE_THRESHOLD) {
        console.error(
          `::error::refusing to update baseline — file count would drop from ${priorCount} to ${newCount} (${(drop * 100).toFixed(1)}% shrinkage > ${(UPDATE_SHRINKAGE_THRESHOLD * 100).toFixed(0)}% threshold).`
        );
        console.error(
          "   This usually means the build emitted a partial report (logger bug, path-normalization regression, or React Compiler upstream change)."
        );
        console.error("   If the shrinkage is intentional, re-run with --force.");
        process.exit(1);
      }
    }
  }

  writeFileSync(BASELINE_FILE, JSON.stringify(sorted, null, 2) + "\n");
  const totals = COUNT_KEYS.reduce((t, k) => {
    t[k] = Object.values(sorted).reduce((s, e) => s + e[k], 0);
    return t;
  }, {});
  console.log(
    `[check-compiler-budget] baseline updated: ${Object.keys(sorted).length} files (success=${totals.success}, skip=${totals.skip}, error=${totals.error}, pipeline=${totals.pipeline})`
  );
}

// Build and write the markdown summary for downstream PR-comment aggregation.
// Called on both the pass and fail paths so the aggregated comment always
// carries a compiler-budget block.
function emitSummary(report, { regressions, improvements, successDrops, newClean, disappeared }) {
  const totals = COUNT_KEYS.reduce((t, k) => {
    t[k] = Object.values(report).reduce((s, e) => s + e[k], 0);
    return t;
  }, {});
  const ok = regressions.length === 0 && disappeared.length === 0;
  const fileCount = Object.keys(report).length;

  const headerLine = ok
    ? `${fileCount} files (success=${totals.success}, skip=${totals.skip}, error=${totals.error}, pipeline=${totals.pipeline})`
    : `${regressions.length} regression(s), ${disappeared.length} missing baseline entries`;

  const sections = [
    {
      heading: "Totals",
      body: [
        `- files:    ${fileCount}`,
        `- success:  ${totals.success}`,
        `- skip:     ${totals.skip}`,
        `- error:    ${totals.error}`,
        `- pipeline: ${totals.pipeline}`,
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
      heading: "Missing baseline entries",
      body: disappeared.map((file) => `- \`${file}\` — no longer present in build output`),
    });
  }
  if (improvements.length > 0) {
    sections.push({
      heading: "Improvements",
      body: improvements.map(({ file, base, entry, improvedKeys }) => {
        const changes = improvedKeys.map((k) => `${k} ${base[k]} → ${entry[k]}`).join(", ");
        return `- \`${file}\` — ${changes}`;
      }),
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

function main() {
  const isUpdate = process.argv.includes("--update");
  const force = process.argv.includes("--force");

  const report = readJson(REPORT_FILE, "compiler bailout report");
  validateShape(report, "report", REPORT_FILE);

  if (isUpdate) {
    writeBaseline(report, { force });
    return;
  }

  const baseline = readJson(BASELINE_FILE, "compiler bailout baseline");
  validateShape(baseline, "baseline", BASELINE_FILE);

  const regressions = [];
  const improvements = [];
  const successDrops = [];
  const newClean = [];

  for (const [file, entry] of Object.entries(report)) {
    const base = baseline[file];
    if (!base) {
      // New file in the report. Allowed only if it has zero bailouts.
      const bailouts = REGRESSION_KEYS.reduce((s, k) => s + entry[k], 0);
      if (bailouts > 0) {
        regressions.push({
          file,
          deltas: REGRESSION_KEYS.filter((k) => entry[k] > 0).map((k) => ({
            key: k,
            from: 0,
            to: entry[k],
          })),
          isNew: true,
        });
      } else {
        newClean.push(file);
      }
      continue;
    }
    const deltas = REGRESSION_KEYS.filter((k) => entry[k] > base[k]).map((k) => ({
      key: k,
      from: base[k],
      to: entry[k],
    }));
    if (deltas.length > 0) regressions.push({ file, deltas, isNew: false });
    const improvedKeys = REGRESSION_KEYS.filter((k) => entry[k] < base[k]);
    if (improvedKeys.length > 0) improvements.push({ file, base, entry, improvedKeys });
    if (entry.success < base.success) {
      successDrops.push({ file, from: base.success, to: entry.success });
    }
  }

  // Files that vanished from the report ARE failures: the most likely cause
  // is a path-normalization regression or an upstream React Compiler taxonomy
  // change silently shrinking coverage. Genuine deletions are handled via
  // `npm run compiler-budget:update`, which is the symmetric escape hatch
  // used for intentional regressions.
  const disappeared = Object.keys(baseline).filter((f) => !(f in report));

  // Print informational notices first.
  for (const file of newClean) {
    console.log(`::notice file=${file}::compiled cleanly (new file in report)`);
  }
  for (const { file, base, entry, improvedKeys } of improvements) {
    const changes = improvedKeys.map((k) => `${k} ${base[k]} → ${entry[k]}`).join(", ");
    console.log(`::notice file=${file}::compiler bailouts decreased (${changes})`);
  }
  for (const { file, from, to } of successDrops) {
    console.log(`::notice file=${file}::compile success count dropped ${from} → ${to}`);
  }

  emitSummary(report, { regressions, improvements, successDrops, newClean, disappeared });

  if (regressions.length === 0 && disappeared.length === 0) {
    const totals = COUNT_KEYS.reduce((t, k) => {
      t[k] = Object.values(report).reduce((s, e) => s + e[k], 0);
      return t;
    }, {});
    const improvedCount = improvements.length;
    const refreshHint =
      improvedCount > 0 || newClean.length > 0
        ? "  (consider `npm run compiler-budget:update` to capture improvements)"
        : "";
    console.log(
      `[check-compiler-budget] OK — ${Object.keys(report).length} files, success=${totals.success}, skip=${totals.skip}, error=${totals.error}, pipeline=${totals.pipeline}${refreshHint}`
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
      `::error file=${file}::baseline entry no longer present in build output (deleted file? path-normalization regression? upstream React Compiler change?)`
    );
  }
  const total = regressions.length + disappeared.length;
  console.error(
    `\n[check-compiler-budget] FAILED — ${total} issue(s): ${regressions.length} regression(s), ${disappeared.length} missing baseline entries. ` +
      `For investigation, run \`npm run compiler-budget:critical\` to list only critical (Error-severity) compiler diagnostics. ` +
      `If the change is intentional (e.g. files were genuinely deleted), run \`npm run compiler-budget:update\` to refresh the baseline.`
  );
  process.exit(1);
}

main();
