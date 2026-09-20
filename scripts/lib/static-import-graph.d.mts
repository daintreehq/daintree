// Type surface for static-import-graph.mjs so the type-checked guard tests can
// import it. The .mjs stays plain JS because it is shared by a host test and a
// plugin-local one, and neither build type-checks the helper itself.

export interface StaticImports {
  /** Specifiers pulled in eagerly, excluding erased type-only forms. */
  specifiers: string[];
  /** Syntax errors hit while reading the source, each prefixed with its line. */
  parseErrors: string[];
}

/** Every specifier `source` pulls in eagerly, plus any syntax error hit reading it. */
export function parseStaticImports(source: string, fileName?: string): StaticImports;

/**
 * Every specifier `source` pulls in eagerly, excluding erased type-only forms.
 * Throws when the source will not parse, since recovery hides imports.
 */
export function staticSpecifiers(source: string, fileName?: string): string[];

/** The TypeScript `ScriptKind` for a file name, or `undefined` if it is not a script. */
export function scriptKindOf(fileName: string): number | undefined;

/**
 * Resolve a relative specifier to a file on disk.
 *
 * `null` when it does not resolve; `false` when its query (`?raw`, `?url`,
 * `?inline`) means the target never executes.
 */
export function resolveRelative(fromFile: string, specifier: string): string | false | null;

/** The package a bare specifier names: `zod/v4` and `zod?v=1` both give `zod`. */
export function packageOf(specifier: string): string;

/** Posix separators, so a failure reads the same on every platform. */
export function posix(path: string): string;

export interface EagerGraph {
  /** Bare specifiers each reached file imports, keyed by absolute path. */
  bare: Map<string, string[]>;
  /** Edges that could not be followed: an unresolvable specifier or a parse failure. */
  unresolved: string[];
  /** Absolute paths of every file reached, entry included. */
  files: string[];
}

/** Walk the eager graph from `entry`, following only files under `root`. */
export function walkEagerGraph(entry: string, root: string): EagerGraph;
