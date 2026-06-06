#!/usr/bin/env node

// Stale-quarantine scan — extraction layer
// ────────────────────────────────────────
// Parses the ripgrep match list for `type: "quarantine"` annotations and pulls
// each annotation's `description` (whose leading YYYY-MM-DD is the quarantine
// date) out of the source. The matching `.github/workflows/stale-quarantine.yml`
// workflow turns the result into GitHub issues.
//
// Why a real object scan instead of a fixed forward line-window: the ESLint rule
// `scripts/eslint-rules/structured-test-skip-annotations.js` imposes NO property
// order, so `description` can sit before `type`, on the next physical line, or
// several lines away. The previous "scan +4 lines for the first quoted ISO date"
// heuristic silently dropped those quarantines (and could latch onto an
// unrelated date). We instead brace-match the innermost object enclosing the
// matched `type:` line and read that object's own `description` field, ignoring
// braces/quotes inside strings and comments.
//
// Usage:
//   node scripts/quarantine-scan-lib.mjs \
//     --root "$GITHUB_WORKSPACE" \
//     --matches "$RUNNER_TEMP/quarantine-matches.json" \
//     --out "$RUNNER_TEMP/stale-quarantines.json" \
//     [--stale-days 30]

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const DEFAULT_STALE_DAYS = 30;

const DATE_RE = /^(\d{4}-\d{2}-\d{2})/;

/**
 * Parse ripgrep `--json` output (one JSON object per line) into a deduplicated
 * list of `{ filePath, lineNum }` for every `match` event. `lineNum` is 1-based,
 * matching ripgrep's `line_number`.
 */
