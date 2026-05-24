// Pure helpers for the eager-import budget CI gate. Split from the CLI so the
// BFS, regex scan, and baseline-compare logic can be exercised by unit tests
// without shelling out to esbuild.
//
// Conceptual model:
// - The esbuild metafile `inputs[file].imports[]` describes the source-level
//   import graph. Each edge has a `kind` (`import-statement`, `require-call`,
//   `dynamic-import`) and an `external` flag.
// - The "eager" subgraph is everything reachable from `electron/main.ts` via
//   static `import-statement` edges, stopping at `dynamic-import` boundaries
//   (deferred work) and skipping externals (native modules, Node built-ins).
// - The count of that reachable set is the budget. It should only shrink.
// - Files on the eager path must not contain sync FS / store / SQLite calls
//   unless explicitly allowlisted. The allowlist is by file path, so
//   line-number refactors don't churn the baseline.

import fs from "node:fs";

export const EAGER_EDGE_KINDS = new Set(["import-statement", "require-call"]);

export const SYNC_FS_RE =
  /\b(?:readFileSync|writeFileSync|openSync|appendFileSync|mkdirSync|readdirSync|statSync|lstatSync|existsSync|unlinkSync|renameSync|copyFileSync|rmSync|rmdirSync|realpathSync)\s*\(/g;
export const SYNC_STORE_RE = /\bstore\.get\s*\(/g;
export const SYNC_SQLITE_RE = /new\s+(?:Database|sqlite3\.Database)\s*\(/g;

const SYNC_PATTERNS = [
  { name: "sync-fs", re: SYNC_FS_RE },
  { name: "sync-store-get", re: SYNC_STORE_RE },
  { name: "sync-sqlite", re: SYNC_SQLITE_RE },
];

// Each allowlisted file must carry a one-line header marker naming why the sync
// exception is permitted, so the justification lives next to the code it covers
// instead of in `git blame`. Shape mirrors `// biome-ignore <rule>: <reason>`:
// a `// eager-import-allow:` prefix followed by a non-empty reason. Presence is
// enforced; the reason text is for humans and is not validated.
export const ALLOWLIST_MARKER_RE = /^\s*\/\/\s*eager-import-allow\s*:\s*\S/m;

// How many leading lines of a file are scanned for the marker. Keeps the
// convention "near the top" (after a shebang / license banner) without matching
// an incidental occurrence deep in the file (e.g. inside a string literal).
const ALLOWLIST_MARKER_HEADER_LINES = 20;

/**
 * True if `source` contains a `// eager-import-allow: <reason>` marker.
 * @param {string} source
 * @returns {boolean}
 */
export function hasAllowlistMarker(source) {
  return ALLOWLIST_MARKER_RE.test(source);
}

/**
 * Read each allowlisted file and return the set of files whose header carries
 * the `// eager-import-allow:` marker. Only the first
 * `ALLOWLIST_MARKER_HEADER_LINES` lines are inspected. Unreadable files are
 * warned about and treated as unmarked, mirroring `scanSyncViolations`.
 *
 * @param {Iterable<string>} allowlistFiles — repo-relative paths
 * @param {string} root — absolute repo root
 * @param {(file: string) => string} [readFile] — override for tests
 * @returns {Set<string>}
 */
export function scanAllowlistMarkers(allowlistFiles, root, readFile) {
  const reader = readFile ?? ((f) => fs.readFileSync(f, "utf8"));
  const marked = new Set();
  for (const file of allowlistFiles) {
    let source;
    try {
      source = reader(`${root}/${file}`);
    } catch (err) {
      console.warn(
        `[import-budget] could not read ${file} for allowlist-marker scan: ${err?.message ?? err}`
      );
      continue;
    }
    const header = source.split(/\r?\n/).slice(0, ALLOWLIST_MARKER_HEADER_LINES).join("\n");
    if (hasAllowlistMarker(header)) marked.add(file);
  }
  return marked;
}

/**
 * Walk the eager (statically-imported) subgraph of an esbuild metafile, rooted
 * at `entry`. Follows only `import-statement` / `require-call` edges; stops at
 * `dynamic-import` boundaries and skips externals. Returns the set of module
 * keys reachable on the eager path, including the entry itself.
 *
 * @param {object} metafile — esbuild metafile (`{ inputs, outputs }`)
 * @param {string} entry — key into `metafile.inputs` (e.g. `"electron/main.ts"`)
 * @returns {Set<string>}
 */
export function walkEagerGraph(metafile, entry) {
  const visited = new Set();
  const inputs = metafile?.inputs ?? {};
  if (!inputs[entry]) return visited;

  const stack = [entry];
  while (stack.length > 0) {
    const current = stack.pop();
    if (visited.has(current)) continue;
    visited.add(current);

    const node = inputs[current];
    if (!node || !Array.isArray(node.imports)) continue;

    for (const edge of node.imports) {
      if (edge.external) continue;
      if (!EAGER_EDGE_KINDS.has(edge.kind)) continue;
      if (!edge.path) continue;
      if (!visited.has(edge.path)) stack.push(edge.path);
    }
  }

  return visited;
}

/**
 * Scan the given set of source files for sync FS / store.get / sync SQLite
 * calls. Only files under the repo (not `node_modules/`) are scanned — third-
 * party packages are out of scope for the eager-sync gate.
 *
 * @param {Iterable<string>} files — repo-relative paths (from metafile keys)
 * @param {string} root — absolute repo root, used to resolve file paths
 * @param {(file: string) => string} [readFile] — override for tests
 * @returns {{ file: string, line: number, pattern: string }[]}
 */
export function scanSyncViolations(files, root, readFile) {
  const reader = readFile ?? ((f) => fs.readFileSync(f, "utf8"));
  const violations = [];
  for (const file of files) {
    if (file.startsWith("node_modules/") || file.includes("/node_modules/")) continue;
    if (!/\.(?:ts|mts|cts|js|mjs|cjs|tsx|jsx)$/.test(file)) continue;
    let source;
    try {
      source = reader(`${root}/${file}`);
    } catch (err) {
      console.warn(
        `[import-budget] could not read ${file} for sync-call scan: ${err?.message ?? err}`
      );
      continue;
    }
    for (const { name, re } of SYNC_PATTERNS) {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(source)) !== null) {
        const line = source.slice(0, match.index).split("\n").length;
        violations.push({ file, line, pattern: name });
      }
    }
  }
  violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return violations;
}

/**
 * Compare the current graph snapshot to the committed baseline. Returns a
 * structured result the CLI can turn into GitHub annotations.
 *
 * Gate:
 * - `count` must not exceed `baseline.count` (strict upper bound).
 * - Every file in `current.violations` must be in `baseline.allowlist`. Any
 *   file not on the allowlist fails CI regardless of how many calls it has.
 *
 * `baseline.syncViolations` is a checked-in snapshot of the allowed call sites
 * for humans to diff — it does NOT gate CI. The allowlist is the sole gate.
 * This keeps line-number refactors from churning the baseline.
 *
 * Allowlist hygiene (hard errors, not notices):
 * - An allowlist entry with no matching current violation is stale and fails —
 *   the PR that removes a sync call must remove its allowlist entry in the same
 *   change (same shape as ESLint `reportUnusedDisableDirectives: "error"`).
 * - A still-used allowlist entry whose file lacks the
 *   `// eager-import-allow: <reason>` header marker fails, when marker data is
 *   supplied via `opts.markedFiles`. Omitting `markedFiles` skips that check so
 *   the comparison stays pure and unit-testable without filesystem access.
 *
 * @param {{ count: number, violations: {file:string, line:number, pattern:string}[], moduleCount: number }} current
 * @param {{ count: number, allowlist: string[], syncViolations: {file:string, line:number, pattern:string}[] }} baseline
 * @param {{ markedFiles?: Set<string> }} [opts] — set of allowlisted files that carry the header marker
 */
export function compareToBaseline(current, baseline, opts = {}) {
  const errors = [];
  const notices = [];

  if (current.count > baseline.count) {
    errors.push({
      kind: "count-regression",
      message: `eager import count grew ${baseline.count} → ${current.count} (budget exceeded).`,
    });
  } else if (current.count < baseline.count) {
    notices.push({
      kind: "count-improvement",
      message: `eager import count shrank ${baseline.count} → ${current.count} — consider \`npm run import-budget:update\` to lock it in.`,
    });
  }

  const allowlist = new Set(baseline.allowlist ?? []);
  const offendingFiles = new Map();
  for (const v of current.violations) {
    if (allowlist.has(v.file)) continue;
    if (!offendingFiles.has(v.file)) offendingFiles.set(v.file, []);
    offendingFiles.get(v.file).push(v);
  }
  for (const [file, items] of offendingFiles) {
    const summary = items
      .slice(0, 3)
      .map((v) => `line ${v.line} (${v.pattern})`)
      .join(", ");
    const more = items.length > 3 ? `, +${items.length - 3} more` : "";
    errors.push({
      kind: "new-sync-violation",
      file,
      message: `new sync call(s) on the eager main-process import path: ${summary}${more}. If this is an intentional boot-critical sync (like readLastActiveProjectIdSync), add the file to the \`allowlist\` in eager-import-baseline.json.`,
    });
  }

  const { markedFiles } = opts;
  for (const file of allowlist) {
    const isUsed = current.violations.some((v) => v.file === file);
    if (!isUsed) {
      errors.push({
        kind: "unused-allowlist",
        file,
        message: `allowlist entry no longer has sync calls (or is no longer on the eager path). Remove it from the \`allowlist\` in eager-import-baseline.json, or run \`npm run import-budget:update\` to tidy.`,
      });
      continue;
    }
    if (markedFiles !== undefined && !markedFiles.has(file)) {
      errors.push({
        kind: "missing-allow-comment",
        file,
        message: `on the eager-import allowlist but missing a \`// eager-import-allow: <reason>\` header comment. Add one near the top of the file naming why the sync exception is permitted.`,
      });
    }
  }

  return { ok: errors.length === 0, errors, notices };
}

/**
 * Deterministic serializer for the baseline file. Sorts module lists and
 * violation lists so diffs stay clean across runs.
 */
export function formatBaseline({ count, allowlist, syncViolations, moduleCount }) {
  const sortedAllowlist = [...new Set(allowlist)].sort();
  const sortedViolations = [...syncViolations].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.pattern.localeCompare(b.pattern)
  );
  return {
    count,
    moduleCount,
    allowlist: sortedAllowlist,
    syncViolations: sortedViolations,
  };
}
