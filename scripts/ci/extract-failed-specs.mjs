#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

// A spec contributes to the retry list when any of its tests failed OR was
// flaky. Flaky matters because `FAIL_ON_FLAKY_TESTS=true` (core/online) makes
// Playwright exit non-zero on flaky outcomes even though `spec.ok` stays true —
// so a `.ok === false` filter alone silently drops the flaky spec that tripped
// the gate. This mirrors the predicate in the "Extract failing spec manifest"
// step of .github/workflows/e2e.yml; keep the two in lockstep.
function specFailed(spec) {
  return (Array.isArray(spec.tests) ? spec.tests : []).some((test) => {
    if (test.status === "flaky") return true;
    const lastResult = test.results?.[test.results.length - 1];
    const lastStatus = lastResult?.status;
    return Boolean(lastStatus) && lastStatus !== "passed" && lastStatus !== "skipped";
  });
}

function walk(suite, failed) {
  for (const child of Array.isArray(suite.suites) ? suite.suites : []) walk(child, failed);
  for (const spec of Array.isArray(suite.specs) ? suite.specs : []) {
    if (spec.file && specFailed(spec)) failed.add(spec.file);
  }
}

export function extractFailedSpecPaths(report) {
  const failed = new Set();
  if (!Array.isArray(report?.suites)) return [];
  for (const suite of report.suites) walk(suite, failed);
  return [...failed].sort();
}

async function main() {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];

  if (!inputPath) {
    fail("Usage: extract-failed-specs.mjs <playwright-results.json> [output.txt]");
  }

  let report;
  try {
    report = JSON.parse(await readFile(inputPath, "utf8"));
  } catch (err) {
    fail(`Failed to read ${inputPath}: ${err.message}`);
  }

  const specs = extractFailedSpecPaths(report);
  // Trailing newline only when non-empty, matching `jq -r | sort -u` output so
  // `wc -l` and the `[ -s failed-specs.txt ]` gate downstream stay accurate.
  const content = specs.length ? specs.join("\n") + "\n" : "";

  if (outputPath) {
    await writeFile(outputPath, content, "utf8");
    console.log(`[extract-failed-specs] Wrote ${specs.length} failed spec(s) to ${outputPath}`);
  } else {
    process.stdout.write(content);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
