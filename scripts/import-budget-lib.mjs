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
 * @param {{ count: number, violations: {file:string, line:number, pattern:string}[], moduleCount: number }} current
 * @param {{ count: number, allowlist: string[], syncViolations: {file:string, line:number, pattern:string}[] }} baseline
 */
export function compareToBaseline(current, baseline) {
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

  const unusedAllowlist = [];
  for (const file of allowlist) {
    if (!current.violations.some((v) => v.file === file)) {
      unusedAllowlist.push(file);
    }
  }
  if (unusedAllowlist.length > 0) {
    notices.push({
      kind: "unused-allowlist",
      message: `allowlist entries no longer have sync calls (or no longer on eager path): ${unusedAllowlist.join(", ")}. Consider \`npm run import-budget:update\` to tidy.`,
    });
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
