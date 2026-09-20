import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import ts from "typescript";

/**
 * Static import extraction for the built-in renderer entry guards.
 *
 * Parsed with the TypeScript compiler rather than matched with a regex. A
 * pattern cannot tell `export const text = 'Example: from "zod"'` from a real
 * specifier, cannot see that `export { x as "from" } from "./bridge"` imports
 * `./bridge`, and cannot stop a lazy quantifier crossing a statement boundary
 * into the next line's `from`. All three were live defects in the regex this
 * replaces.
 *
 * What counts as an eager edge is what the bundler actually emits:
 *
 * - `import type … from "x"` and `export type … from "x"` are erased.
 * - So is a named clause whose bindings are *all* inline type specifiers
 *   (`import { type A } from "x"`), which this repo's transformer drops.
 *   One value binding anywhere in the clause keeps the edge.
 * - `import type from "x"` is a default import binding named `type`, not a
 *   type-only import, and stays an edge.
 * - `import "x"` is a side-effect import and always an edge.
 * - `import("x")` is a lazy boundary and never an edge. It is a call
 *   expression, so walking declarations excludes it by construction.
 */

/** `?raw`/`?url`/`?inline` yield text or a path, so the target never executes. */
const NON_EXECUTING_QUERIES = new Set(["raw", "url", "inline"]);

const CANDIDATE_SUFFIXES = ["", ".ts", ".tsx", ".mts", ".cts"];
const INDEX_FILES = ["index.ts", "index.tsx"];

/**
 * Script kind per extension. Parsing a `.ts` file as TSX is not a harmless
 * over-approximation: a generic arrow (`const id = <T>(x: T): T => x;`) or an
 * angle-bracket assertion is a syntax error in TSX, and the parser's recovery
 * swallows the rest of the statement list, so every import below it disappears
 * without a word.
 */
const SCRIPT_KINDS = new Map([
  [".ts", ts.ScriptKind.TS],
  [".mts", ts.ScriptKind.TS],
  [".cts", ts.ScriptKind.TS],
  [".tsx", ts.ScriptKind.TSX],
  [".js", ts.ScriptKind.JS],
  [".mjs", ts.ScriptKind.JS],
  [".cjs", ts.ScriptKind.JS],
  [".jsx", ts.ScriptKind.JSX],
]);

/** `undefined` for anything that is not a script: CSS and assets carry no edges. */
export function scriptKindOf(fileName) {
  const dot = fileName.lastIndexOf(".");
  if (dot < 0) return undefined;
  return SCRIPT_KINDS.get(fileName.slice(dot).toLowerCase());
}

/** Splits `./x.ts?v=1` into its specifier and query. */
function splitQuery(specifier) {
  const at = specifier.indexOf("?");
  if (at < 0) return { path: specifier, query: "" };
  return { path: specifier.slice(0, at), query: specifier.slice(at + 1) };
}

/** True when every binding in the clause is erased at compile time. */
function clauseIsTypeOnly(importClause) {
  if (importClause === undefined) return false; // side-effect import
  if (importClause.isTypeOnly) return true;
  // A default binding (including one named `type`) is a value.
  if (importClause.name !== undefined) return false;
  const bindings = importClause.namedBindings;
  if (bindings === undefined) return false;
  if (ts.isNamespaceImport(bindings)) return false;
  if (!ts.isNamedImports(bindings)) return false;
  // `import {} from "x"` keeps its side effect, so it is not type-only.
  if (bindings.elements.length === 0) return false;
  return bindings.elements.every((element) => element.isTypeOnly);
}

/** Same rule for `export … from "x"`. */
function exportClauseIsTypeOnly(node) {
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  if (clause === undefined) return false; // `export * from "x"`
  if (ts.isNamespaceExport(clause)) return false;
  if (clause.elements.length === 0) return false;
  return clause.elements.every((element) => element.isTypeOnly);
}

/**
 * Every specifier this source pulls in eagerly, plus any syntax error hit while
 * reading it.
 *
 * A parse failure is reported rather than tolerated: error recovery drops the
 * statements it cannot make sense of, so a file that fails to parse looks
 * exactly like a file with no imports.
 */
