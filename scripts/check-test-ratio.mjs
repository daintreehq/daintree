#!/usr/bin/env node

// Compares the fix-with-test ratio against the checked-in
// test-ratio-baseline.json. The ratio is computed from the last 100 merged
// PRs via the GitHub GraphQL API.
//
// Usage:
//   node scripts/check-test-ratio.mjs                    # check mode (CI)
//   node scripts/check-test-ratio.mjs --update           # rewrite baseline from current report
//   node scripts/check-test-ratio.mjs --update --force   # bypass shrinkage guard

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { graphql } from "@octokit/graphql";
import {
  classifyPR,
  computeTestRatioReport,
  validateBaseline,
  compareToBaseline,
  formatBaseline,
  formatMarkdown,
} from "./test-ratio-lib.mjs";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const BASELINE_FILE = path.join(ROOT, "test-ratio-baseline.json");
const SUMMARY_FILE = path.join(ROOT, "dist", "test-ratio-summary.md");
const ROLLING_WINDOW_SIZE = 100;
const API_TIMEOUT_MS = 15_000;
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

const SEARCH_QUERY = `is:pr is:merged -label:documentation -label:dependencies repo:daintreehq/daintree sort:created-desc`;

const PR_QUERY = `query($q: String!) {
  search(query: $q, type: ISSUE, first: 100) {
    nodes {
      ... on PullRequest {
        number
        title
        labels(first: 100) { nodes { name } }
        files(first: 100) { nodes { path } }
      }
    }
  }
}`;

async function fetchMergedPullRequests(token) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  let result;
  try {
    result = await graphql({
      query: PR_QUERY,
      q: SEARCH_QUERY,
      headers: { authorization: `token ${token}` },
      request: { signal: controller.signal },
    });
  } catch (err) {
    if (err.name === "AbortError") {
      console.error(`::error::GitHub GraphQL request timed out after ${API_TIMEOUT_MS / 1000}s`);
    } else {
      console.error(`::error::GitHub GraphQL request failed: ${err.message ?? err}`);
    }
    process.exit(1);
  } finally {
    clearTimeout(timeout);
  }

  const nodes = result?.search?.nodes;
  if (!Array.isArray(nodes)) {
    console.error("::error::GraphQL response did not contain search.nodes array");
    console.error("   Verify the GH_TOKEN has read permissions and the query is valid.");
    process.exit(1);
  }

  if (nodes.length === 0) {
    console.error("::error::GraphQL search returned zero PRs");
    console.error(`   Search query: ${SEARCH_QUERY}`);
    process.exit(1);
  }

  return nodes;
}

function buildReport(prs) {
  const classified = prs.map(classifyPR);
  return computeTestRatioReport(classified, ROLLING_WINDOW_SIZE);
}

function writeBaseline(report, { force }) {
  if (existsSync(BASELINE_FILE) && !force) {
    try {
      const prior = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
      if (prior && typeof prior.fixWithTestRatio === "number" && prior.fixWithTestRatio > 0) {
        const fixDrop = (prior.fixWithTestRatio - report.fixWithTestRatio) / prior.fixWithTestRatio;
        if (fixDrop > UPDATE_SHRINKAGE_THRESHOLD) {
          console.error(
            `::error::refusing to update baseline — fix-with-test ratio would drop from ${(prior.fixWithTestRatio * 100).toFixed(1)}% to ${(report.fixWithTestRatio * 100).toFixed(1)}% (${(fixDrop * 100).toFixed(1)}% shrinkage > ${(UPDATE_SHRINKAGE_THRESHOLD * 100).toFixed(0)}% threshold).`
          );
          console.error(
            "   This usually means the API returned stale data, label filters changed, or a batch of untested PRs merged."
          );
          console.error("   If the drop is intentional, re-run with --force.");
          process.exit(1);
        }
      }
      if (prior && typeof prior.allWithTestRatio === "number" && prior.allWithTestRatio > 0) {
        const allDrop = (prior.allWithTestRatio - report.allWithTestRatio) / prior.allWithTestRatio;
        if (allDrop > UPDATE_SHRINKAGE_THRESHOLD) {
          console.error(
            `::error::refusing to update baseline — all-with-test ratio would drop from ${(prior.allWithTestRatio * 100).toFixed(1)}% to ${(report.allWithTestRatio * 100).toFixed(1)}% (${(allDrop * 100).toFixed(1)}% shrinkage > ${(UPDATE_SHRINKAGE_THRESHOLD * 100).toFixed(0)}% threshold).`
          );
          console.error("   If the drop is intentional, re-run with --force.");
          process.exit(1);
        }
      }
    } catch {
      // Unparseable prior baseline — let the update proceed.
    }
  }

  const formatted = formatBaseline({
    ...report,
    updatedAt: new Date().toISOString(),
  });

  writeFileSync(BASELINE_FILE, JSON.stringify(formatted, null, 2) + "\n");
  console.log(
    `[check-test-ratio] baseline updated: fixWithTestRatio=${(formatted.fixWithTestRatio * 100).toFixed(1)}% (${formatted.fixWithTestCount}/${formatted.fixCount}), allWithTestRatio=${(formatted.allWithTestRatio * 100).toFixed(1)}% (${formatted.allWithTestCount}/${formatted.totalCount})`
  );
}

function writeSummary(report, comparison) {
  mkdirSync(path.dirname(SUMMARY_FILE), { recursive: true });
  writeFileSync(
    SUMMARY_FILE,
    formatMarkdown({ ...report, updatedAt: new Date().toISOString() }, comparison)
  );
  console.log(`[check-test-ratio] summary written to ${path.relative(ROOT, SUMMARY_FILE)}`);
}

async function main() {
  const isUpdate = process.argv.includes("--update");
  const force = process.argv.includes("--force");

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    console.error("::error::GITHUB_TOKEN or GH_TOKEN environment variable is required.");
    process.exit(1);
  }

  const prs = await fetchMergedPullRequests(token);
  const report = buildReport(prs);

  if (isUpdate) {
    writeBaseline(report, { force });
    writeSummary(report, null);
    return;
  }

  const baseline = readJson(
    BASELINE_FILE,
    "test-ratio baseline",
    "Run `npm run test-ratio:update` to create the baseline."
  );

  const validationErrors = validateBaseline(baseline);
  if (validationErrors.length > 0) {
    for (const e of validationErrors) {
      console.error(`::error file=${path.relative(ROOT, BASELINE_FILE)}::${e}`);
    }
    process.exit(1);
  }

  const comparison = compareToBaseline(report, baseline);

  for (const n of comparison.notices) {
    console.log(`::notice::${n.message}`);
  }

  if (comparison.ok) {
    const pct = (ratio) => (ratio * 100).toFixed(1);
    console.log(
      `[check-test-ratio] OK — ` +
        `fixWithTestRatio=${pct(report.fixWithTestRatio)}% (${report.fixWithTestCount}/${report.fixCount}), ` +
        `allWithTestRatio=${pct(report.allWithTestRatio)}% (${report.allWithTestCount}/${report.totalCount})` +
        (report.windowCompleted ? "" : " (window incomplete)")
    );
  } else {
    for (const e of comparison.errors) {
      console.error(`::error::${e.message}`);
    }
    console.error(
      `\n[check-test-ratio] FAILED — ${comparison.errors.length} regression(s). ` +
        `If the change is intentional (e.g. a batch of hotfixes without tests), ` +
        `run \`npm run test-ratio:update\` to refresh the baseline.`
    );
  }

  writeSummary(report, comparison);

  if (!comparison.ok) process.exit(1);
}

main();
