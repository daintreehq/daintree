#!/usr/bin/env node

// Walks dist/.vite/manifest.json from the renderer entry chunk, following ONLY
// the sync `imports[]` graph (skipping `dynamicImports[]`). The result is the
// set of chunks the renderer pulls in eagerly before any lazy boundary
// (React.lazy() / dynamic import) is hydrated. Compares that set against the
// checked-in renderer-import-baseline.json to catch silent growth — the
// renderer counterpart to scripts/check-import-budget.mjs.
//
// Why chunk-keys (not source files): Vite's manifest tracks compiled chunks,
// and `imports[]` entries are manifest keys, not source paths. BFS-by-key
// avoids double-counting chunks shared via Rolldown codeSplitting groups
// (vendor-react, vendor-xterm, ...). The trade-off vs. source-module counts is
// stability — the chunk graph is what actually loads at runtime.
//
// This budget is not wired into CI pre-1.0 (see .github/workflows/ci.yml) — it
// runs locally on demand.
//
// Usage:
//   node scripts/check-renderer-import-budget.mjs                    # check mode (local, not wired to CI pre-1.0)
//   node scripts/check-renderer-import-budget.mjs --update           # rewrite baseline
//   node scripts/check-renderer-import-budget.mjs --update --force   # bypass 10% shrink guard
//   node scripts/check-renderer-import-budget.mjs --threshold 0.10   # 10% byte growth allowed

import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { formatBudgetSummary, writeSummary } from "./budget-summary-lib.mjs";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const DIST = path.join(ROOT, "dist");
const MANIFEST_FILE = path.join(DIST, ".vite", "manifest.json");
// Sidecar emitted by chunkModulesPlugin in vite.config.ts: chunk name -> sorted
// repo-relative module IDs. Absent on check-only runs that don't rebuild — the
// module-set gate stays inactive in that case (see compareReport).
const CHUNK_MODULES_FILE = path.join(DIST, "chunk-modules.json");
const BASELINE_FILE = path.join(ROOT, "scripts", "baselines", "renderer-import-baseline.json");
const SUMMARY_FILE = path.join(DIST, "renderer-import-budget-summary.md");

// Refuse to overwrite the baseline in --update mode if the eager chunk count
// shrinks by more than this fraction. Mirrors check-import-budget.mjs.
const UPDATE_SHRINKAGE_THRESHOLD = 0.1;

// Allowed growth of eager gzip bytes before the byte gate fails. lazyBarrel's
// real payoff is parse/eval cost (bytes), not chunk count — #8819 — so the
// eager byte total is gated independently of the (strict) chunk-count gate.
// Measured jitter between two consecutive identical-source Rolldown builds is 0
// bytes (the build is deterministic); the 5% slack exists solely to absorb
// cross-environment minifier variance (different Node versions, CI vs. local).
const BYTE_GROWTH_THRESHOLD = 0.05;

// Critical first-load ("T0") vendor chunks that get individual byte ceilings and
// module-set identity tracking (#8890). A regression in one of these can hide
// behind a compensating shrink elsewhere while the aggregate eagerGzip gate
// stays green, so each is gated independently. The catch-all `vendor` chunk is
// deliberately excluded — its composition is too volatile to gate per-chunk.
const T0_CHUNK_ALLOWLIST = new Set(["vendor-react", "vendor-xterm", "vendor-radix-utils"]);

