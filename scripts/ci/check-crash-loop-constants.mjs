#!/usr/bin/env node
// Asserts the crash-loop constants stay equal across the three guards:
// `electron/services/pty/PtyHostLifecycle.ts`,
// `electron/services/WorkspaceHostProcess.ts`, and
// `electron/services/CrashLoopGuardService.ts`.
//
// The constants are deliberately duplicated, not imported — the guards
// operate at independent layers (disk-persisted app-level vs. in-memory
// per-host) and must not be coupled at the module level. This script is the
// drift guard that keeps the values aligned while the definitions stay
// separate. The runtime alignment test
// (`electron/services/__tests__/crashGuardAlignment.test.ts`) exercises the
// same invariant from inside vitest; this script catches drift earlier in CI.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

const FILES = [
  path.join(root, "electron/services/pty/PtyHostLifecycle.ts"),
  path.join(root, "electron/services/WorkspaceHostProcess.ts"),
  path.join(root, "electron/services/CrashLoopGuardService.ts"),
];

const CONSTANTS = ["CRASH_THRESHOLD", "CRASH_WINDOW_MS"];

function extract(source, name) {
  // Match `const NAME = <RHS>;` or `export const NAME = <RHS>;`.
  // RHS may be a numeric literal (with underscores) or an arithmetic
  // expression like `30 * 60 * 1000` — capture verbatim and normalize
  // whitespace for cross-file comparison.
  const re = new RegExp(`^(?:export\\s+)?const\\s+${name}\\s*=\\s*([^;]+);`, "m");
  const match = source.match(re);
  if (!match) return null;
  const rhs = match[1].trim().replace(/\s+/g, " ");
  return { raw: rhs };
}

const sources = FILES.map((file) => ({ file, source: readFileSync(file, "utf8") }));

let failures = 0;

for (const name of CONSTANTS) {
  const extracted = sources.map(({ file, source }) => ({ file, value: extract(source, name) }));

  const missing = extracted.filter((e) => e.value === null);
  if (missing.length > 0) {
    for (const m of missing) {
      console.error(
        `::error file=${m.file}::constant \`${name}\` not found. ` +
          `If it was renamed or removed, update scripts/ci/check-crash-loop-constants.mjs.`
      );
      failures++;
    }
    continue;
  }

  const distinct = new Set(extracted.map((e) => e.value.raw));
  if (distinct.size > 1) {
    const details = extracted.map((e) => `  ${e.file}: ${e.value.raw}`).join("\n");
    console.error(
      `::error::crash-loop constant drift: \`${name}\` differs across guards.\n` +
        `${details}\n` +
        `The guards are intentionally duplicated but must hold the same value. ` +
        `Update all sites or document why they diverge.`
    );
    failures++;
  }
}

if (failures > 0) {
  console.error(`\ncrash-loop constant drift detected: ${failures} issue(s).`);
  process.exit(1);
}

console.log("[check-crash-loop-constants] OK — crash-loop constants aligned across guards");
