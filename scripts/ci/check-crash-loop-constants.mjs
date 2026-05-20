#!/usr/bin/env node
// Asserts the three crash-loop constants (CRASH_THRESHOLD,
// RAPID_CRASH_WINDOW_MS, STABILITY_TIMEOUT_MS) stay equal across
// `electron/services/pty/PtyHostLifecycle.ts` and
// `electron/services/WorkspaceHostProcess.ts`.
//
// The constants are deliberately duplicated, not imported — the two guards
// operate at independent layers (disk-persisted app-level vs in-memory
// per-host) and must not be coupled at the module level. This script is the
// drift guard that keeps the *values* aligned even while the *definitions*
// stay separate.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

const PTY_FILE = path.join(root, "electron/services/pty/PtyHostLifecycle.ts");
const WORKSPACE_FILE = path.join(root, "electron/services/WorkspaceHostProcess.ts");

const CONSTANTS = ["CRASH_THRESHOLD", "RAPID_CRASH_WINDOW_MS", "STABILITY_TIMEOUT_MS"];

function extract(source, name) {
  const re = new RegExp(`^const\\s+${name}\\s*=\\s*([\\d_]+)\\s*;`, "m");
  const match = source.match(re);
  if (!match) return null;
  const raw = match[1];
  const value = Number(raw.replace(/_/g, ""));
  return { raw, value };
}

const ptySource = readFileSync(PTY_FILE, "utf8");
const workspaceSource = readFileSync(WORKSPACE_FILE, "utf8");

let failures = 0;

for (const name of CONSTANTS) {
  const pty = extract(ptySource, name);
  const workspace = extract(workspaceSource, name);

  if (pty === null) {
    console.error(
      `::error file=${PTY_FILE}::constant \`${name}\` not found. ` +
        `If it was renamed or removed, update scripts/ci/check-crash-loop-constants.mjs.`
    );
    failures++;
    continue;
  }
  if (workspace === null) {
    console.error(
      `::error file=${WORKSPACE_FILE}::constant \`${name}\` not found. ` +
        `If it was renamed or removed, update scripts/ci/check-crash-loop-constants.mjs.`
    );
    failures++;
    continue;
  }

  if (pty.value !== workspace.value) {
    console.error(
      `::error::crash-loop constant drift: \`${name}\` differs between hosts.\n` +
        `  ${PTY_FILE}: ${pty.raw} (${pty.value})\n` +
        `  ${WORKSPACE_FILE}: ${workspace.raw} (${workspace.value})\n` +
        `The two guards are intentionally duplicated but must hold the same value. ` +
        `Update both sites or document why they diverge.`
    );
    failures++;
  }
}

if (failures > 0) {
  console.error(`\ncrash-loop constant drift detected: ${failures} issue(s).`);
  process.exit(1);
}

console.log("[check-crash-loop-constants] OK — pty-host and workspace-host constants match");
