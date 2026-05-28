#!/usr/bin/env node
// Parses the Playwright JSON reporter output (test-results/report.json) and
// classifies each failure into Infrastructure, Test-Logic, or Product-Logic
// buckets using ordered regex rules. Designed to run per-e2e-shard; the notify
// job in nightly.yml aggregates per-shard outputs into the auto-issue body.
//
// The regex classification table MUST stay in sync with the workflow comment
// in .github/workflows/e2e.yml (search for "classification regex table").
//
// Failure modes:
//   - missing input file   -> exit 0 (test may have passed, or Playwright
//                             didn't write JSON — not a script error)
//   - malformed JSON       -> exit 1 (genuine bug in script or PW output)
//   - no failures in JSON  -> exit 0, writes empty classification

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Ordered from most-specific to least-specific. The first matching rule wins.
// Specific patterns (e.g. "spawn EPERM") must precede broad ones (e.g. bare
// "EPERM") so the more actionable bucket is chosen.
const CLASSIFICATION_RULES = [
  // --- Infrastructure (OS / CI runner resource contention) ---
  { regex: /spawn\s+EPERM/i, bucket: "Infrastructure", label: "spawn EPERM (AV on-access scan)" },
  { regex: /EBUSY.*\.tmp/i, bucket: "Infrastructure", label: "EBUSY on .tmp (indexer contention)" },
  { regex: /EPERM[:,\s]/i, bucket: "Infrastructure", label: "EPERM (permission denied)" },
  { regex: /EACCES[:,\s]/i, bucket: "Infrastructure", label: "EACCES (permission denied)" },
  { regex: /ENOSPC/i, bucket: "Infrastructure", label: "ENOSPC (disk full)" },

  // --- Test-Logic (handshake / timing / stale references) ---
  {
    regex: /CDP target not found/i,
    bucket: "Test-Logic",
    label: "CDP target not found (handshake)",
  },
  {
    regex: /Target\.targetCreated.*timeout/i,
    bucket: "Test-Logic",
    label: "Target.targetCreated timeout (handshake)",
  },
  { regex: /Target.*has been closed/i, bucket: "Test-Logic", label: "Target closed (stale ref)" },
  { regex: /Browser.*has been closed/i, bucket: "Test-Logic", label: "Browser closed (stale ref)" },
  { regex: /page\.?.*has been closed/i, bucket: "Test-Logic", label: "Page closed (stale ref)" },
  {
    regex: /Protocol error.*Target\.closeTarget/i,
    bucket: "Test-Logic",
    label: "Protocol error (target close)",
  },
  { regex: /waiting for selector.*timed out/i, bucket: "Test-Logic", label: "Selector timeout" },
  { regex: /Test timeout of \d+ms exceeded/i, bucket: "Test-Logic", label: "Test timeout" },

  // --- Product-Logic (renderer crashes, actual bugs) ---
  { regex: /WebContents crashed/i, bucket: "Product-Logic", label: "WebContents crashed" },
  { regex: /renderer process.*crashed/i, bucket: "Product-Logic", label: "Renderer process crash" },
  { regex: /renderer.*killed/i, bucket: "Product-Logic", label: "Renderer killed" },
  { regex: /GPU process.*crash/i, bucket: "Product-Logic", label: "GPU process crash" },
  { regex: /utility process.*crash/i, bucket: "Product-Logic", label: "Utility process crash" },
];

/**
 * Classify a single error message against the ordered rule table.
 * Returns { bucket, label } — label identifies which rule matched.
 * Unmatched errors go to "Unclassified".
 */
export function classifyError(errorText) {
  if (!errorText) return { bucket: "Unclassified", label: "empty error" };
  for (const rule of CLASSIFICATION_RULES) {
    if (rule.regex.test(errorText)) {
      return { bucket: rule.bucket, label: rule.label };
    }
  }
  return { bucket: "Unclassified", label: "no matching rule" };
}

/**
 * Walk the Playwright JSON report and extract a flat list of distinct failures.
 * Deduped by `${file}:${line} :: ${title}` — the triage-relevant unit is the
 * test case, not the number of retry attempts.
 *
 * Returns: Array<{ file, line, title, project, bucket, label, attempts, firstError }>
 */
