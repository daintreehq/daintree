#!/usr/bin/env node
// Lists every function React Compiler gave up on, by severity: Error (code that
// breaks the Rules of React), Warning (an incompatible library or unsupported
// syntax), and Hint, the compiler's `Todo` for syntax it doesn't support yet.
//
// A `Todo` is not cosmetic: the compiler abandons the whole component or hook
// over it, exactly as it does over an Error, and emits no memoization at all.
// (A few lint-only validations log an Error without abandoning anything.) This used to list Errors
// alone, which hid all but 2 of the app's ~355 abandoned components, among them
// the toolbar and every Canopy surface. The budget gate pools Hints into one
// repo-wide total, so a file losing its compilation passes there whenever
// another file gains one back; this listing is where they are seen.
//
// Reads the same scan the budget gate does (`scripts/lib/compiler-scan.mjs`),
// so the two tiers cannot disagree. They used to: this script ran its own Babel
// pass over `src/**` alone, under its own options, which left it structurally
// blind to the `plugins/builtin/*/renderer/**` files the gate tracks — a
// critical error in one of those tripped the gate and this script reported
// nothing.
//
// Usage: node scripts/find-critical-compiler-errors.mjs
// Exit code: 0 = the scan completed (findings may still be listed), 1 = the
// scan could not read or parse something, so the listing is incomplete.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanCompilerDiagnostics, getHintBailouts, getHintCount } from "./lib/compiler-scan.mjs";
import { createProgressReporter } from "./lib/scan-progress.mjs";

const SECTIONS = [
  { severity: "Error", label: "Error", meaning: "code that breaks the Rules of React" },
  {
    severity: "Warning",
    label: "Warning",
    meaning: "an incompatible library or unsupported syntax",
  },
  {
    severity: "Hint",
    label: "Hint (`Todo`)",
    meaning:
      "syntax React Compiler doesn't support yet, and the function goes uncompiled all the same",
  },
];

function bailoutsOf(entry, severity) {
  if (severity === "Hint") return getHintBailouts(entry);
  return Array.isArray(entry?.errorBailouts)
    ? entry.errorBailouts.filter((b) => b && typeof b === "object" && b.severity === severity)
    : [];
}

// A Hint list is a bounded sample, so its count comes from the exact
// `hintCount` rather than the samples kept.
function countOf(entry, severity, listed) {
  return severity === "Hint" ? Math.max(getHintCount(entry), listed.length) : listed.length;
}

function describeBailout(b) {
  const where = typeof b.fnLine === "number" ? `  (function at :${b.fnLine})` : "";
  return `    :${b.line ?? "?"}  ${b.reason}${where}`;
}

/**
 * The listing as lines, from a scan result. Pure, so its wording and its
 * sample arithmetic are testable without a twenty-second scan.
 */
export function formatBailoutReport(scan) {
  const lines = [];
  const files = Object.entries(scan.files ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const scannedCount = scan.scanned?.length ?? 0;
  const failureCount = scan.failures?.length ?? 0;
  const totals = [];

  for (const { severity, label, meaning } of SECTIONS) {
    const rows = [];
    let total = 0;
    for (const [file, entry] of files) {
      const listed = bailoutsOf(entry, severity);
      const count = countOf(entry, severity, listed);
      if (count === 0) continue;
      total += count;
      rows.push(`  ${file}`);
      for (const b of listed) rows.push(describeBailout(b));
      if (count > listed.length) rows.push(`    (+${count - listed.length} more not listed)`);
    }
    if (total === 0) continue;
    const fileCount = rows.filter((r) => !r.startsWith("    ")).length;
    totals.push(`${total} ${severity}`);
    lines.push("", `${label}, ${total} in ${fileCount} file(s): ${meaning}`, "", ...rows);
  }

  if (totals.length === 0) {
    // Qualified deliberately: printing a bare all-clear under a list of files
    // that could not be scanned reads as "nothing to fix" when the truth is
    // "nothing found in the part that was readable".
    lines.push(
      failureCount > 0
        ? `No compiler bailouts in the ${scannedCount} file(s) that scanned — but ${failureCount} file(s) failed, so this is not a clean bill of health.`
        : `No compiler bailouts across ${scannedCount} scanned files.`
    );
    return lines;
  }
  lines.push(
    "",
    `Total: ${totals.join(", ")} diagnostic(s) across ${scannedCount} scanned files. One function can carry several.`
  );
  return lines;
}

async function main() {
  const scan = await scanCompilerDiagnostics({
    onProgress: createProgressReporter("[find-critical-compiler-errors] scanning"),
  });

  if (scan.failures.length > 0) {
    for (const { file, stage, message } of scan.failures) {
      console.error(`::error file=${file}::compiler scan failed at ${stage}: ${message}`);
    }
    console.error(
      `\n${scan.failures.length} file(s) could not be scanned — the list below is incomplete.`
    );
  }

  console.log(formatBailoutReport(scan).join("\n"));

  // Exit 0 means "the scan completed", NOT "nothing was found" — this is a
  // triage aid, not a gate, and `compiler-budget:check` is what fails a run.
  // Exit 1 means the report above is incomplete.
  //
  // `exitCode` rather than `process.exit()`: the listing can be long, and
  // exiting outright can truncate buffered stdout mid-write.
  process.exitCode = scan.failures.length > 0 ? 1 : 0;
}

// Only when run as a command, so the formatter can be imported by its tests.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
