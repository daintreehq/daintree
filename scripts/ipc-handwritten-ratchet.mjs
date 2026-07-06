#!/usr/bin/env node

/**
 * IpcInvokeMap Hand-Written Entry Ratchet
 *
 * Counts the hand-maintained channel entries in the `IpcInvokeMap` interface
 * body in `shared/types/ipc/maps.ts` and fails the build if that count grows
 * beyond the baseline. The generated half (`GeneratedIpcInvokeMap` in
 * `shared/types/ipc/generated.ts`, produced by `scripts/codegen/ipc-map.mjs`)
 * is inherited via `extends` and not counted here.
 *
 * Every migration PR moving a hand-written entry into a `defineIpcNamespace`
 * block lowers the count; the baseline is then bumped down via `--update`.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");
const MAPS_FILE = join(ROOT, "shared", "types", "ipc", "maps.ts");
const BASELINE_FILE = join(ROOT, "scripts", "baselines", "ipc-handwritten-baseline.json");
const UPDATE_SHRINKAGE_THRESHOLD = 0.1;

const INTERFACE_MARKER = "export interface IpcInvokeMap extends GeneratedIpcInvokeMap {";
const ENTRY_LINE = /^ {2}"[^"]+": *\{/;

/**
 * Count hand-written channel entries in an `IpcInvokeMap` interface body.
 * Throws if the interface marker or its closing brace cannot be located —
 * a silent zero would let the ratchet pass on a corrupted/refactored
 * `maps.ts`, which is exactly the regression this script exists to catch.
 */
export function countHandWrittenEntries(source) {
  const lines = source.split("\n");
  const startIdx = lines.findIndex((l) => l.startsWith(INTERFACE_MARKER));
  if (startIdx === -1) {
    throw new Error(`Could not find IpcInvokeMap interface marker: "${INTERFACE_MARKER}"`);
  }

  let endIdx = -1;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i] === "}") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    throw new Error("Could not find closing `}` for IpcInvokeMap interface body");
  }

  let count = 0;
  for (let i = startIdx + 1; i < endIdx; i++) {
    if (ENTRY_LINE.test(lines[i])) count++;
  }
  return count;
}

/**
 * Guards `--update` against a sudden large drop in the count, which usually
 * signals a parser bug or a refactor that broke the regex — locking that
 * undercount in as the new baseline would silently re-allow regressions.
 * Returns `{ blocked: true, message }` or `{ blocked: false }`.
 */
export function checkShrinkageGuard(
  priorCount,
  newCount,
  force,
  threshold = UPDATE_SHRINKAGE_THRESHOLD
) {
  if (force) return { blocked: false };
  if (!Number.isFinite(priorCount) || priorCount <= 0) return { blocked: false };

  const drop = (priorCount - newCount) / priorCount;
  if (drop > threshold) {
    return {
      blocked: true,
      message: `::error::refusing to update baseline — hand-written IpcInvokeMap entries would drop from ${priorCount} to ${newCount} (${(drop * 100).toFixed(1)}% shrinkage > ${(threshold * 100).toFixed(0)}% threshold).`,
    };
  }
  return { blocked: false };
}

function main() {
  const isUpdate = process.argv.includes("--update");
  const force = process.argv.includes("--force");

  let source;
  try {
    source = readFileSync(MAPS_FILE, "utf-8");
  } catch (err) {
    console.error(`❌ Failed to read ${MAPS_FILE}`);
    console.error(`   ${err.message}`);
    process.exit(1);
  }

  let count;
  try {
    count = countHandWrittenEntries(source);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    console.error("   The IpcInvokeMap interface in shared/types/ipc/maps.ts may have been");
    console.error("   refactored or reformatted. Inspect the file and update the ratchet.");
    process.exit(1);
  }

  console.log(`📊 Hand-written IpcInvokeMap entries: ${count}`);

  if (isUpdate) {
    if (existsSync(BASELINE_FILE)) {
      let priorCount = 0;
      try {
        const prior = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
        if (prior && typeof prior.count === "number" && Number.isFinite(prior.count)) {
          priorCount = prior.count;
        }
      } catch {
        // Unparseable prior baseline — let the update proceed; the previous
        // baseline is unusable anyway.
      }
      const guard = checkShrinkageGuard(priorCount, count, force);
      if (guard.blocked) {
        console.error(guard.message);
        console.error(
          "   This usually means the parser broke (regex/marker mismatch after a refactor)."
        );
        console.error("   If the shrinkage is intentional, re-run with --force.");
        process.exit(1);
      }
    }

    const baseline = { count, updatedAt: new Date().toISOString() };
    writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + "\n");
    console.log(`✅ Baseline updated: ${count} hand-written entries`);
    return;
  }

  if (!existsSync(BASELINE_FILE)) {
    console.error(`❌ Baseline file not found: ${BASELINE_FILE}`);
    console.error("   Run: npm run ipc-handwritten:update");
    process.exit(1);
  }

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf-8"));
  } catch (err) {
    console.error(`❌ Failed to parse baseline file: ${BASELINE_FILE}`);
    console.error(`   Error: ${err.message}`);
    process.exit(1);
  }

  if (
    typeof baseline.count !== "number" ||
    !Number.isFinite(baseline.count) ||
    baseline.count < 0
  ) {
    console.error("❌ Invalid baseline: count must be a finite non-negative number");
    console.error(`   Found: ${JSON.stringify(baseline.count)}`);
    process.exit(1);
  }

  const baselineCount = baseline.count;
  const diff = count - baselineCount;

  if (diff > 0) {
    console.error(
      `❌ Hand-written IpcInvokeMap entries increased by ${diff} (baseline: ${baselineCount}).`
    );
    console.error(
      "   New IPC handlers must be added via defineIpcNamespace blocks in electron/ipc/handlers/,"
    );
    console.error("   not as hand-written entries in shared/types/ipc/maps.ts.");
    console.error("   See scripts/codegen/ipc-map.mjs for the codegen pipeline.");
    process.exit(1);
  } else if (diff < 0) {
    console.log(
      `🎉 Hand-written entries decreased by ${Math.abs(diff)} (baseline: ${baselineCount}).`
    );
    console.log("   Lower the baseline: npm run ipc-handwritten:update");
  } else {
    console.log(`✅ No new hand-written entries (baseline: ${baselineCount}).`);
  }
}

const invokedDirectly = process.argv[1] && process.argv[1] === __filename;
if (invokedDirectly) {
  main();
}
