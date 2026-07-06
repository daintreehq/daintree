#!/usr/bin/env node

// Walks dist/.vite/manifest.json from a fixed seed list (the renderer entry
// chunk plus the React.lazy() dynamic imports rendered on the first-paint
// path) and sums the gzipped bytes of every reachable chunk. The closure is
// "what the user actually downloads before they can interact" — eager imports
// plus the lazy chunks for any panel restored from the previous session.
//
// Compares against the checked-in first-render-chunk-baseline.json.
//
// This budget is not wired into CI pre-1.0 (see .github/workflows/ci.yml) — it
// runs locally on demand. There is no override flag: when the budget is
// reintroduced as a CI gate, an intentional regression is accepted by applying
// the `first-render-chunk-override` label to the PR with a linked tracking
// issue (the label is checked by scripts/check-budget-override-gate.mjs, which
// is also dormant until budgets gate CI again).
//
// Usage:
//   node scripts/check-first-render-chunk-budget.mjs                   # check mode (local, not wired to CI pre-1.0)
//   node scripts/check-first-render-chunk-budget.mjs --update          # write baseline
//   node scripts/check-first-render-chunk-budget.mjs --update --force  # bypass shrink guard
//   node scripts/check-first-render-chunk-budget.mjs --threshold 0.10  # 10% growth allowed

import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { formatBudgetSummary, writeSummary } from "./budget-summary-lib.mjs";
import { collectClosure as collectClosureGeneric } from "./first-render-closure-lib.mjs";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const DIST = path.join(ROOT, "dist");
const MANIFEST_FILE = path.join(DIST, ".vite", "manifest.json");
const SEEDS_FILE = path.join(DIST, ".vite", "first-render-seeds.json");
const BASELINE_FILE = path.join(ROOT, "scripts", "baselines", "first-render-chunk-baseline.json");
const SUMMARY_FILE = path.join(DIST, "first-render-chunk-summary.md");

// Seed list: every source path that is part of the renderer's first-paint
// bundle. The renderer entry chunk is auto-detected via `isEntry`. The seeds
// are the app root (src/App.tsx — dynamically imported by the entry shell) plus
// the React.lazy boundaries in src/panels/registry.tsx that resolve immediately
// when a persisted browser/dev-preview/review panel is restored — i.e. on the
// first-render path even though they're nominally "lazy".
//
// The list is no longer hardcoded here: it's derived from the panel-kind
// registry (shared/config/panelKindRegistry.ts → getFirstRenderPreloadSeeds) and
// emitted to dist/.vite/first-render-seeds.json by firstRenderSeedsPlugin at
// build time. This script can't import the TS registry directly from plain
// Node ESM, so it reads the emitted artifact. Keeping the registry as the
// single source of truth is the whole point — see #8895.

const DEFAULT_THRESHOLD = 0.05;
const UPDATE_SHRINKAGE_THRESHOLD = 0.1;

// Pure shrink guard: returns an error message when the eager gzip would drop
// more than `threshold` (fraction) below the prior baseline, else null. Kept
// pure (no IO / no process.exit) so it's directly unit-testable, mirroring
// check-renderer-import-budget.mjs.
export function shrinkageGuardError(priorGzip, nextGzip, threshold) {
  if (typeof priorGzip !== "number" || priorGzip <= 0) return null;
  const drop = (priorGzip - nextGzip) / priorGzip;
  if (drop <= threshold) return null;
  return `eager first-render gzip would drop from ${priorGzip} to ${nextGzip} (${(drop * 100).toFixed(1)}% shrinkage > ${(threshold * 100).toFixed(0)}% threshold)`;
}

function parseArgs(argv) {
  const args = { isUpdate: false, force: false, threshold: DEFAULT_THRESHOLD };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--update") args.isUpdate = true;
    else if (arg === "--force") args.force = true;
    else if (arg === "--threshold" && argv[i + 1]) {
      const val = argv[i + 1];
      args.threshold = parseFloat(val);
      if (!Number.isFinite(args.threshold) || args.threshold < 0 || args.threshold > 1) {
        console.error(`::error::invalid threshold: ${val} (must be 0–1)`);
        process.exit(1);
      }
      i++;
    }
  }
  return args;
}

function readManifest() {
  if (!existsSync(MANIFEST_FILE)) {
    console.error(
      `::error::first-render-chunk manifest not found at ${path.relative(ROOT, MANIFEST_FILE)}`
    );
    console.error(
      "   Run `vite build` first (manifest emission is enabled via build.manifest in vite.config.ts)."
    );
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(MANIFEST_FILE, "utf8"));
  } catch (err) {
    console.error(`::error::failed to parse manifest: ${err.message}`);
    process.exit(1);
  }
}