export function parseRipgrepMatches(raw) {
  if (!raw || !raw.trim()) return [];
  const seen = new Set();
  const matches = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // non-JSON / summary lines
    }
    if (!entry || entry.type !== "match") continue;
    const filePath = entry.data?.path?.text;
    const lineNum = entry.data?.line_number;
    if (typeof filePath !== "string" || typeof lineNum !== "number") continue;
    const key = `${filePath}:${lineNum}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({ filePath, lineNum });
  }
  return matches;
}

// Character classes for the lightweight scanner below. We only need enough
// JS/TS lexing to keep braces and the `description` keyword that live inside
// string literals or comments from corrupting the structural scan.
function isWhitespace(ch) {
  return ch === " " || ch === "\t" || ch === "\r" || ch === "\n";
}

/**
 * Offset of the first non-whitespace character on the given 0-based line, or the
 * line-start offset when the line is blank. Used as the anchor that the
 * enclosing object must straddle.
 */
function lineAnchorOffset(source, lineIndex) {
  let line = 0;
  for (let i = 0; i < source.length; i++) {
    if (line === lineIndex) {
      let j = i;
      while (j < source.length && source[j] !== "\n" && isWhitespace(source[j])) j++;
      return j;
    }
    if (source[i] === "\n") line++;
  }
  return source.length;
}

/**
 * Find the innermost `{ … }` object that encloses `anchorOffset`, ignoring
 * braces that appear inside string literals (', ", `) and comments (// and
 * /* *​/). Returns `{ start, end }` char offsets (end exclusive, i.e. just past
 * the closing brace) or null when the anchor is not inside an object literal.
 *
 * The first closing brace whose matched opener sits at-or-before the anchor and
 * whose own position is at-or-after the anchor is, by nesting order, the
 * innermost enclosing object — so we return as soon as we see it.
 */
export function findEnclosingObjectRange(source, anchorOffset) {
  const stack = [];
  let i = 0;
  const n = source.length;

  while (i < n) {
    const ch = source[i];

    // Line comment
    if (ch === "/" && source[i + 1] === "/") {
      i += 2;
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    // Block comment
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // String / template literal — skip to the matching closer, honoring escapes.
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < n) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (ch === "{") {
      stack.push(i);
    } else if (ch === "}") {
      const open = stack.pop();
      if (open !== undefined && open <= anchorOffset && i >= anchorOffset) {
        return { start: open, end: i + 1 };
      }
    }
    i++;
  }
  return null;
}

// Minimal unescape for the captured description text so issue bodies read
// cleanly. Mirrors the common escapes a string literal might carry; anything
// exotic is left as-is rather than risking a wrong transform.
function unescapeStringLiteral(value) {
  return value
    .replace(/\\(["'`\\])/g, "$1")
    .replace(/\\n/g, " ")
    .replace(/\\t/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract the `description` string literal from an object-literal slice. Handles
 * either quote style and a value that begins on the line after `description:`.
 * Returns the unescaped description text, or null when absent / not a literal.
 */
export function extractDescription(objectSlice) {
  const m = objectSlice.match(/\bdescription\s*:\s*(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/);
  if (!m) return null;
  return unescapeStringLiteral(m[2]);
}

/**
 * Given full source and the 0-based line index of a `type: "quarantine"` match,
 * resolve the enclosing annotation object and return `{ date, reason }` or null
 * when no dated description can be found.
 */
export function extractQuarantineEntry(source, lineIndex) {
  const anchor = lineAnchorOffset(source, lineIndex);
  const range = findEnclosingObjectRange(source, anchor);
  if (!range) return null;
  const slice = source.slice(range.start, range.end);
  const description = extractDescription(slice);
  if (!description) return null;
  const dateMatch = description.match(DATE_RE);
  if (!dateMatch) return null;
  const date = dateMatch[1];
  const reason = description
    .slice(date.length)
    .replace(/^[\s:–—-]+/, "")
    .trim();
  return { date, reason };
}

/**
 * Compute the staleness threshold (YYYY-MM-DD) `staleDays` before `now`, in UTC.
 */
export function computeThreshold(now, staleDays) {
  const threshold = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - staleDays)
  );
  return threshold.toISOString().split("T")[0];
}

/**
 * Orchestrate the scan: for each ripgrep match, read the source, extract the
 * quarantine date/reason, and group annotations older than the threshold by
 * repo-relative spec path.
 *
 * @returns {{ thresholdStr: string, staleBySpec: Map<string, Array<{line:number,date:string,reason:string}>>, warnings: string[] }}
 */
export function scanStaleQuarantines({
  rootDir,
  matches,
  now,
  staleDays = DEFAULT_STALE_DAYS,
  readFile,
}) {
  const read = readFile ?? ((p) => readFileSync(p, "utf8"));
  const thresholdStr = computeThreshold(now, staleDays);
  const staleBySpec = new Map();
  const warnings = [];
  const contentCache = new Map();
  const prefix = rootDir.endsWith("/") ? rootDir : `${rootDir}/`;

  for (const match of matches) {
    let content = contentCache.get(match.filePath);
    if (content === undefined) {
      try {
        content = read(match.filePath);
      } catch (err) {
        warnings.push(`Could not read ${match.filePath}: ${err.message}`);
        content = null;
      }
      contentCache.set(match.filePath, content);
    }
    if (content === null) continue;

    const entry = extractQuarantineEntry(content, match.lineNum - 1);
    if (!entry) {
      warnings.push(
        `No dated quarantine description found near ${match.filePath}:${match.lineNum} — skipping.`
      );
      continue;
    }

    // Lexicographic comparison is valid for zero-padded ISO dates. A date equal
    // to the threshold is exactly `staleDays` old and not yet stale.
    if (entry.date >= thresholdStr) continue;

    const relPath = match.filePath.startsWith(prefix)
      ? match.filePath.slice(prefix.length)
      : match.filePath;

    if (!staleBySpec.has(relPath)) staleBySpec.set(relPath, []);
    staleBySpec.get(relPath).push({
      line: match.lineNum,
      date: entry.date,
      reason: entry.reason || "(no reason provided)",
    });
  }

  return { thresholdStr, staleBySpec, warnings };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root") args.root = argv[++i];
    else if (arg === "--matches") args.matches = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--stale-days") args.staleDays = Number(argv[++i]);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.root || !args.matches || !args.out) {
    console.error(
      "Usage: quarantine-scan-lib.mjs --root <dir> --matches <rg.json> --out <result.json> [--stale-days 30]"
    );
    process.exit(1);
  }
  const staleDays = Number.isFinite(args.staleDays) ? args.staleDays : DEFAULT_STALE_DAYS;

  let raw = "";
  if (existsSync(args.matches)) {
    try {
      raw = readFileSync(args.matches, "utf8");
    } catch (err) {
      console.warn(`Could not read matches file ${args.matches}: ${err.message}`);
    }
  }

  const matches = parseRipgrepMatches(raw);
  const { thresholdStr, staleBySpec, warnings } = scanStaleQuarantines({
    rootDir: args.root,
    matches,
    now: new Date(),
    staleDays,
  });

  for (const warning of warnings) console.warn(warning);

  const result = {
    staleDays,
    thresholdStr,
    staleBySpec: Object.fromEntries(staleBySpec),
  };
  writeFileSync(args.out, JSON.stringify(result, null, 2) + "\n");

  const specCount = staleBySpec.size;
  if (specCount === 0) {
    console.log(`No stale quarantine annotations found (threshold: ${thresholdStr}).`);
  } else {
    console.log(
      `Found ${specCount} spec(s) with stale quarantine annotations (threshold: ${thresholdStr}).`
    );
    for (const [relPath, annotations] of staleBySpec) {
      console.log(`  ${relPath}: ${annotations.length} stale annotation(s)`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
