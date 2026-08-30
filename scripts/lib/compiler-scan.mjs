// The one place React Compiler diagnostics are collected.
//
// Both compiler tools read from here — the budget gate
// (`check-compiler-budget.mjs`) and the critical-error triage
// (`find-critical-compiler-errors.mjs`) — so the two can no longer disagree
// about what was measured or how. They used to: the gate took its numbers from
// a logger threaded into the real `vite build`, while the triage script ran its
// own Babel pass over `src/**` alone. That left the triage blind to the
// `plugins/builtin/*/renderer/**` files the gate tracked, and left the two
// running the compiler under different options.
//
// Why a filesystem scan rather than the build's own logger: a bundler reports
// whatever its module graph happens to reach, which moves with tree-shaking,
// dynamic imports and entry changes. That is a sample of compiler health, not a
// stable policy surface — and it was never "the files that ship" either, since
// most of what the compiler transforms is later tree-shaken out of the emitted
// chunks. React Compiler diagnostics are file-local, so the honest unit is the
// file on disk. The scan set is declared here, in one place, and recorded in
// the report so a change of scope is visible rather than inferred.

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { globSync } from "glob";
import * as babel from "@babel/core";
import { reactCompilerPreset } from "@vitejs/plugin-react";
import { LintRules } from "babel-plugin-react-compiler";
import { SCAN_PATTERNS, SCAN_IGNORE, toPosixRelative } from "./compiler-scan-surface.mjs";

export { SCAN_PATTERNS, SCAN_IGNORE };

// Bumped whenever this collector's own semantics change — how it filters, how
// it parses, how it buckets severities. The fingerprint carries it so a
// baseline written by an older collector is refused rather than compared
// against numbers that were produced by different rules.
const COLLECTOR_REVISION = 1;

// A single file with thousands of identical skip reasons or a repeated
// serialized stack would otherwise be retained and printed in full. Counts
// stay exact; only the retained samples are bounded.
const MAX_SAMPLES_PER_FILE = 20;
const MAX_SAMPLE_LENGTH = 200;

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Mirrors the `reactCompilerPreset` call in `vite.config.ts`. `target` is the
// plugin's own default today, but it is stated rather than inherited: the build
// states it, and a scan that agreed only by coincidence would drift the first
// time the default moved.
export const COMPILER_OPTIONS = {
  compilationMode: "infer",
  // The build uses "none" so a compiler hiccup can never crash the renderer
  // build. Here it means a diagnostic is reported rather than thrown, which is
  // the whole point of the pass.
  panicThreshold: "none",
  target: "19",
};

// `reactCompilerPreset` returns the Babel preset AND the source filter Rolldown
// applies before handing a module to Babel. Taking the preset without the
// filter would measure a strictly broader surface than the build compiles, so
// both come from the same call.
function buildPreset(logger) {
  const { preset, rolldown } = reactCompilerPreset({ ...COMPILER_OPTIONS, logger });
  return { preset, codeFilter: rolldown.filter.code };
}

// Rolldown's per-extension parser configuration (`@rolldown/plugin-babel`).
// `.ts` deliberately does NOT get the `jsx` plugin — with both enabled Babel
// parses `<T>(x)` as JSX rather than a type assertion, so a `.ts` file using
// that syntax would fail to parse and silently drop out of the scan.
function parserOptsFor(file) {
  const plugins = file.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"];
  return { sourceType: "module", allowAwaitOutsideFunction: true, plugins };
}

const SEVERITY_BY_CATEGORY = Object.fromEntries(LintRules.map((r) => [r.category, r.severity]));
export const HINT_CATEGORIES = new Set(
  LintRules.filter((r) => r.severity === "Hint").map((r) => r.category)
);

/**
 * Split one `CompileError` event into Hint count and strict bailouts.
 *
 * Exported because it is the whole severity policy, and the alternative to
 * testing it directly is a twenty-second scan of the real tree that can only
 * assert on whatever violations happen to exist that day.
 */
export function bucketCompileError(event) {
  const detail = event?.detail;
  const children = detailsOf(detail);
  if (children.length === 0) {
    // No detail object at all: unclassifiable, so it is counted strictly
    // rather than written off as cosmetic.
    return {
      hints: 0,
      strict: [
        {
          category: "Unknown",
          severity: "Error",
          reason: "malformed CompileError event (no detail object)",
          line: lineOf(undefined, detail, event),
        },
      ],
    };
  }
  let hints = 0;
  const strict = [];
  for (const d of children) {
    const category = String(d?.category ?? detail?.category ?? "");
    // Resolved from the category map, never from `d.severity`. That getter
    // throws ("Unsupported category X") for any category not in the plugin's
    // own internal switch, so reading it would crash the scan the first time an
    // upstream version emits a new one. Unknown categories default to "Error"
    // so they land in the strict gate rather than being written off as
    // cosmetic.
    const severity = SEVERITY_BY_CATEGORY[category] ?? "Error";
    if (severity === "Hint") {
      hints++;
    } else {
      strict.push({
        category,
        severity,
        reason: describe(d, detail),
        line: lineOf(d, detail, event),
      });
    }
  }
  return { hints, strict };
}