export function extractFailures(report) {
  const seen = new Set();
  const failures = [];

  function walkSuite(suite, projectOverride) {
    if (!suite) return;
    const projectName = projectOverride ?? suite.project?.name;

    if (Array.isArray(suite.specs)) {
      for (const spec of suite.specs) {
        if (!spec.tests) continue;
        for (const test of spec.tests) {
          const pName = test.projectName ?? projectName;
          if (!test.results) continue;
          for (const result of test.results) {
            if (result.status !== "failed" && result.status !== "timedOut") continue;
            const error = result.error;
            const errorText = error
              ? [error.message, error.stack].filter(Boolean).join("\n")
              : (result.errors ?? [])
                  .map((e) => [e.message, e.stack].filter(Boolean).join("\n"))
                  .join("\n");

            const { bucket, label } = classifyError(errorText);
            const file = error?.location?.file ?? spec.file ?? suite.file ?? "unknown";
            const line = error?.location?.line ?? spec.line ?? suite.line ?? 0;
            const title = spec.title ?? test.title ?? "unknown";
            const dedupKey = `${file}:${line} :: ${title}`;

            if (!seen.has(dedupKey)) {
              seen.add(dedupKey);
              failures.push({
                file,
                line,
                title,
                project: pName ?? "unknown",
                bucket,
                label,
                attempts: 1,
                firstError: firstErrorLine(errorText),
              });
            } else {
              const existing = failures.find(
                (f) => `${f.file}:${f.line} :: ${f.title}` === dedupKey
              );
              if (existing) existing.attempts++;
            }
          }
        }
      }
    }

    if (Array.isArray(suite.suites)) {
      for (const child of suite.suites) {
        walkSuite(child, projectName);
      }
    }
  }

  if (Array.isArray(report.suites)) {
    for (const suite of report.suites) {
      walkSuite(suite, null);
    }
  } else if (report.suites) {
    walkSuite(report.suites, null);
  }

  return failures;
}

function firstErrorLine(errorText) {
  if (!errorText) return "";
  return errorText.split("\n")[0].trim().slice(0, 200);
}

/**
 * Build a classification summary from a list of extracted failures.
 */
export function buildClassification(failures) {
  const buckets = {
    Infrastructure: [],
    "Test-Logic": [],
    "Product-Logic": [],
    Unclassified: [],
  };

  for (const f of failures) {
    const entry = {
      file: f.file,
      line: f.line,
      title: f.title,
      project: f.project,
      label: f.label,
      attempts: f.attempts,
      firstError: f.firstError,
    };
    buckets[f.bucket]?.push(entry);
  }

  const summary = {};
  let totalUnique = 0;
  let totalAttempts = 0;
  for (const [bucket, entries] of Object.entries(buckets)) {
    if (entries.length === 0) continue;
    const attemptCount = entries.reduce((sum, e) => sum + e.attempts, 0);
    summary[bucket] = {
      unique: entries.length,
      attempts: attemptCount,
      top: entries.slice(0, 5),
    };
    totalUnique += entries.length;
    totalAttempts += attemptCount;
  }

  return {
    totalUnique,
    totalAttempts,
    buckets: summary,
    failures,
  };
}

async function main() {
  const args = process.argv.slice(2);
  let inputPath = "test-results/report.json";
  let outputPath = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--input" && args[i + 1]) {
      inputPath = args[++i];
    } else if (args[i] === "--output" && args[i + 1]) {
      outputPath = args[++i];
    }
  }

  if (!path.isAbsolute(inputPath)) {
    inputPath = path.resolve(process.cwd(), inputPath);
  }

  let raw;
  try {
    raw = await readFile(inputPath, "utf-8");
  } catch {
    // Input file doesn't exist — tests may have passed or Playwright never
    // wrote the JSON. Not an error.
    console.log(JSON.stringify({ totalUnique: 0, totalAttempts: 0, buckets: {}, failures: [] }));
    process.exit(0);
  }

  let report;
  try {
    report = JSON.parse(raw);
  } catch (err) {
    console.error(`::error::Failed to parse ${inputPath}: ${err.message}`);
    process.exit(1);
  }

  const failures = extractFailures(report);
  const classification = buildClassification(failures);

  const output = JSON.stringify(classification, null, 2);

  if (outputPath) {
    const resolvedOutput = path.isAbsolute(outputPath)
      ? outputPath
      : path.resolve(process.cwd(), outputPath);
    await writeFile(resolvedOutput, output, "utf-8");
    console.log(`Wrote classification to ${resolvedOutput}`);
  } else {
    console.log(output);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}
