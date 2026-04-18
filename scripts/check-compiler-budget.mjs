#!/usr/bin/env node

// Compares dist/compiler-bailout-report.json (emitted by the
// reactCompilerReportPlugin in vite.config.ts) against the checked-in
// compiler-bailout-baseline.json. Fails if any file gains a new skip / error /
// pipeline-error event compared to the baseline, so silent React Compiler
// bailouts can't sneak past code review.
//
// Usage:
//   node scripts/check-compiler-budget.mjs           # check mode (CI)
//   node scripts/check-compiler-budget.mjs --update  # write current report as new baseline

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const REPORT_FILE = path.join(ROOT, "dist", "compiler-bailout-report.json");
const BASELINE_FILE = path.join(ROOT, "compiler-bailout-baseline.json");

const COUNT_KEYS = ["success", "skip", "error", "pipeline"];
// Only these counts gate CI. A file that loses successes is informational only
// (it may have been deleted, or a function was removed) — we don't fail on it.
const REGRESSION_KEYS = ["skip", "error", "pipeline"];

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

function writeBaseline(report) {
  // Sort keys deterministically so diffs stay clean across runs.
  const sorted = Object.keys(report)
    .sort()
    .reduce((acc, k) => {
      const e = report[k];
      acc[k] = { success: e.success, skip: e.skip, error: e.error, pipeline: e.pipeline };
      return acc;
    }, {});
  writeFileSync(BASELINE_FILE, JSON.stringify(sorted, null, 2) + "\n");
  const totals = COUNT_KEYS.reduce((t, k) => {
    t[k] = Object.values(sorted).reduce((s, e) => s + e[k], 0);
    return t;
  }, {});
  console.log(
    `[check-compiler-budget] baseline updated: ${Object.keys(sorted).length} files (success=${totals.success}, skip=${totals.skip}, error=${totals.error}, pipeline=${totals.pipeline})`
  );
}

function main() {
  const isUpdate = process.argv.includes("--update");

  const report = readJson(REPORT_FILE, "compiler bailout report");
  validateShape(report, "report", REPORT_FILE);

  if (isUpdate) {
    writeBaseline(report);
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

  // Files that disappeared from the report aren't failures (file deleted, or
  // moved out of compilation scope). Surface them as a notice so a stale
  // baseline can be cleaned up.
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
  for (const file of disappeared) {
    console.log(`::notice::baseline entry "${file}" no longer present in build output`);
  }

  if (regressions.length === 0) {
    const totals = COUNT_KEYS.reduce((t, k) => {
      t[k] = Object.values(report).reduce((s, e) => s + e[k], 0);
      return t;
    }, {});
    const improvedCount = improvements.length;
    const refreshHint =
      improvedCount > 0 || disappeared.length > 0 || newClean.length > 0
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
  }
  console.error(
    `\n[check-compiler-budget] FAILED — ${regressions.length} file(s) regressed. ` +
      `If the change is intentional, run \`npm run compiler-budget:update\` to refresh the baseline.`
  );
  process.exit(1);
}

main();