function emptyEntry() {
  return {
    success: 0,
    skip: 0,
    error: 0,
    pipeline: 0,
    hintCount: 0,
    errorBailouts: [],
    skipReasons: [],
    pipelineErrors: [],
  };
}

// A `CompileError` event carries either a single detail object or a diagnostic
// holding children. Both shapes put `severity` on the entry we end up reading,
// so normalising to an array here keeps the severity split in one place.
function detailsOf(detail) {
  if (!detail) return [];
  // `CompilerErrorDetail` is its own leaf. `CompilerDiagnostic` keeps its
  // children under `options.details` — NOT `details`, which is why reading the
  // public-looking property alone returns the parent and silently collapses a
  // multi-location diagnostic to one entry.
  const children = detail.options?.details ?? detail.details;
  return Array.isArray(children) && children.length > 0 ? children : [detail];
}

// `CompilerDiagnostic` exposes `primaryLocation()` rather than a `loc` field,
// so reading only `loc` reports the enclosing function's line instead of the
// offending expression's.
function lineOf(d, parent, event) {
  const candidates = [
    d?.loc,
    typeof d?.primaryLocation === "function" ? d.primaryLocation() : undefined,
    typeof parent?.primaryLocation === "function" ? parent.primaryLocation() : undefined,
    parent?.loc,
    event?.fnLoc,
  ];
  for (const loc of candidates) {
    const line = loc?.start?.line ?? loc?.line;
    if (typeof line === "number") return line;
  }
  return null;
}

// Deduplicated and bounded. The gate counts events, not samples, so dropping
// repeats past the cap costs nothing a decision depends on.
function pushSample(list, value) {
  const text = String(value ?? "").slice(0, MAX_SAMPLE_LENGTH);
  if (text.length === 0) return;
  if (list.length >= MAX_SAMPLES_PER_FILE) return;
  if (list.includes(text)) return;
  list.push(text);
}

function describe(d, parent) {
  return d?.reason ?? d?.description ?? parent?.reason ?? parent?.description ?? "(unknown)";
}

/**
 * Run the React Compiler over the declared scan set.
 *
 * Returns the per-file diagnostics, the full list of files that were scanned
 * (including the ones that produced nothing), and a fingerprint of how the scan
 * was configured. The scan list is what lets the gate tell a file that was
 * cleaned up apart from a file the collector failed to look at — an
 * event-keyed report alone cannot distinguish those, which is how a baseline
 * quietly stops covering things.
 */