// Reads the registry-derived seed list emitted by firstRenderSeedsPlugin. Fails
// loud on a missing/invalid/empty artifact rather than falling back to a
// hardcoded list — a silently-empty seed set would measure only the entry chunk
// and let a regression slip past the gate, exactly the drift #8895 closes.
function readFirstRenderSeeds() {
  if (!existsSync(SEEDS_FILE)) {
    console.error(`::error::first-render seeds not found at ${path.relative(ROOT, SEEDS_FILE)}`);
    console.error(
      "   Run `vite build` first (seeds artifact emitted by firstRenderSeedsPlugin in vite.config.ts)."
    );
    process.exit(1);
  }
  let seeds;
  try {
    seeds = JSON.parse(readFileSync(SEEDS_FILE, "utf8"));
  } catch (err) {
    console.error(`::error::failed to parse first-render seeds: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(seeds) || seeds.some((s) => typeof s !== "string" || s.length === 0)) {
    console.error("::error::first-render seeds must be a non-empty array of source-path strings");
    process.exit(1);
  }
  if (seeds.length === 0) {
    console.error(
      "::error::first-render seeds is empty — the registry produced no firstRenderRestore kinds"
    );
    process.exit(1);
  }
  return seeds;
}

// BFS the manifest graph. `imports[]` and `dynamicImports[]` reference other
// manifest keys (source paths). Visiting by manifest key (not file name) avoids
// double-counting chunks shared via Rolldown's `codeSplitting.groups`
// (vendor-react, vendor-xterm…).
//
// `followDynamic` selects the closure semantics:
//   • false (eager) — follow only `imports[]`. This is the true "download
//     before interactive" cost: the entry plus everything statically reachable
//     from it (and from the explicit first-render seeds). This is the GATED
//     metric — the regression CI fails on.
//   • true (total)  — follow both `imports[]` and `dynamicImports[]`, i.e. the
//     entire reachable bundle. Report-only, retained as a coarse total-bundle
//     regression signal.
//
// The seeds (renderer entry + the registry-derived first-render seeds) are
// always enqueued explicitly regardless of `followDynamic` — they're first-paint
// paths by definition (a persisted browser/dev-preview/review panel restores
// synchronously), not edges discovered by walking `dynamicImports[]`.
//
// Thin manifest adapter over the shared first-render-closure-lib traversal: the
// firstRenderModulePreloadPlugin in vite.config.ts walks the same graph through
// the OutputBundle (keyed by file name), so the gated closure measured here and
// the preload set injected there share one BFS and can't drift (#9771). Default
// `followDynamic: true` (the total walk) is preserved for the existing callers.
export function collectClosure(manifest, seedKeys, { followDynamic = true } = {}) {
  return collectClosureGeneric(seedKeys, {
    getNode: (key) => manifest[key],
    getStaticImports: (chunk) => chunk.imports,
    getDynamicImports: (chunk) => chunk.dynamicImports,
    followDynamic,
  });
}

function findEntryKey(manifest) {
  for (const [key, chunk] of Object.entries(manifest)) {
    if (chunk?.isEntry) return key;
  }
  return null;
}

function gzipBytesFor(file) {
  const filePath = path.join(DIST, file);
  if (!existsSync(filePath)) {
    return { ok: false, error: `missing chunk file: ${path.relative(ROOT, filePath)}` };
  }
  const stat = statSync(filePath);
  if (!stat.isFile()) {
    return { ok: false, error: `not a file: ${path.relative(ROOT, filePath)}` };
  }
  const buf = readFileSync(filePath);
  const gz = gzipSync(buf, { level: 9 }).byteLength;
  return { ok: true, raw: buf.byteLength, gzip: gz };
}

// Size every chunk in a closure, returning the per-chunk map, summed
// raw/gzip totals, and any missing-file errors. Pure given a manifest +
// closure set, so the gzip work is shared between the eager and total walks.
function sizeClosure(manifest, closure) {
  const chunks = {};
  let totalRaw = 0;
  let totalGzip = 0;
  const missing = [];

  for (const key of [...closure].sort()) {
    const chunk = manifest[key];
    if (!chunk?.file) continue;
    const sized = gzipBytesFor(chunk.file);
    if (!sized.ok) {
      missing.push(sized.error);
      continue;
    }
    chunks[key] = { file: chunk.file, raw: sized.raw, gzip: sized.gzip };
    totalRaw += sized.raw;
    totalGzip += sized.gzip;
  }

  return { chunks, totals: { raw: totalRaw, gzip: totalGzip }, missing };
}

function buildReport(manifest, lazySeeds) {
  const entryKey = findEntryKey(manifest);
  if (!entryKey) {
    console.error("::error::no entry chunk found in manifest (no chunk has isEntry: true)");
    process.exit(1);
  }

  const seedKeys = [entryKey, ...lazySeeds];

  // Eager walk (gated): the static first-render closure.
  const eagerClosure = collectClosure(manifest, seedKeys, { followDynamic: false });
  const eager = sizeClosure(manifest, eagerClosure);

  // Total walk (report-only): the full reachable bundle, retained as a coarse
  // total-bundle regression signal.
  const totalClosure = collectClosure(manifest, seedKeys, { followDynamic: true });
  const total = sizeClosure(manifest, totalClosure);

  for (const m of [...eager.missing, ...total.missing]) console.warn(`::warning::${m}`);

  const seedsResolved = lazySeeds.filter((s) => Boolean(manifest[s]));
  const seedsMissing = lazySeeds.filter((s) => !manifest[s]);
  for (const s of seedsMissing) {
    console.warn(
      `::warning::seed ${s} not present in manifest — closure may be undercounted (rename or refactor?)`
    );
  }

  return {
    entryKey,
    seeds: { resolved: seedsResolved, missing: seedsMissing },
    // `chunks`/`chunkCount` describe the eager first-render set — the purpose
    // of this baseline file. `eagerTotals` is the gated metric; `totals` is the
    // full-bundle figure kept for report-only regression visibility.
    chunkCount: Object.keys(eager.chunks).length,
    chunks: eager.chunks,
    eagerTotals: eager.totals,
    totals: total.totals,
  };
}

function writeBaseline(report, { force }) {
  if (existsSync(BASELINE_FILE) && !force) {
    try {
      const prior = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
      // Guard the gated metric (eager first-render gzip), not the report-only
      // total — that's the figure CI fails on and the one --force is meant to
      // re-baseline after an intentional shrink.
      const guardError = shrinkageGuardError(
        prior?.eagerTotals?.gzip,
        report.eagerTotals.gzip,
        UPDATE_SHRINKAGE_THRESHOLD
      );
      if (guardError) {
        console.error(`::error::refusing to update baseline — ${guardError}.`);
        console.error("   If the shrinkage is intentional, re-run with --force.");
        process.exit(1);
      }
    } catch {
      // Unparseable prior — let the update proceed.
    }
  }

  const sortedChunks = Object.keys(report.chunks)
    .sort()
    .reduce((acc, k) => {
      acc[k] = report.chunks[k];
      return acc;
    }, {});

  const out = {
    entryKey: report.entryKey,
    seeds: report.seeds,
    chunkCount: report.chunkCount,
    chunks: sortedChunks,
    eagerTotals: report.eagerTotals,
    totals: report.totals,
  };

  writeFileSync(BASELINE_FILE, JSON.stringify(out, null, 2) + "\n");
  console.log(
    `[check-first-render-chunk-budget] baseline updated: ${report.chunkCount} eager chunks, eager gzip=${report.eagerTotals.gzip} (total bundle gzip=${report.totals.gzip})`
  );
}

// Pure four-state classifier for the first-render budget. Does NOT change the
// gate — `ratio > threshold` still determines `ok` in `compareToBaseline`. The
// classification is reviewer visibility: it tells the PR author whether their
// change is a genuine win, a regression, a shift-trap (bytes moved from eager
// to lazy but total bundle grew), or a watch (eager stable, total creeping up).
//
// `stabilityBytes` (default 1024) defines the noise floor — deltas within this
// band are treated as "stable" rather than meaningful movement.
export function classifyFirstRenderBudget(
  { delta, totalDelta, ratio, threshold },
  { stabilityBytes = 1024 } = {}
) {
  const descriptions = {
    regression: "Eager first-render gzip grew beyond the threshold — this is a gating failure.",
    win: "Eager closure shrank with no net increase in total bundle size.",
    "shift-trap":
      "Eager bytes moved to lazy chunks but total bundle grew — verify the split was intentional.",
    watch: "Eager bytes are stable but total bundle size crept up — monitor for trend.",
    pass: "All metrics within thresholds.",
  };

  if (ratio > threshold) {
    return {
      classification: "regression",
      emoji: "🔴",
      label: "Regression",
      description: descriptions.regression,
    };
  }
  if (delta <= -stabilityBytes && totalDelta <= stabilityBytes) {
    return { classification: "win", emoji: "🟢", label: "Win", description: descriptions.win };
  }
  if (delta <= -stabilityBytes && totalDelta > stabilityBytes) {
    return {
      classification: "shift-trap",
      emoji: "⚠️",
      label: "Shift trap",
      description: descriptions["shift-trap"],
    };
  }
  if (Math.abs(delta) <= stabilityBytes && totalDelta > stabilityBytes) {
    return {
      classification: "watch",
      emoji: "🟡",
      label: "Watch",
      description: descriptions.watch,
    };
  }
  return { classification: "pass", emoji: "✅", label: "Pass", description: descriptions.pass };
}

function compareToBaseline(report, threshold) {
  if (!existsSync(BASELINE_FILE)) {
    console.error(
      `::error::baseline not found at ${path.relative(ROOT, BASELINE_FILE)}. Run \`npm run first-render-chunk-budget:update\`.`
    );
    process.exit(1);
  }

  const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));

  // The gate is the eager first-render closure. A baseline predating the
  // eager/total split has no `eagerTotals` — there's nothing meaningful to
  // compare against, so demand a refresh rather than silently passing.
  if (typeof baseline?.eagerTotals?.gzip !== "number") {
    console.error(
      "::error::baseline is missing `eagerTotals` — it predates the eager/total split."
    );
    console.error("   Re-run `npm run first-render-chunk-budget:update -- --force` to refresh it.");
    process.exit(1);
  }

  const baselineGzip = baseline.eagerTotals.gzip;
  const currentGzip = report.eagerTotals.gzip;
  const delta = currentGzip - baselineGzip;
  const ratio = baselineGzip > 0 ? delta / baselineGzip : 0;
  const overBudget = ratio > threshold;

  // Report-only: the full reachable bundle (eager + dynamic). Not gated.
  const baselineTotalGzip = baseline?.totals?.gzip ?? 0;
  const currentTotalGzip = report.totals.gzip;
  const totalDelta = currentTotalGzip - baselineTotalGzip;

  const classification = classifyFirstRenderBudget({ delta, totalDelta, ratio, threshold });

  const markdown = formatBudgetSummary({
    title: "First-render chunk gzip budget",
    status: `${classification.emoji} ${classification.label}`,
    headerLine: `eager gzip ${currentGzip} bytes (${delta >= 0 ? "+" : ""}${delta}, ${(ratio * 100).toFixed(2)}%, threshold +${(threshold * 100).toFixed(1)}%)`,
    sections: [
      {
        heading: "Reviewer signal",
        body: [
          `${classification.emoji} **${classification.label}** — ${classification.description}`,
        ],
      },
      {
        heading: "Eager first-render closure (gated)",
        body: [
          `- baseline gzip: ${baselineGzip} bytes`,
          `- current gzip:  ${currentGzip} bytes`,
          `- delta:         ${delta >= 0 ? "+" : ""}${delta} bytes (${(ratio * 100).toFixed(2)}%)`,
          `- threshold:     +${(threshold * 100).toFixed(1)}%`,
          `- eager chunks:  ${report.chunkCount}`,
          `- result:        ${overBudget ? "🔴 OVER BUDGET" : "OK"}`,
        ],
      },
      {
        heading: "Total reachable bundle (report-only)",
        body: [
          `- baseline gzip: ${baselineTotalGzip} bytes`,
          `- current gzip:  ${currentTotalGzip} bytes`,
          `- delta:         ${totalDelta >= 0 ? "+" : ""}${totalDelta} bytes (not gated)`,
        ],
      },
    ],
  });

  const markerComment = `<!-- daintree-first-render-budget classification:"${classification.classification}" delta:${delta} -->`;
  writeSummary(SUMMARY_FILE, markdown + "\n" + markerComment);

  return {
    ok: !overBudget,
    delta,
    ratio,
    baselineGzip,
    currentGzip,
    totalDelta,
    baselineTotalGzip,
    currentTotalGzip,
    classification,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const manifest = readManifest();
  const lazySeeds = readFirstRenderSeeds();
  const report = buildReport(manifest, lazySeeds);

  if (args.isUpdate) {
    writeBaseline(report, { force: args.force });
    return;
  }

  const result = compareToBaseline(report, args.threshold);

  if (result.ok) {
    console.log(
      `[check-first-render-chunk-budget] OK — ${report.chunkCount} chunks, total gzip=${result.currentGzip} (baseline=${result.baselineGzip}, ${(result.ratio * 100).toFixed(2)}%)`
    );
    return;
  }

  console.error(
    `::error::first-render chunk gzip grew from ${result.baselineGzip} to ${result.currentGzip} (+${result.delta}, ${(result.ratio * 100).toFixed(2)}%, threshold +${(args.threshold * 100).toFixed(1)}%)`
  );
  console.error(
    `   If the change is intentional, run \`npm run first-render-chunk-budget:update\` to refresh the baseline.`
  );
  process.exit(1);
}

// Only run main when invoked directly (not when imported by tests).
// pathToFileURL percent-encodes paths with spaces/other non-URL characters so
// the comparison against the already-encoded import.meta.url doesn't silently
// mismatch (which would no-op the check).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
