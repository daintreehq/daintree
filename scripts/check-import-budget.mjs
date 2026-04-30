#!/usr/bin/env node

// Compares dist-electron/eager-import-meta.json (emitted by
// scripts/build-import-budget.mjs) against the checked-in
// eager-import-baseline.json. Fails CI if:
//   - the count of eagerly-imported modules grows past the budget, OR
//   - a file not on the allowlist gains a sync FS / store / SQLite call on the
//     eager main-process import path.
//
// Usage:
//   node scripts/check-import-budget.mjs                    # check mode (CI)
//   node scripts/check-import-budget.mjs --update           # rewrite baseline from current report
//   node scripts/check-import-budget.mjs --update --force   # bypass shrinkage guard

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  walkEagerGraph,
  scanSyncViolations,
  compareToBaseline,
  formatBaseline,
} from "./import-budget-lib.mjs";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const METAFILE = path.join(ROOT, "dist-electron", "eager-import-meta.json");
const BASELINE_FILE = path.join(ROOT, "eager-import-baseline.json");
const ENTRY = "electron/main.ts";

// Refuse to overwrite the baseline in --update mode if the eager module count
// shrinks by more than this fraction. Catches the case where a config change
// silently cuts coverage (e.g. entry renamed, external list expanded) and a
// developer reflexively updates. Override with --force.
const UPDATE_SHRINKAGE_THRESHOLD = 0.1;

function readJson(file, label, hint) {
  if (!existsSync(file)) {
    console.error(`::error::${label} not found at ${path.relative(ROOT, file)}`);
    if (hint) console.error(`   ${hint}`);
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

function validateBaseline(baseline) {
  const errs = [];
  if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)) {
    errs.push("baseline must be a JSON object");
  } else {
    if (
      typeof baseline.count !== "number" ||
      !Number.isFinite(baseline.count) ||
      baseline.count < 0
    ) {
      errs.push("`count` must be a finite non-negative number");
    }
    if (!Array.isArray(baseline.allowlist)) {
      errs.push("`allowlist` must be an array of file paths");
    }
    if (!Array.isArray(baseline.syncViolations)) {
      errs.push("`syncViolations` must be an array");
    }
  }
  if (errs.length > 0) {
    for (const e of errs) {
      console.error(`::error file=${path.relative(ROOT, BASELINE_FILE)}::${e}`);
    }
    process.exit(1);
  }
}

function buildReport() {
  const metafile = readJson(
    METAFILE,
    "eager-import metafile",
    "Run `npm run import-budget:build` first to generate the metafile."
  );
  const modules = walkEagerGraph(metafile, ENTRY);
  if (modules.size === 0) {
    console.error(
      `::error::entry point "${ENTRY}" not found in metafile. Did the build change? Inspect ${path.relative(ROOT, METAFILE)}.`
    );
    process.exit(1);
  }
  const violations = scanSyncViolations(modules, ROOT);
  return {
    moduleCount: modules.size,
    count: modules.size,
    modules: [...modules].sort(),
    violations,
  };
}

function writeBaseline(report, { force }) {
  if (existsSync(BASELINE_FILE) && !force) {
    try {
      const prior = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
      if (prior && typeof prior.count === "number" && prior.count > 0) {
        const drop = (prior.count - report.count) / prior.count;
        if (drop > UPDATE_SHRINKAGE_THRESHOLD) {
          console.error(
            `::error::refusing to update baseline — eager import count would drop from ${prior.count} to ${report.count} (${(drop * 100).toFixed(1)}% shrinkage > ${(UPDATE_SHRINKAGE_THRESHOLD * 100).toFixed(0)}% threshold).`
          );
          console.error(
            "   This usually means the metafile was built with a different external list or entry point, hiding real modules."
          );
          console.error("   If the shrinkage is intentional, re-run with --force.");
          process.exit(1);
        }
      }
    } catch {
      // Unparseable prior baseline — let the update proceed.
    }
  }

  const allowlistFiles = new Set();
  for (const v of report.violations) allowlistFiles.add(v.file);

  const formatted = formatBaseline({
    count: report.count,
    moduleCount: report.moduleCount,
    allowlist: [...allowlistFiles],
    syncViolations: report.violations,
  });

  writeFileSync(BASELINE_FILE, JSON.stringify(formatted, null, 2) + "\n");
  console.log(
    `[check-import-budget] baseline updated: count=${formatted.count}, allowlist=${formatted.allowlist.length} file(s), syncViolations=${formatted.syncViolations.length}`
  );
}

function main() {
  const isUpdate = process.argv.includes("--update");
  const force = process.argv.includes("--force");

  const report = buildReport();

  if (isUpdate) {
    writeBaseline(report, { force });
    return;
  }

  const baseline = readJson(
    BASELINE_FILE,
    "eager-import baseline",
    "Run `npm run import-budget:update` to create the baseline."
  );
  validateBaseline(baseline);

  const { ok, errors, notices } = compareToBaseline(report, baseline);

  for (const n of notices) {
    console.log(`::notice::${n.message}`);
  }

  if (ok) {
    console.log(
      `[check-import-budget] OK — ${report.count} eager module(s), ${report.violations.length} known sync call(s) on eager path.`
    );
    return;
  }

  for (const e of errors) {
    if (e.file) {
      console.error(`::error file=${e.file}::${e.message}`);
    } else {
      console.error(`::error::${e.message}`);
    }
  }
  console.error(
    `\n[check-import-budget] FAILED — ${errors.length} issue(s). ` +
      `If the change is intentional (e.g. a new boot-critical module, or a refactor that legitimately shifts sync work to startup), ` +
      `run \`npm run import-budget:update\` to refresh the baseline.`
  );
  process.exit(1);
}

main();