export function parseArgs(argv) {
  const args = { isUpdate: false, force: false, threshold: BYTE_GROWTH_THRESHOLD };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--update") args.isUpdate = true;
    else if (arg === "--force") args.force = true;
    else if (arg === "--threshold") {
      const val = argv[i + 1];
      // Strict numeric form — parseFloat("0.05x") would return 0.05 and a bare
      // trailing `--threshold` would be silently ignored, both of which would
      // run CI against the wrong threshold without any signal.
      if (val === undefined || !/^\d*\.?\d+$/.test(val)) {
        console.error(
          `::error::--threshold requires a numeric value 0–1 (got: ${val ?? "(none)"})`
        );
        process.exit(1);
      }
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

// Return a shallow copy of an object with its keys sorted, for stable baseline
// diffs. Values are copied by reference (already-sorted arrays in our case).
function sortObjectByKey(obj) {
  return Object.keys(obj)
    .sort()
    .reduce((acc, k) => {
      acc[k] = obj[k];
      return acc;
    }, {});
}

function readManifest() {
  if (!existsSync(MANIFEST_FILE)) {
    console.error(`::error::renderer manifest not found at ${path.relative(ROOT, MANIFEST_FILE)}`);
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

function findEntryKey(manifest) {
  for (const [key, chunk] of Object.entries(manifest)) {
    if (chunk?.isEntry) return key;
  }
  return null;
}

// BFS only `imports[]`. Skipping `dynamicImports[]` is the whole point — those
// are React.lazy() / dynamic-import boundaries that should NOT load eagerly.
// Identity is the manifest key so chunks shared via codeSplitting groups are
// visited once. Keys that don't exist in the manifest are skipped, not
// counted — the gate measures real on-disk chunks.
export function collectEagerChunks(manifest, entryKey) {
  const visited = new Set();
  if (!manifest[entryKey]) return visited;

  const queue = [entryKey];
  while (queue.length > 0) {
    const key = queue.shift();
    if (visited.has(key)) continue;

    const chunk = manifest[key];
    if (!chunk) continue;
    visited.add(key);

    for (const dep of chunk.imports ?? []) queue.push(dep);
    // Intentionally NOT walking dynamicImports — those are lazy by design.
  }
  return visited;
}

// Map a manifest key (which carries Rolldown's build-hash, e.g.
// `_vendor-react-CSdVl0cc.js`) to its stable `chunk.name` (e.g. `vendor-react`).
// The hash changes on every build; the name is stable. Falls back to the
// manifest key when `name` is absent so the baseline always has *some*
// identity to compare against.
export function stableChunkId(manifest, key) {
  const chunk = manifest[key];
  if (chunk?.name && typeof chunk.name === "string") return chunk.name;
  return key;
}

// Sum raw + gzip bytes of the on-disk files backing a set of manifest keys.
// Mirrors check-first-render-chunk-budget.mjs (gzip level 9). Missing chunk
// files are skipped — the gate measures real on-disk bytes.
function sumChunkBytes(manifest, keys) {
  let raw = 0;
  let gzip = 0;
  for (const key of keys) {
    const file = manifest[key]?.file;
    if (!file) continue;
    const filePath = path.join(DIST, file);
    if (!existsSync(filePath) || !statSync(filePath).isFile()) continue;
    const buf = readFileSync(filePath);
    raw += buf.byteLength;
    gzip += gzipSync(buf, { level: 9 }).byteLength;
  }
  return { raw, gzip };
}

// Read the build-time module-set sidecar. Returns null when it's absent (a
// check-only run against a dist/ that predates the plugin, or that wasn't
// rebuilt) so the module-set gate can stay inactive rather than error.
function readChunkModules() {
  if (!existsSync(CHUNK_MODULES_FILE)) return null;
  try {
    const parsed = JSON.parse(readFileSync(CHUNK_MODULES_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// Gzip a single on-disk chunk file at level 9 (matching sumChunkBytes). Returns
// null when the manifest key has no backing file — the gate measures real bytes.
function gzipChunk(manifest, key) {
  const file = manifest[key]?.file;
  if (!file) return null;
  const filePath = path.join(DIST, file);
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return null;
  return gzipSync(readFileSync(filePath), { level: 9 }).byteLength;
}

function buildReport() {
  const manifest = readManifest();
  const entryKey = findEntryKey(manifest);
  if (!entryKey) {
    console.error("::error::no entry chunk found in manifest (no chunk has isEntry: true)");
    process.exit(1);
  }

  const closure = collectEagerChunks(manifest, entryKey);
  const chunkIds = [...new Set([...closure].map((k) => stableChunkId(manifest, k)))].sort();
  const eagerNames = new Set(chunkIds);
  const { raw: eagerRaw, gzip: eagerGzip } = sumChunkBytes(manifest, closure);

  // Per-T0-chunk gzip ceilings: gzip each gated chunk's file independently so a
  // single critical chunk's regression can't hide inside the aggregate total.
  const chunkGzip = {};
  for (const key of closure) {
    const name = stableChunkId(manifest, key);
    if (!T0_CHUNK_ALLOWLIST.has(name)) continue;
    const gzip = gzipChunk(manifest, key);
    if (typeof gzip === "number") chunkGzip[name] = gzip;
  }

  // Per-T0-chunk module-set identity, sourced from the build sidecar. Scoped to
  // the gated T0 chunks that are actually eager — keeps the baseline small and
  // the gate focused on the chunks whose composition matters at first load.
  const sidecar = readChunkModules();
  let chunkModules = null;
  if (sidecar) {
    chunkModules = {};
    for (const name of T0_CHUNK_ALLOWLIST) {
      if (!eagerNames.has(name)) continue;
      const mods = sidecar[name];
      if (Array.isArray(mods)) chunkModules[name] = [...mods].sort();
    }
  }

  const report = {
    entryName: stableChunkId(manifest, entryKey),
    eagerChunkCount: chunkIds.length,
    eagerChunks: chunkIds,
    eagerRaw,
    eagerGzip,
  };
  if (Object.keys(chunkGzip).length > 0) report.chunkGzip = chunkGzip;
  // `chunkModules` is set (even to {}) whenever the sidecar was read, so
  // compareReport can distinguish "no module data available" (null — skip)
  // from "module data present" (object — gate, including a stale-build check).
  if (chunkModules !== null) report.chunkModules = chunkModules;
  return report;
}

// Pure helper — exported for tests. Mirrors check-import-budget.mjs shrinkage
// guard. Returns null when the update is safe, or an error message when the
// drop exceeds the threshold (caller exits unless --force).
export function shrinkageGuardError(priorCount, nextCount, threshold) {
  if (typeof priorCount !== "number" || priorCount <= 0) return null;
  const drop = (priorCount - nextCount) / priorCount;
  if (drop <= threshold) return null;
  return (
    `refusing to update baseline — eager chunk count would drop from ${priorCount} to ${nextCount} ` +
    `(${(drop * 100).toFixed(1)}% shrinkage > ${(threshold * 100).toFixed(0)}% threshold).`
  );
}

function writeBaseline(report, { force }) {
  if (existsSync(BASELINE_FILE) && !force) {
    try {
      const prior = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
      const guardError = shrinkageGuardError(
        prior?.eagerChunkCount,
        report.eagerChunkCount,
        UPDATE_SHRINKAGE_THRESHOLD
      );
      if (guardError) {
        console.error(`::error::${guardError}`);
        console.error(
          "   This usually means the build was produced with a different config (renamed entry, split removed)."
        );
        console.error("   If the shrinkage is intentional, re-run with --force.");
        process.exit(1);
      }
    } catch {
      // Unparseable prior baseline — let the update proceed.
    }
  }

  const out = {
    entryName: report.entryName,
    eagerChunkCount: report.eagerChunkCount,
    eagerChunks: report.eagerChunks,
    eagerRaw: report.eagerRaw,
    eagerGzip: report.eagerGzip,
  };
  // Both #8890 fields are sparse: written only when the build produced them, so
  // an older toolchain (no sidecar) doesn't get empty maps that would make the
  // gates noisy. Keys are sorted for a stable diff; module arrays are already
  // sorted upstream in buildReport.
  if (report.chunkGzip && Object.keys(report.chunkGzip).length > 0) {
    out.chunkGzip = sortObjectByKey(report.chunkGzip);
  }
  if (report.chunkModules && Object.keys(report.chunkModules).length > 0) {
    out.chunkModules = sortObjectByKey(report.chunkModules);
  }
  writeFileSync(BASELINE_FILE, JSON.stringify(out, null, 2) + "\n");
  console.log(
    `[check-renderer-import-budget] baseline updated: entry=${report.entryName}, eagerChunkCount=${report.eagerChunkCount}, eagerGzip=${report.eagerGzip}`
  );
}

// Pure helper — exported for tests. Returns the comparison result without
// performing I/O or side effects. The eager byte gate (#8819) only engages
// when both baseline and report carry a positive `eagerGzip` — older baselines
// without the field are compared on chunk count alone.
export function compareReport(report, baseline, byteThreshold = BYTE_GROWTH_THRESHOLD) {
  const baselineCount = baseline?.eagerChunkCount;
  if (typeof baselineCount !== "number" || baselineCount < 0) {
    return {
      ok: false,
      error: "baseline.eagerChunkCount missing or invalid",
    };
  }

  // Guard against hand-edited or corrupted baselines that swap the array for
  // some other shape (e.g. `{}` or `null`) — without this, `new Set(nonArray)`
  // raises a raw TypeError that escapes the structured error reporting.
  const baselineChunks = baseline?.eagerChunks;
  if (baselineChunks != null && !Array.isArray(baselineChunks)) {
    return {
      ok: false,
      error: "baseline.eagerChunks must be an array of chunk names",
    };
  }

  const currentCount = report.eagerChunkCount;
  const baselineKeys = new Set(baselineChunks ?? []);
  const currentKeys = new Set(report.eagerChunks);

  const added = report.eagerChunks.filter((k) => !baselineKeys.has(k));
  const removed = (baselineChunks ?? []).filter((k) => !currentKeys.has(k));

  const countGrew = currentCount > baselineCount;

  // Independent byte gate: lazyBarrel can grow chunk count while shrinking
  // eager bytes, so a count-only baseline ratchet would let bytes regress
  // unnoticed. Allow BYTE_GROWTH_THRESHOLD slack to absorb minifier jitter.
  const baselineGzip = baseline?.eagerGzip;
  const currentGzip = report.eagerGzip;
  const byteGateActive =
    typeof baselineGzip === "number" && baselineGzip > 0 && typeof currentGzip === "number";
  let byteRatio = 0;
  let bytesGrew = false;
  if (byteGateActive) {
    byteRatio = (currentGzip - baselineGzip) / baselineGzip;
    bytesGrew = byteRatio > byteThreshold;
  }

  // Module-set identity gate (#8890): a module can migrate between two T0
  // chunks while leaving both the eager chunk count and the aggregate gzip
  // within budget. Gate the per-chunk module membership of the gated T0 chunks
  // so such silent composition shuffles trip the budget. Active only when the
  // baseline carries `chunkModules` — older baselines skip the gate entirely.
  const baselineModules = baseline?.chunkModules;
  const moduleGateActive =
    baselineModules != null &&
    typeof baselineModules === "object" &&
    !Array.isArray(baselineModules);
  let moduleSetChanged = false;
  let staleBuild = false;
  const moduleDiffs = [];
  if (moduleGateActive) {
    const reportModules = report.chunkModules;
    if (reportModules == null || typeof reportModules !== "object") {
      // The baseline expects module data but the build produced none — the
      // sidecar (dist/chunk-modules.json) is missing, i.e. a stale dist/. Fail
      // loudly rather than silently passing, unlike the back-compat skip above.
      staleBuild = true;
    } else {
      for (const [chunk, baseMods] of Object.entries(baselineModules)) {
        if (!Array.isArray(baseMods)) continue;
        const curMods = Array.isArray(reportModules[chunk]) ? reportModules[chunk] : [];
        const baseSet = new Set(baseMods);
        const curSet = new Set(curMods);
        const addedMods = curMods.filter((m) => !baseSet.has(m));
        const removedMods = baseMods.filter((m) => !curSet.has(m));
        if (addedMods.length > 0 || removedMods.length > 0) {
          moduleSetChanged = true;
          moduleDiffs.push({ chunk, added: addedMods, removed: removedMods });
        }
      }
    }
  }

  // Per-T0-chunk byte ceiling gate (#8890): each gated chunk's gzip is bounded
  // independently using the same growth threshold, so a doubling of one
  // critical vendor chunk can't hide behind a compensating shrink elsewhere.
  // Active only when the baseline carries a non-empty `chunkGzip` map.
  const baselineChunkGzip = baseline?.chunkGzip;
  const t0GateActive =
    baselineChunkGzip != null &&
    typeof baselineChunkGzip === "object" &&
    !Array.isArray(baselineChunkGzip) &&
    Object.keys(baselineChunkGzip).length > 0;
  const t0ByteFailures = [];
  const t0Missing = [];
  if (t0GateActive) {
    const reportChunkGzip = report.chunkGzip ?? {};
    for (const [chunk, baseGzip] of Object.entries(baselineChunkGzip)) {
      if (typeof baseGzip !== "number" || baseGzip <= 0) continue;
      const cur = reportChunkGzip[chunk];
      if (typeof cur !== "number") {
        // A gated T0 chunk left the eager set (became lazy or was renamed) —
        // either a regression or an intentional change that needs --update.
        t0Missing.push(chunk);
        continue;
      }
      const ratio = (cur - baseGzip) / baseGzip;
      if (ratio > byteThreshold) {
        t0ByteFailures.push({ chunk, baseline: baseGzip, current: cur, ratio });
      }
    }
  }

  const result = {
    ok:
      !countGrew &&
      !bytesGrew &&
      !moduleSetChanged &&
      !staleBuild &&
      t0ByteFailures.length === 0 &&
      t0Missing.length === 0,
    baselineCount,
    currentCount,
    added,
    removed,
  };
  if (countGrew) result.grew = true;
  else result.shrank = currentCount < baselineCount;
  if (byteGateActive) {
    result.baselineGzip = baselineGzip;
    result.currentGzip = currentGzip;
    result.byteRatio = byteRatio;
    if (bytesGrew) result.grewBytes = true;
  }
  if (moduleGateActive) {
    if (staleBuild) result.staleBuild = true;
    if (moduleSetChanged) {
      result.moduleSetChanged = true;
      result.moduleDiffs = moduleDiffs;
    }
  }
  if (t0GateActive) {
    if (t0ByteFailures.length > 0) result.t0ByteFailures = t0ByteFailures;
    if (t0Missing.length > 0) result.t0Missing = t0Missing;
  }
  return result;
}

function readBaseline() {
  if (!existsSync(BASELINE_FILE)) {
    console.error(
      `::error::renderer-import baseline not found at ${path.relative(ROOT, BASELINE_FILE)}`
    );
    console.error("   Run `npm run renderer-import-budget:update` to create it.");
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
  } catch (err) {
    console.error(`::error::failed to parse baseline: ${err.message}`);
    process.exit(1);
  }
}

// Build and write the markdown summary for downstream PR-comment aggregation.
// Emitted on both pass and fail paths so the aggregated comment always carries
// a renderer-import-budget block.
function emitSummary(result) {
  const hasGzip = typeof result.currentGzip === "number";
  const gzipNote = hasGzip
    ? `, eager gzip ${result.currentGzip} (baseline ${result.baselineGzip}, ${(result.byteRatio * 100).toFixed(2)}%)`
    : "";

  const headerLine = result.ok
    ? `${result.currentCount} eager chunk(s) (baseline ${result.baselineCount})${gzipNote}`
    : `chunks ${result.baselineCount} → ${result.currentCount}${gzipNote}`;

  const totalsBody = [
    `- eager chunks:    ${result.currentCount} (baseline ${result.baselineCount})`,
  ];
  if (hasGzip) {
    totalsBody.push(
      `- eager gzip:      ${result.currentGzip} bytes (baseline ${result.baselineGzip}, ${(result.byteRatio * 100).toFixed(2)}%)`
    );
  }

  const sections = [{ heading: "Totals", body: totalsBody }];

  if (result.added.length > 0) {
    sections.push({
      heading: "Added eager chunks",
      body: result.added.map((k) => `- \`${k}\``),
    });
  }
  if (result.removed.length > 0) {
    sections.push({
      heading: "Removed eager chunks",
      body: result.removed.map((k) => `- \`${k}\``),
    });
  }

  const markdown = formatBudgetSummary({
    title: "Renderer import budget",
    status: result.ok ? "PASS" : "FAIL",
    headerLine,
    sections,
  });
  writeSummary(SUMMARY_FILE, markdown);
}

function main() {
  const args = parseArgs(process.argv);
  const report = buildReport();

  if (args.isUpdate) {
    writeBaseline(report, { force: args.force });
    return;
  }

  const baseline = readBaseline();
  const result = compareReport(report, baseline, args.threshold);

  if (result.error) {
    console.error(`::error::${result.error}`);
    process.exit(1);
  }

  emitSummary(result);

  const byteSummary =
    typeof result.byteRatio === "number"
      ? `, eager gzip=${result.currentGzip} (baseline=${result.baselineGzip}, ${(result.byteRatio * 100).toFixed(2)}%)`
      : "";

  if (result.ok) {
    if (result.shrank) {
      console.log(
        `::notice::renderer eager chunk count dropped from ${result.baselineCount} to ${result.currentCount} — consider running \`npm run renderer-import-budget:update\` to ratchet the baseline.`
      );
    }
    console.log(
      `[check-renderer-import-budget] OK — ${result.currentCount} eager chunk(s) (baseline=${result.baselineCount})${byteSummary}.`
    );
    return;
  }

  if (result.grew) {
    console.error(
      `::error::renderer eager chunk count grew from ${result.baselineCount} to ${result.currentCount}`
    );
    if (result.added.length > 0) {
      console.error("   New eager chunks:");
      for (const key of result.added) console.error(`     + ${key}`);
    }
    if (result.removed.length > 0) {
      console.error("   Removed eager chunks (counted against budget but still worth noting):");
      for (const key of result.removed) console.error(`     - ${key}`);
    }
  }
  if (result.grewBytes) {
    console.error(
      `::error::renderer eager gzip bytes grew from ${result.baselineGzip} to ${result.currentGzip} (+${(result.byteRatio * 100).toFixed(2)}%, threshold +${(args.threshold * 100).toFixed(1)}%)`
    );
  }
  if (result.staleBuild) {
    console.error(
      "::error::baseline carries per-chunk module sets but the build produced none — dist/chunk-modules.json is missing."
    );
    console.error(
      "   Re-run `vite build` (or `npm run renderer-import-budget:update`) on a fresh dist/."
    );
  }
  if (result.t0Missing) {
    console.error(
      `::error::gated T0 chunk(s) left the eager set: ${result.t0Missing.join(", ")} — became lazy or were renamed.`
    );
  }
  if (result.t0ByteFailures) {
    for (const f of result.t0ByteFailures) {
      console.error(
        `::error::T0 chunk ${f.chunk} gzip grew from ${f.baseline} to ${f.current} (+${(f.ratio * 100).toFixed(2)}%, threshold +${(args.threshold * 100).toFixed(1)}%)`
      );
    }
  }
  if (result.moduleSetChanged) {
    console.error(
      "::error::T0 chunk module composition changed (a module migrated between chunks):"
    );
    for (const d of result.moduleDiffs) {
      console.error(`   ${d.chunk}:`);
      for (const m of d.added) console.error(`     + ${m}`);
      for (const m of d.removed) console.error(`     - ${m}`);
    }
  }
  console.error(
    "   If the regression is intentional (a new boot-critical module), run `npm run renderer-import-budget:update` to refresh the baseline."
  );
  process.exit(1);
}

// Only run main when invoked directly (not when imported by tests).
// Uses pathToFileURL to percent-encode paths that contain spaces or other
// non-URL characters — `file://${process.argv[1]}` would silently mismatch
// import.meta.url (which is already percent-encoded) on such paths, causing
// the script to no-op without running the check.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
