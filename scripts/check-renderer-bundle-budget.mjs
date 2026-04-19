#!/usr/bin/env node

// Compares dist/renderer-bundle-size-report.json (emitted by the
// rendererBundleSizePlugin in vite.config.ts) against the checked-in
// renderer-bundle-size-baseline.json. Fails if any gated metric (entry chunk
// gzip, total JS gzip, total CSS gzip) exceeds the baseline by more than the
// configured threshold (default 5%).
//
// Usage:
//   node scripts/check-renderer-bundle-budget.mjs                              # check mode (CI)
//   node scripts/check-renderer-bundle-budget.mjs --threshold 0.10            # allow 10% growth
//   node scripts/check-renderer-bundle-budget.mjs --update                    # write current report as new baseline
//   node scripts/check-renderer-bundle-budget.mjs --update --force            # bypass the shrinkage guard
//   node scripts/check-renderer-bundle-budget.mjs --override                  # suppress failure exit code

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { compareReports, formatMarkdown, validateReport } from "./renderer-bundle-budget-lib.mjs";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const REPORT_FILE = path.join(ROOT, "dist", "renderer-bundle-size-report.json");
const BASELINE_FILE = path.join(ROOT, "renderer-bundle-size-baseline.json");
const SUMMARY_FILE = path.join(ROOT, "dist", "renderer-bundle-size-summary.md");
const DEFAULT_THRESHOLD = 0.05;
const UPDATE_SHRINKAGE_THRESHOLD = 0.1;

function readJson(file, label) {
  if (!existsSync(file)) {
    console.error(`::error::${label} not found at ${path.relative(ROOT, file)}`);
    if (file === REPORT_FILE) {
      console.error("   Run `npm run renderer-bundle-budget:build` first to generate the report.");
    } else {
      console.error("   Run `npm run renderer-bundle-budget:update` to create the baseline.");
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

function writeBaseline(report, { force }) {
  // Sort chunk keys deterministically so diffs stay clean.
  const sorted = {
    entryChunk: report.entryChunk ?? null,
    chunks: Object.keys(report.chunks)
      .sort()
      .reduce((acc, k) => {
        acc[k] = { raw: report.chunks[k].raw, gzip: report.chunks[k].gzip };
        return acc;
      }, {}),
    totals: {
      js: { raw: report.totals.js.raw, gzip: report.totals.js.gzip },
      css: { raw: report.totals.css.raw, gzip: report.totals.css.gzip },
    },
  };

  // Shrinkage guard: refuse to overwrite if total JS or CSS gzip would drop
  // significantly. Catches logger/plugin bugs that produce partial reports.
  if (existsSync(BASELINE_FILE) && !force) {
    try {
      const prior = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
      for (const kind of ["js", "css"]) {
        const priorGzip = prior?.totals?.[kind]?.gzip ?? 0;
        const newGzip = report.totals[kind].gzip;
        if (priorGzip > 0) {
          const drop = (priorGzip - newGzip) / priorGzip;
          if (drop > UPDATE_SHRINKAGE_THRESHOLD) {
            console.error(
              `::error::refusing to update baseline — total ${kind.toUpperCase()} gzip would drop from ${priorGzip} to ${newGzip} (${(drop * 100).toFixed(1)}% shrinkage > ${(UPDATE_SHRINKAGE_THRESHOLD * 100).toFixed(0)}% threshold).`
            );
            console.error("   If the shrinkage is intentional, re-run with --force.");
            process.exit(1);
          }
        }
      }
    } catch {
      // Unparseable prior — let the update proceed.
    }
  }

  writeFileSync(BASELINE_FILE, JSON.stringify(sorted, null, 2) + "\n");
  console.log(
    `[check-renderer-bundle-budget] baseline updated: ${Object.keys(sorted.chunks).length} chunks, JS gzip=${sorted.totals.js.gzip}, CSS gzip=${sorted.totals.css.gzip}`
  );
}

function parseArgs(argv) {
  const args = { isUpdate: false, force: false, override: false, threshold: DEFAULT_THRESHOLD };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--update") args.isUpdate = true;
    else if (arg === "--force") args.force = true;
    else if (arg === "--override") args.override = true;
    else if (arg === "--threshold" && argv[i + 1]) {
      const val = argv[i + 1];
      args.threshold = parseFloat(val);
      if (!Number.isFinite(args.threshold) || args.threshold < 0 || args.threshold > 1) {
        console.error(`::error::invalid threshold: ${val} (must be 0–1)`);
        process.exit(1);
      }
      i++;
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);

  const report = readJson(REPORT_FILE, "renderer bundle size report");
  const reportErrs = validateReport(report);
  if (reportErrs.length > 0) {
    for (const e of reportErrs)
      console.error(`::error file=${path.relative(ROOT, REPORT_FILE)}::report ${e}`);
    process.exit(1);
  }

  if (args.isUpdate) {
    writeBaseline(report, { force: args.force });
    return;
  }

  const baseline = readJson(BASELINE_FILE, "renderer bundle size baseline");
  const baselineErrs = validateReport(baseline);
  if (baselineErrs.length > 0) {
    for (const e of baselineErrs)
      console.error(`::error file=${path.relative(ROOT, BASELINE_FILE)}::baseline ${e}`);
    process.exit(1);
  }

  const comparison = compareReports(report, baseline, args.threshold);
  const markdown = formatMarkdown(comparison, args.threshold);

  // Write markdown summary for CI comment posting
  mkdirSync(path.dirname(SUMMARY_FILE), { recursive: true });
  writeFileSync(SUMMARY_FILE, markdown + "\n");

  // Emit GitHub annotations
  for (const f of comparison.failures) {
    const name = f.name ? ` \`${f.name}\`` : "";
    console.error(
      `::error::${f.metric}${name} grew beyond +${(args.threshold * 100).toFixed(0)}% threshold`
    );
  }
  for (const i of comparison.improvements) {
    const name = i.name ? ` \`${i.name}\`` : "";
    console.log(`::notice::${i.metric}${name} shrank — consider updating baseline`);
  }

  if (comparison.ok) {
    console.log(
      `[check-renderer-bundle-budget] OK — ${Object.keys(report.chunks).length} chunks, JS gzip=${report.totals.js.gzip}, CSS gzip=${report.totals.css.gzip}`
    );
  } else {
    console.error(
      `\n[check-renderer-bundle-budget] FAILED — ${comparison.failures.length} regression(s) exceed +${(args.threshold * 100).toFixed(0)}% threshold. ` +
        `If the change is intentional, run \`npm run renderer-bundle-budget:update\` to refresh the baseline, or add the \`bundle-size-override\` label to the PR.`
    );
    if (!args.override) process.exit(1);
    console.log(
      "[check-renderer-bundle-budget] override active — exiting successfully despite regressions"
    );
  }
}

main();
