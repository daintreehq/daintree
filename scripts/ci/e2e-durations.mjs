#!/usr/bin/env node

/**
 * Summarise Playwright JSON reports into per-spec-file durations.
 *
 * For every (platform, project, spec file) it reports the test count, the
 * summed duration of each test's final attempt, the summed duration including
 * retries, the retry count and the outcome counts. Per-project totals are
 * rolled up the same way. Several reports (shards, or runs on different
 * platforms) can be merged in one call. Output is sorted and carries no
 * timestamps, so regenerating from the same reports yields identical JSON.
 *
 * Playwright attributes beforeAll/afterAll (where the app launch usually
 * happens) to no test, so these figures are lower bounds on file cost.
 *
 * Usage:
 *   node scripts/ci/e2e-durations.mjs [--platform <name>] [--out <file>] <report.json>...
 *
 * The platform comes from `config.metadata.platform` in each report when set,
 * else from `--platform`, else it is null.
 */

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);

const STATUS_KEYS = ["passed", "failed", "flaky", "skipped"];

// Playwright's test-level outcome: expected | unexpected | flaky | skipped.
function classify(test) {
  switch (test.status) {
    case "expected":
      return "passed";
    case "unexpected":
      return "failed";
    case "flaky":
      return "flaky";
    case "skipped":
      return "skipped";
    default: {
      const last = test.results?.at(-1);
      if (!last || last.status === "skipped") return "skipped";
      return last.status === "passed" ? "passed" : "failed";
    }
  }
}

function emptyBucket() {
  return {
    tests: 0,
    durationMs: 0,
    durationWithRetriesMs: 0,
    retries: 0,
    status: Object.fromEntries(STATUS_KEYS.map((k) => [k, 0])),
  };
}

function addTest(bucket, test) {
  const results = test.results ?? [];
  const durations = results.map((r) => (Number.isFinite(r.duration) ? r.duration : 0));
  bucket.tests += 1;
  bucket.durationMs += durations.at(-1) ?? 0;
  bucket.durationWithRetriesMs += durations.reduce((sum, d) => sum + d, 0);
  bucket.retries += Math.max(0, results.length - 1);
  bucket.status[classify(test)] += 1;
}

function mergeBucket(into, from) {
  into.tests += from.tests;
  into.durationMs += from.durationMs;
  into.durationWithRetriesMs += from.durationWithRetriesMs;
  into.retries += from.retries;
  for (const k of STATUS_KEYS) into.status[k] += from.status[k];
}

// Nested suite/spec `file` fields are declaration locations, which point at a
// helper when a shared helper declares the tests. Cost belongs to the runnable
// spec, so the top-level file suite's name is carried down unchanged.
function walkSuites(suites, specFile, visit) {
  for (const suite of suites ?? []) {
    const file = specFile ?? suite.file ?? null;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) visit(file, test);
    }
    walkSuites(suite.suites, file, visit);
  }
}

export function reportPlatform(report, fallback = null) {
  const fromMeta = report?.config?.metadata?.platform;
  return typeof fromMeta === "string" && fromMeta.length > 0 ? fromMeta : fallback;
}

// Code-unit comparison keeps ordering independent of the host locale.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const byKey = (a, b) =>
  cmp(a.platform ?? "", b.platform ?? "") ||
  cmp(a.project, b.project) ||
  cmp(a.file ?? "", b.file ?? "");

/**
 * Summarise one or more parsed Playwright JSON reports.
 * `reports` is an array of `{ report, platform? }` where `platform` is the
 * fallback used when the report's metadata does not name one.
 */
export function summarizeReports(reports) {
  const specs = new Map();

  for (const { report, platform: fallback = null } of reports) {
    const platform = reportPlatform(report, fallback);
    walkSuites(report?.suites, null, (file, test) => {
      const project = test.projectName ?? "";
      const key = JSON.stringify([platform, project, file]);
      let entry = specs.get(key);
      if (!entry) {
        entry = { platform, project, file: file ?? "", ...emptyBucket() };
        specs.set(key, entry);
      }
      addTest(entry, test);
    });
  }

  const projects = new Map();
  for (const entry of specs.values()) {
    const key = JSON.stringify([entry.platform, entry.project]);
    let total = projects.get(key);
    if (!total) {
      total = { platform: entry.platform, project: entry.project, specs: 0, ...emptyBucket() };
      projects.set(key, total);
    }
    total.specs += 1;
    mergeBucket(total, entry);
  }

  const platforms = [...new Set([...specs.values()].map((s) => s.platform))].sort((a, b) =>
    cmp(a ?? "", b ?? "")
  );

  return {
    platforms,
    projects: [...projects.values()].sort(byKey),
    specs: [...specs.values()].sort(byKey),
  };
}

export function parseArgs(argv) {
  const args = { platform: null, out: null, inputs: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--platform" || arg === "--out") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      args[arg.slice(2)] = value;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      args.inputs.push(arg);
    }
  }
  return args;
}

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    fail(err.message);
  }
  if (args.inputs.length === 0) {
    fail(
      "Usage: e2e-durations.mjs [--platform <name>] [--out <file>] <playwright-results.json>..."
    );
  }

  const reports = [];
  for (const input of args.inputs) {
    try {
      reports.push({ report: JSON.parse(readFileSync(input, "utf8")), platform: args.platform });
    } catch (err) {
      fail(`Failed to read ${input}: ${err.message}`);
    }
  }

  const json = JSON.stringify(summarizeReports(reports), null, 2) + "\n";
  if (args.out) {
    writeFileSync(args.out, json, "utf8");
    console.error(`[e2e-durations] Wrote ${args.out}`);
  } else {
    process.stdout.write(json);
  }
}

if (process.argv[1] && process.argv[1] === __filename) {
  main();
}