export async function scanCompilerDiagnostics({ onProgress } = {}) {
  // Callers pass this because the scan is a ~20-second wall of silence
  // otherwise. It fires once per file disposed of, compiled or not, so it
  // always reaches the total.
  // `posix: true` because these strings are the baseline's keys. Without it
  // glob returns platform separators, so a baseline written on macOS would
  // report every one of its entries as missing when checked on Windows.
  const discovered = [
    ...new Set(
      SCAN_PATTERNS.flatMap((p) =>
        globSync(p, { cwd: ROOT, ignore: SCAN_IGNORE, posix: true }).map(toPosixRelative)
      )
    ),
  ].sort();

  const files = {};
  const failures = [];
  const filtered = [];
  let currentFile = null;

  const logger = {
    logEvent(_filename, event) {
      // Keyed on the file being driven, not on `event.filename`: the compiler
      // reports the absolute path it was handed, and one source of truth for
      // the key means the report can never contain a path the scan set does
      // not also contain.
      if (currentFile === null) return;
      const entry = (files[currentFile] ??= emptyEntry());
      switch (event.kind) {
        case "CompileSuccess":
          entry.success++;
          break;
        case "CompileSkip": {
          entry.skip++;
          if (typeof event.reason === "string" && event.reason.length > 0) {
            pushSample(entry.skipReasons, event.reason);
          }
          break;
        }
        case "CompileError": {
          entry.error++;
          const { hints, strict } = bucketCompileError(event);
          entry.hintCount += hints;
          entry.errorBailouts.push(...strict);
          break;
        }
        case "PipelineError": {
          entry.pipeline++;
          // `data` is a serialized stack; the first line is the message and the
          // rest is noise that would be stored and reprinted verbatim.
          pushSample(entry.pipelineErrors, String(event.data ?? "").split(/\r?\n/)[0]);
          break;
        }
        default:
          break;
      }
    },
  };

  const { preset, codeFilter } = buildPreset(logger);

  const scanned = [];
  let processed = 0;
  for (const rel of discovered) {
    const abs = path.join(ROOT, rel);
    let source;
    try {
      source = await readFile(abs, "utf8");
    } catch (err) {
      failures.push({ file: rel, stage: "read", message: String(err?.message ?? err) });
      onProgress?.(++processed, discovered.length);
      continue;
    }
    // The build's own gate. A file the filter rejects is never handed to Babel
    // there, so counting it here would inflate the budget with files the
    // compiler does not process.
    if (!codeFilter.test(source)) {
      // Recorded, not just skipped. "The filter rejected this" and "the
      // collector never got to this" both leave a file with no diagnostics,
      // and only the second one is a bug — keeping them apart is what lets the
      // gate fail on lost coverage without failing on a file that simply
      // stopped holding React code.
      filtered.push(rel);
      onProgress?.(++processed, discovered.length);
      continue;
    }
    scanned.push(rel);
    currentFile = rel;
    try {
      await babel.transformAsync(source, {
        filename: abs,
        babelrc: false,
        configFile: false,
        parserOpts: parserOptsFor(rel),
        presets: [preset],
      });
    } catch (err) {
      // Never swallowed. A file that cannot be parsed is a hole in the scan,
      // and a hole that reports as "no diagnostics" is worse than a loud
      // failure — it is how coverage disappears without anyone noticing.
      failures.push({ file: rel, stage: "transform", message: String(err?.message ?? err) });
    } finally {
      currentFile = null;
    }
    onProgress?.(++processed, discovered.length);
  }

  return {
    fingerprint: fingerprintOf(codeFilter),
    // Everything the glob matched, whether or not the code filter let it
    // through. `discovered` is the declared scope, `scanned` and `filtered`
    // together are what actually got a decision. A file in `discovered` that
    // appears in neither was silently dropped, which is the failure this pair
    // of lists exists to make visible.
    discovered,
    scanned,
    filtered,
    files,
    failures,
  };
}

// Everything that changes what the numbers mean. The gate compares this against
// the baseline's copy, so a change of scope, options, tooling or collector
// semantics is reported as "these are not comparable" rather than silently
// reflowing the budget.
//
// Every version here is required. An unresolvable one used to be recorded as
// "unknown", which is worse than failing: the first update banks "unknown" and
// every later unknown then compares equal to it.
function versionOf(pkg) {
  try {
    // Read from disk rather than `require(`${pkg}/package.json`)`: several of
    // these packages publish an `exports` map that does not expose their own
    // manifest, so the specifier form throws for reasons unrelated to the
    // package being installed.
    const manifest = path.join(ROOT, "node_modules", ...pkg.split("/"), "package.json");
    const version = JSON.parse(readFileSync(manifest, "utf8")).version;
    if (typeof version === "string" && version.length > 0) return version;
  } catch {
    // Fall through to the throw below — the message names the package.
  }
  throw new Error(
    `[compiler-scan] cannot resolve the installed version of "${pkg}"; the scan fingerprint would be incomplete and the baseline unsafe to compare. Run \`npm install\`.`
  );
}

function fingerprintOf(codeFilter) {
  return {
    collectorRevision: COLLECTOR_REVISION,
    versions: {
      "babel-plugin-react-compiler": versionOf("babel-plugin-react-compiler"),
      "@babel/core": versionOf("@babel/core"),
      "@vitejs/plugin-react": versionOf("@vitejs/plugin-react"),
      glob: versionOf("glob"),
    },
    options: { ...COMPILER_OPTIONS },
    patterns: [...SCAN_PATTERNS],
    ignore: [...SCAN_IGNORE],
    codeFilter: String(codeFilter),
    // Stated rather than implied: these are hand-mirrored from Rolldown's
    // Babel plugin, so a change there has to move this string too.
    parser: "sourceType=module;allowAwaitOutsideFunction;tsx=[typescript,jsx];ts=[typescript]",
    // The severity split is derived from LintRules at runtime, so a plugin
    // upgrade that recategorizes a rule must invalidate the baseline.
    hintCategories: [...HINT_CATEGORIES].sort(),
  };
}

/** Hint-severity count for a report/baseline entry. */
export function getHintCount(entry) {
  return typeof entry?.hintCount === "number" && Number.isFinite(entry.hintCount)
    ? entry.hintCount
    : 0;
}

/** Error+Warning bailouts for a report/baseline entry. */
export function getStrictBailouts(entry) {
  return Array.isArray(entry?.errorBailouts)
    ? entry.errorBailouts.filter(
        (b) => b && typeof b === "object" && !HINT_CATEGORIES.has(b.category)
      )
    : [];
}