export function parseStaticImports(source, fileName = "file.tsx") {
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindOf(fileName) ?? ts.ScriptKind.TS
  );
  const parseErrors = (parsed.parseDiagnostics ?? []).map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
    if (typeof diagnostic.start !== "number") return message;
    const { line } = parsed.getLineAndCharacterOfPosition(diagnostic.start);
    return `line ${line + 1}: ${message}`;
  });
  const out = [];
  for (const statement of parsed.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (clauseIsTypeOnly(statement.importClause)) continue;
      if (ts.isStringLiteral(statement.moduleSpecifier)) out.push(statement.moduleSpecifier.text);
      continue;
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined) {
      if (exportClauseIsTypeOnly(statement)) continue;
      if (ts.isStringLiteral(statement.moduleSpecifier)) out.push(statement.moduleSpecifier.text);
      continue;
    }
    if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      ts.isStringLiteral(statement.moduleReference.expression)
    ) {
      out.push(statement.moduleReference.expression.text);
    }
  }
  return { specifiers: out, parseErrors };
}

/** Every specifier this source pulls in eagerly. Throws when it will not parse. */
export function staticSpecifiers(source, fileName = "file.tsx") {
  const { specifiers, parseErrors } = parseStaticImports(source, fileName);
  if (parseErrors.length > 0) {
    throw new Error(`${fileName} failed to parse: ${parseErrors.join("; ")}`);
  }
  return specifiers;
}

/**
 * Resolve a relative specifier to a file on disk.
 *
 * Returns `null` for a specifier that does not resolve, and `false` for one
 * whose query means the target never executes. Candidates are built with
 * `join` so they carry the platform separator, which a template string does
 * not: on Windows a `${base}/index.ts` candidate fails a `sep`-based
 * containment check and the file is skipped in silence.
 */
export function resolveRelative(fromFile, specifier) {
  const { path, query } = splitQuery(specifier);
  for (const part of query.split("&")) {
    if (NON_EXECUTING_QUERIES.has(part.split("=")[0])) return false;
  }
  const base = resolve(dirname(fromFile), path);
  const withoutJs = base.replace(/\.(js|mjs|cjs)$/, "");
  for (const candidate of [base, withoutJs]) {
    for (const suffix of CANDIDATE_SUFFIXES) {
      const full = candidate + suffix;
      if (existsSync(full) && statSync(full).isFile()) return full;
    }
    for (const index of INDEX_FILES) {
      const full = join(candidate, index);
      if (existsSync(full) && statSync(full).isFile()) return full;
    }
  }
  return null;
}

/** The package a bare specifier names: `zod/v4` and `zod?v=1` both give `zod`. */
export function packageOf(specifier) {
  const { path } = splitQuery(specifier);
  const parts = path.split("/");
  return path.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Posix separators, so a failure reads the same on every platform. */
export const posix = (path) => path.split(sep).join("/");

/**
 * Walk the eager graph from `entry`, following only files under `root`.
 *
 * Returns the bare specifiers each reached file imports, plus any relative
 * specifier that would not resolve and any file that would not parse. Both are
 * reported rather than skipped: silently dropping one is how a guard passes
 * while blind.
 */
export function walkEagerGraph(entry, root) {
  const bare = new Map();
  const unresolved = [];
  const seen = new Set();
  const queue = [entry];
  const contained = root.endsWith(sep) ? root : root + sep;
  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    // A non-script file (a stylesheet, an asset) is a leaf: it has no edges to
    // follow and nothing a parser could tell us about.
    if (scriptKindOf(file) === undefined) continue;
    const { specifiers, parseErrors } = parseStaticImports(readFileSync(file, "utf8"), file);
    for (const error of parseErrors) {
      unresolved.push(`${posix(file)} failed to parse: ${error}`);
    }
    bare.set(
      file,
      specifiers.filter((specifier) => !specifier.startsWith("."))
    );
    for (const specifier of specifiers) {
      if (!specifier.startsWith(".")) continue;
      const resolved = resolveRelative(file, specifier);
      if (resolved === false) continue;
      if (resolved === null) {
        unresolved.push(`${posix(file)} imports ${specifier}`);
        continue;
      }
      if (resolved.startsWith(contained)) queue.push(resolved);
    }
  }
  return { bare, unresolved, files: [...seen] };
}
