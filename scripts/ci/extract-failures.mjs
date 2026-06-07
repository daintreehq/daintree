#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function walkSuites(suites, parentPath = [], results = [], parentFile = null) {
  for (const suite of suites) {
    const file = suite.file || parentFile;
    const currentPath = suite.title ? [...parentPath, suite.title] : parentPath;
    if (suite.suites?.length) walkSuites(suite.suites, currentPath, results, file);
    for (const spec of suite.specs ?? []) {
      const specPath = [...currentPath, spec.title];
      for (const test of spec.tests ?? []) {
        // Gate on the test-level outcome so recovered flakes ("flaky" =
        // failed then passed on retry) are not reported. When `status` is
        // absent (partial schema), infer from the final attempt instead.
        const lastResult = test.results?.at(-1);
        const failed = test.status
          ? test.status === "unexpected"
          : lastResult != null && lastResult.status !== "passed" && lastResult.status !== "skipped";
        if (!failed) continue;
        const primaryError = lastResult?.errors?.[0];
        results.push({
          file,
          titlePath: specPath,
          projectName: test.projectName,
          status: lastResult?.status ?? "failed",
          errorMessage: primaryError?.message ?? "Unknown error",
          errorStack: primaryError?.stack ?? null,
        });
      }
    }
  }
  return results;
}

const POSIX_PATH_RE = /\/(?:Users|home|root|private\/var)\/[\w./-]+/g;
const WIN_PATH_RE = /[A-Z]:\\[\w\\/\-.]+|[A-Z]:\\\\[\w\\\\/\-.]+/g;
const WIN_DRIVE_RE = /[A-Z]:(?=<path>|\/)/g;
const PATH_RE = new RegExp(`${POSIX_PATH_RE.source}|${WIN_PATH_RE.source}`, "g");
const BSLASH_RE = /\\/g;
const TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;
const LINE_COL_RE = /:\d+:\d+/g;
const MEM_ADDR_RE = /0x[0-9a-fA-F]{8,}/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const PORT_RE = /:\d{4,5}\b/g;

export function normalizeError(message) {
  // Match paths before flattening backslashes so WIN_PATH_RE can consume
  // drive-letter paths (e.g. the C:\a\<repo> Actions workspace) whole, then
  // again afterwards for any POSIX-style paths revealed by the flattening.
  return message
    .replace(PATH_RE, "<path>")
    .replace(BSLASH_RE, "/")
    .replace(PATH_RE, "<path>")
    .replace(WIN_DRIVE_RE, "")
    .replace(TIMESTAMP_RE, "<timestamp>")
    .replace(LINE_COL_RE, ":<line>:<col>")
    .replace(MEM_ADDR_RE, "0x<addr>")
    .replace(UUID_RE, "<uuid>")
    .replace(PORT_RE, ":<port>")
    .replace(/\r\n/g, "\n")
    .trim();
}

export function computeSignature(file, titlePath, errorMessage) {
  const normalized = normalizeError(errorMessage);
  const raw = [file, titlePath.join("::"), normalized].join("::");
  const hash = createHash("sha256").update(raw).digest("hex");
  return hash.slice(0, 12);
}

export function extractFailures(report) {
  const failures = [];
  if (!report?.suites) return failures;

  for (const suite of report.suites) {
    const suiteFailures = walkSuites([suite], [], [], suite.file);
    for (const f of suiteFailures) {
      failures.push({
        ...f,
        signature: computeSignature(f.file, f.titlePath, f.errorMessage),
      });
    }
  }
  return failures;
}

async function main() {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];

  if (!inputPath) {
    fail("Usage: extract-failures.mjs <playwright-results.json> [output.json]");
  }

  let raw;
  try {
    raw = JSON.parse(await readFile(inputPath, "utf8"));
  } catch (err) {
    fail(`Failed to read ${inputPath}: ${err.message}`);
  }

  const failures = extractFailures(raw);

  if (failures.length === 0) {
    console.log("[extract-failures] No failures found");
    if (outputPath) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(outputPath, "[]", "utf8");
    }
    return;
  }

  const output = failures.map((f) => ({
    signature: f.signature,
    file: f.file,
    titlePath: f.titlePath,
    projectName: f.projectName,
    normalizedError: normalizeError(f.errorMessage),
    rawError: f.errorMessage,
    status: f.status,
  }));

  const json = JSON.stringify(output, null, 2);

  if (outputPath) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(outputPath, json, "utf8");
    console.log(`[extract-failures] Wrote ${output.length} failure(s) to ${outputPath}`);
  } else {
    console.log(json);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
