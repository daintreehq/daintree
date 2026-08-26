#!/usr/bin/env node
// Enumerates React Compiler Error-severity diagnostics — the load-bearing
// subset that actually costs a component its optimization, as opposed to the
// cosmetic Hint noise the budget gate collapses into a per-file count.
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

import { scanCompilerDiagnostics } from "./lib/compiler-scan.mjs";
import { createProgressReporter } from "./lib/scan-progress.mjs";

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

const byFile = new Map();
for (const [file, entry] of Object.entries(scan.files)) {
  const critical = entry.errorBailouts.filter((b) => b.severity === "Error");
  if (critical.length > 0) byFile.set(file, critical);
}

if (byFile.size === 0) {
  // Qualified deliberately: printing a bare all-clear under a list of files
  // that could not be scanned reads as "nothing to fix" when the truth is
  // "nothing found in the part that was readable".
  console.log(
    scan.failures.length > 0
      ? `No critical (Error-severity) compiler diagnostics in the ${scan.scanned.length} file(s) that scanned — but ${scan.failures.length} file(s) failed, so this is not a clean bill of health.`
      : `No critical (Error-severity) compiler diagnostics across ${scan.scanned.length} scanned files.`
  );
} else {
  const total = [...byFile.values()].reduce((sum, list) => sum + list.length, 0);
  console.log(
    `\n${byFile.size} file(s) have critical (Error-severity) compiler diagnostics ` +
      `(${scan.scanned.length} files scanned):\n`
  );
  for (const file of [...byFile.keys()].sort()) {
    console.log(`  ${file}`);
    for (const b of byFile.get(file)) {
      console.log(`    :${b.line ?? "?"}  ${b.reason}`);
    }
  }
  console.log(`\nTotal: ${total} critical error(s)`);
}

// Exit 0 means "the scan completed", NOT "nothing was found" — this is a
// triage aid, not a gate, and `compiler-budget:check` is what fails a run.
// Exit 1 means the report above is incomplete.
//
// `exitCode` rather than `process.exit()`: the listing can be long, and
// exiting outright can truncate buffered stdout mid-write.
process.exitCode = scan.failures.length > 0 ? 1 : 0;
