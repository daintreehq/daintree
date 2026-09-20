import type { RouteDiagnostic, RouteNode, RoutesDirectorySource } from "../protocol.js";
import {
  type ProjectFileReader,
  type ProjectReadOptions,
  joinPath,
  readBoundedTextFile,
  readDirectory,
  readJsonFile,
  rethrowIfAborted,
  toWorktreeRelative,
} from "./fs.js";

export type { RouteDiagnostic, RoutesDirectorySource };

/** The roles SvelteKit's `+` files play. Recognising them is what makes this a route view rather than a file tree. */
export type RouteFileKind =
  | "page"
  | "page-load"
  | "page-server"
  | "layout"
  | "layout-load"
  | "layout-server"
  | "endpoint"
  | "error";

export interface RouteFileInfo {
  kind: RouteFileKind;
  /**
   * The `@target` of a layout reset (`+page@(app).svelte`), `""` for a reset to
   * the root layout (`+page@.svelte`), null when the file inherits normally.
   */
  layoutReset: string | null;
}

/**
 * Kit's defaults. `extensions` defaults to `[".svelte"]` and `moduleExtensions`
 * to `[".js", ".ts"]`, and both are case-sensitive — `+server.mjs` is an
 * ordinary file to SvelteKit, not an endpoint. A project that configures either
 * one is not read here, because that means executing `svelte.config.js`.
 */
const COMPONENT_EXTENSIONS = new Set(["svelte"]);
const MODULE_EXTENSIONS = new Set(["js", "ts"]);

/**
 * `+page@(app).svelte` — the part after `@` is the ancestor segment name, and a
 * segment name may itself contain dots (`(app.v2)`) or brackets (`[...rest]`).
 * So the reset target is taken whole, and only a file *without* a reset is
 * split on dots to find its `server` modifier.
 */
const COMPONENT_FILE = /^\+(page|layout|error)(?:@(.*))?\.([^.]+)$/;
const MODULE_FILE = /^\+(page|layout|server)(?:\.(server))?\.([^.]+)$/;

/**
 * Classify one filename inside the routes tree. Null means "not a route file" —
 * a colocated component, a stylesheet, a test — which is most of what a real
 * routes directory contains.
 *
 * Both `.ts` and `.js` are accepted throughout: a JavaScript SvelteKit project
 * is as supported as a TypeScript one.
 */
export function classifyRouteFile(fileName: string): RouteFileInfo | null {
  if (!fileName.startsWith("+")) return null;

  const component = COMPONENT_FILE.exec(fileName);
  if (component && COMPONENT_EXTENSIONS.has(component[3] ?? "")) {
    const base = component[1];
    const layoutReset = component[2] ?? null;
    // `+error@(app).svelte` is not a thing: only pages and layouts reset.
    if (base === "error") return layoutReset === null ? { kind: "error", layoutReset: null } : null;
    return { kind: base === "page" ? "page" : "layout", layoutReset };
  }

  const module = MODULE_FILE.exec(fileName);
  if (!module || !MODULE_EXTENSIONS.has(module[3] ?? "")) return null;
  const base = module[1];
  const isServer = module[2] === "server";
  if (base === "server") return isServer ? null : { kind: "endpoint", layoutReset: null };
  if (base === "page") {
    return { kind: isServer ? "page-server" : "page-load", layoutReset: null };
  }
  return { kind: isServer ? "layout-server" : "layout-load", layoutReset: null };
}

/** `(marketing)` — organisational only. It groups files; it is never a URL segment. */
export function isRouteGroup(segment: string): boolean {
  return segment.startsWith("(") && segment.endsWith(")") && segment.length > 2;
}

/**
 * SvelteKit's escapes for characters a path cannot hold literally: `[x+2f]` is
 * a `/`, `[u+e9]` an `é`. They wear parameter brackets but are constants, so a
 * segment containing only these is static and needs no value from the user.
 */
const ENCODED_CHARACTER = /\[(?:x\+[0-9a-f]{2}|u\+[0-9a-f]{4,6})\]/gi;

/**
 * `[slug]`, `[...rest]`, `[[optional]]`, and the compound forms SvelteKit also
 * allows (`[category]-[slug]`, `foo-[bar]`). Anything with a parameter in it
 * needs a concrete value before it can be previewed, which is the whole reason
 * this flag exists.
 */
export function isDynamicSegment(segment: string): boolean {
  const withoutEscapes = segment.replace(ENCODED_CHARACTER, "");
  return withoutEscapes.includes("[") && withoutEscapes.includes("]");
}

/**
 * The wire `routeId` for a chain of directory names.
 *
 * Careful: this is neither SvelteKit's own `route.id` — which keeps group
 * segments — nor a navigable URL, which would need every parameter filled in
 * and the encoded escapes turned back into their characters. It is the
 * group-free template the frozen `RouteNodeSchema` asks for, and a caller that
 * wants a URL has to resolve the parameters first.
 */
export function routeIdFromSegments(segments: string[]): string {
  const kept = segments.filter((segment) => !isRouteGroup(segment));
  return kept.length === 0 ? "/" : `/${kept.join("/")}`;
}

interface RouteDir {
  absPath: string;
  segments: string[];
  parent: RouteDir | null;
  layout: { file: string; reset: string | null } | null;
  page: { file: string; reset: string | null } | null;
  /** `+page.ts` / `+page.server.ts`. A page can exist without a component. */
  pageModuleFile: string | null;
  /** Every page module, universal and server, in the order read. */
  pageModules: string[];
  /** `+layout.ts` / `+layout.server.ts`. */
  layoutModules: string[];
  endpointFile: string | null;
  errorFile: string | null;
}

function emptyRouteDir(absPath: string, segments: string[], parent: RouteDir | null): RouteDir {
  return {
    absPath,
    segments,
    parent,
    layout: null,
    page: null,
    pageModuleFile: null,
    pageModules: [],
    layoutModules: [],
    endpointFile: null,
    errorFile: null,
  };
}

export interface RouteTreeResult {
  routes: RouteNode[];
  diagnostics: RouteDiagnostic[];
}

export interface RouteTreeOptions {
  appRoot: string;
  worktreeRoot: string;
  /** Absolute routes directory, from `resolveRoutesDirectory`. */
  routesDir: string;
  maxDepth?: number;
  maxDirectories?: number;
  /**
   * Cancels the walk. A closed workspace must end the scan as an abort, not as
   * a route tree that happens to be empty.
   */
  signal?: AbortSignal;
}

const DEFAULT_ROUTE_DEPTH = 12;
const DEFAULT_ROUTE_DIRECTORY_BUDGET = 4000;

/**
 * Inside `src/routes`, only these are not routes.
 *
 * Deliberately *not* the discovery list: `src/routes/build/+page.svelte` and
 * `src/routes/dist/+page.svelte` are ordinary pages, and a route view that
 * silently drops `/build` because the name resembles an output directory is
 * worse than useless.
 */
const NON_ROUTE_DIRECTORIES: ReadonlySet<string> = new Set(["node_modules", ".git"]);

interface CollectState {
  visited: number;
  budget: number;
  truncated: RouteDir[];
  signal?: AbortSignal;
}

async function collectDirs(
  reader: ProjectFileReader,
  dir: RouteDir,
  depth: number,
  maxDepth: number,
  out: RouteDir[],
  state: CollectState
): Promise<void> {
  // Checked per directory as well as per read: a closed workspace stops the
  // walk here rather than at the next read that happens to be slow.
  state.signal?.throwIfAborted();
  out.push(dir);
  state.visited += 1;
  const entries = await readDirectory(reader, dir.absPath, { signal: state.signal });
  const children: RouteDir[] = [];

  for (const entry of entries) {
    const abs = joinPath(dir.absPath, entry.name);

    // A plain `readdir` describes a symlink as neither file nor directory, so
    // an entry of unknown kind is stat'ed rather than dropped: SvelteKit
    // follows a linked routes subtree and so must we.
    let isDirectory = entry.isDirectory;
    if (!entry.isDirectory && !entry.isFile) {
      try {
        isDirectory = (await reader.stat(abs, { signal: state.signal })).isDirectory;
      } catch (error) {
        // An entry we could not stat is one we skip; a workspace closing under
        // the walk is not, or the abort reads back as a route tree with
        // nothing in it.
        rethrowIfAborted(error, state.signal);
        continue;
      }
    }

    if (isDirectory) {
      if (NON_ROUTE_DIRECTORIES.has(entry.name)) continue;
      if (depth >= maxDepth || state.visited + children.length >= state.budget) {
        state.truncated.push(dir);
        continue;
      }
      children.push(emptyRouteDir(abs, [...dir.segments, entry.name], dir));
      continue;
    }

    const info = classifyRouteFile(entry.name);
    if (!info) continue;
    if (info.kind === "page") dir.page = { file: abs, reset: info.layoutReset };
    else if (info.kind === "layout") dir.layout = { file: abs, reset: info.layoutReset };
    else if (info.kind === "page-load" || info.kind === "page-server") {
      dir.pageModuleFile = abs;
      dir.pageModules.push(abs);
    } else if (info.kind === "layout-load" || info.kind === "layout-server") {
      dir.layoutModules.push(abs);
    } else if (info.kind === "endpoint") dir.endpointFile = abs;
    else if (info.kind === "error") dir.errorFile = abs;
  }

  children.sort((a, b) => a.absPath.localeCompare(b.absPath));
  for (const child of children) {
    await collectDirs(reader, child, depth + 1, maxDepth, out, state);
  }
}

/**
 * Walk `src/routes` (or whatever the config points at) into the wire route set.
 *
 * Only directories that actually define a page or an endpoint become nodes: a
 * directory holding nothing but `+layout.svelte` is structure, not a place the
 * user can navigate to, and listing it as a page is the "renamed file explorer"
 * the specification rules out.
 */
export async function analyzeRoutes(
  reader: ProjectFileReader,
  options: RouteTreeOptions
): Promise<RouteTreeResult> {
  const root = emptyRouteDir(options.routesDir, [], null);

  const dirs: RouteDir[] = [];
  const state: CollectState = {
    visited: 0,
    budget: options.maxDirectories ?? DEFAULT_ROUTE_DIRECTORY_BUDGET,
    truncated: [],
    ...(options.signal && { signal: options.signal }),
  };
  await collectDirs(reader, root, 0, options.maxDepth ?? DEFAULT_ROUTE_DEPTH, dirs, state);

  const diagnostics: RouteDiagnostic[] = [];
  const chains = new Map<string, string[]>();
  const relative = (file: string) => toWorktreeRelative(options.worktreeRoot, file);

  const ancestorsOf = (dir: RouteDir, includeSelf: boolean): RouteDir[] => {
    const out: RouteDir[] = [];
    let current: RouteDir | null = includeSelf ? dir : dir.parent;
    while (current) {
      out.push(current);
      current = current.parent;
    }
    return out;
  };

  /**
   * `@target` names the directory whose layout to inherit from: `@` alone means
   * the root layout, `@(app)` means the nearest ancestor segment called
   * `(app)`. A target with no matching ancestor is a build error in SvelteKit,
   * so it is reported as a diagnostic rather than quietly becoming an empty
   * chain that reads like a valid page with no layouts.
   */
  /**
   * The directories whose layout applies, outermost first — a layout being a
   * `+layout.svelte`, a load module, or both. Same reset rules as
   * {@link chainFor}, which lists only the components; a load-only layout
   * skipped by a reset must not be reported as feeding the page.
   */
  const dirChains = new Map<string, RouteDir[]>();
  function dirChainFor(dir: RouteDir): RouteDir[] {
    const cached = dirChains.get(dir.absPath);
    if (cached) return cached;
    dirChains.set(dir.absPath, []);
    const inherited = dir.parent ? dirChainFor(dir.parent) : [];
    let chain = inherited;
    if (dir.layout || dir.layoutModules.length > 0) {
      const base =
        dir.layout === null || dir.layout.reset === null
          ? inherited
          : resetDirChain(dir.layout.reset, ancestorsOf(dir, false));
      chain = [...base, dir];
    }
    dirChains.set(dir.absPath, chain);
    return chain;
  }
  const resetDirChain = (target: string, candidates: RouteDir[]): RouteDir[] => {
    if (target === "") return dirChainFor(root);
    const match = candidates.find(
      (dir) => dir.segments[dir.segments.length - 1] === target && dir !== root
    );
    return match ? dirChainFor(match) : [];
  };

  const resolveReset = (target: string, candidates: RouteDir[], owner: string): string[] => {
    if (target === "") return chainFor(root);
    const match = candidates.find(
      (dir) => dir.segments[dir.segments.length - 1] === target && dir !== root
    );
    if (match) return chainFor(match);
    diagnostics.push({
      code: "unresolved-layout-reset",
      message: `layout reset "@${target}" names no ancestor of this route`,
      files: [relative(owner)],
    });
    return [];
  };

  function chainFor(dir: RouteDir): string[] {
    const cached = chains.get(dir.absPath);
    if (cached) return cached;
    chains.set(dir.absPath, []); // cycle guard; directory trees have none, symlinks might

    const inherited = dir.parent ? chainFor(dir.parent) : [];
    let chain: string[];
    if (dir.layout) {
      const base =
        dir.layout.reset === null
          ? inherited
          : resolveReset(dir.layout.reset, ancestorsOf(dir, false), dir.layout.file);
      chain = [...base, relative(dir.layout.file)];
    } else {
      chain = inherited;
    }
    chains.set(dir.absPath, chain);
    return chain;
  }

  const nodes: RouteNode[] = [];
  for (const dir of dirs) {
    // A page exists as soon as any page file does. `redirect/+page.server.ts`
    // with no component is a real, navigable route — it just answers with a
    // redirect — and calling it an endpoint would hide it from the page list.
    const hasPage = dir.page !== null || dir.pageModuleFile !== null;
    const hasEndpoint = dir.endpointFile !== null;
    if (!hasPage && !hasEndpoint) continue;

    const layoutFiles = !hasPage
      ? // Layouts wrap pages. An endpoint returns a Response; nothing wraps it.
        []
      : dir.page === null || dir.page.reset === null
        ? chainFor(dir)
        : resolveReset(dir.page.reset, ancestorsOf(dir, true), dir.page.file);

    // The load functions that feed this page: its own, and those of every
    // layout directory on its path whose layout still applies after a reset.
    // A `+layout.ts` with no `+layout.svelte` beside it still runs.
    const layoutDirs = !hasPage
      ? []
      : dir.page === null || dir.page.reset === null
        ? dirChainFor(dir)
        : resetDirChain(dir.page.reset, ancestorsOf(dir, true));
    const dataFiles = !hasPage
      ? []
      : [
          ...layoutDirs.flatMap((layoutDir) => [...layoutDir.layoutModules].sort().map(relative)),
          ...[...dir.pageModules].sort().map(relative),
        ];

    nodes.push({
      routeId: routeIdFromSegments(dir.segments),
      pageFile: dir.page ? relative(dir.page.file) : null,
      layoutFiles,
      dataFiles,
      dynamic: dir.segments.some((segment) => !isRouteGroup(segment) && isDynamicSegment(segment)),
      endpointOnly: hasEndpoint && !hasPage,
    });
  }

  nodes.sort(
    (a, b) =>
      a.routeId.localeCompare(b.routeId) || (a.pageFile ?? "").localeCompare(b.pageFile ?? "")
  );

  // Two groups can spell the same URL — `(a)/about` and `(b)/about`. SvelteKit
  // refuses to build that, so it is surfaced rather than deduped away: both
  // source locations are what tells the user which one to delete.
  const seen = new Map<string, RouteNode[]>();
  for (const node of nodes) {
    seen.set(node.routeId, [...(seen.get(node.routeId) ?? []), node]);
  }
  for (const [routeId, group] of seen) {
    if (group.length < 2) continue;
    diagnostics.push({
      code: "duplicate-route-id",
      message: `${group.length} directories resolve to ${routeId}`,
      files: group.flatMap((node) => (node.pageFile ? [node.pageFile] : [])),
    });
  }

  // Everything above read successfully; a workspace that closed while it did
  // must not have its scan published as the tree it found.
  options.signal?.throwIfAborted();

  for (const dir of state.truncated) {
    diagnostics.push({
      code: "traversal-truncated",
      message: "the route walk stopped here; nested routes below it are not listed",
      files: [relative(dir.absPath)],
    });
  }

  return { routes: nodes, diagnostics };
}

/** The routes alone, for callers with no use for the diagnostics. */
export async function buildRouteTree(
  reader: ProjectFileReader,
  options: RouteTreeOptions
): Promise<RouteNode[]> {
  return (await analyzeRoutes(reader, options)).routes;
}

/** What a config read needs beyond the file access itself. */
export interface KitConfigReadOptions extends ProjectReadOptions {
  /**
   * The installed `@sveltejs/kit` version, which decides whether a config
   * passed to the Vite plugin is read at all. Absent means unknown, not old.
   */
  kitVersion?: string | null;
}

export interface RoutesDirectory {
  /** Absolute path. May not exist — an app can point `kit.files.routes` at a directory it has not created. */
  path: string;
  /**
   * `unresolved` means a config names a routes directory we could not read
   * statically, so `path` is the default and the UI must say it is a fallback.
   * `vite.config` means the Vite plugin was handed a config of its own, which
   * makes `svelte.config.*` irrelevant to this app entirely.
   */
  source: RoutesDirectorySource;
}

export const DEFAULT_ROUTES_DIR = "src/routes";

const CONFIG_FILENAMES = [
  "svelte.config.js",
  "svelte.config.mjs",
  "svelte.config.ts",
  "svelte.config.cjs",
];

/**
 * Since Kit 2.62.0 a config passed to the Vite plugin — `sveltekit({ ... })` —
 * is used *instead of* `svelte.config.js` rather than merged with it. So these
 * files decide whether anything read from `svelte.config.*` describes the app
 * at all.
 */
const VITE_CONFIG_FILENAMES = [
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.cjs",
  "vite.config.cts",
];

/** Comments only — string contents are preserved so a path is never mangled. */
function stripComments(source: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i] as string;
    const next = source[i + 1];
    if (quote) {
      out += char;
      if (char === "\\") {
        out += source[i + 1] ?? "";
        i += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 1;
      out += " ";
      continue;
    }
    out += char;
  }
  return out;
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

/* -------------------------------------------------------------------------- */
/* A very small static reader for config objects                              */
/* -------------------------------------------------------------------------- */

/**
 * What a static read of one config key found.
 *
 * `absent` is a claim — the object was read whole and does not set the key, so
 * Kit's own default applies. `unresolved` is the refusal: the value exists in
 * some form we cannot evaluate, or the object could not be delimited at all.
 * Collapsing the two is how a config that says `src/pages` gets reported as an
 * unconfigured `src/routes`.
 */
type StaticRead =
  { status: "literal"; value: string } | { status: "absent" } | { status: "unresolved" };

const UNRESOLVED: StaticRead = { status: "unresolved" };
const ABSENT: StaticRead = { status: "absent" };

const CLOSERS: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
const QUOTES = new Set(['"', "'", "`"]);

/** Punctuation after which a `/` opens a regex rather than dividing. */
const REGEX_PRECEDERS = new Set([..."([{,;:=!&|?+-*%~^<>"]);
const REGEX_KEYWORDS = new Set(["return", "typeof", "case", "in", "of", "do", "else", "yield"]);

/**
 * How deep a nesting of braces, brackets and template substitutions the scanner
 * will follow. A config is not written like this; a file crafted to blow the
 * scanner's stack is, and a detection pass must not throw on one.
 */
const MAX_NESTING = 64;

/** Index just past a string or template literal opening at `start`. */
function skipString(source: string, start: number, depth = 0): number {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
    // A substitution holds arbitrary code, braces included, so it is scanned as
    // code rather than as text.
    if (quote === "`" && char === "$" && source[index + 1] === "{") {
      const end = skipBalanced(source, index + 1, depth + 1);
      if (end < 0) return -1;
      index = end;
      continue;
    }
    index += 1;
  }
  return -1;
}

function startsRegex(source: string, at: number): boolean {
  let index = at - 1;
  while (index >= 0 && /\s/.test(source[index] as string)) index -= 1;
  if (index < 0) return true;
  if (REGEX_PRECEDERS.has(source[index] as string)) return true;
  // Walked back rather than sliced: these files run to a quarter of a megabyte
  // and a slice per `/` would make the scan quadratic.
  let start = index;
  while (start >= 0 && /[\w$]/.test(source[start] as string)) start -= 1;
  return start === index ? false : REGEX_KEYWORDS.has(source.slice(start + 1, index + 1));
}

/** Index just past a regex literal opening at `start`; a newline means it was a division after all. */
function skipRegex(source: string, start: number): number {
  let index = start + 1;
  let inClass = false;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "\n") return start + 1;
    if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) return index + 1;
    index += 1;
  }
  return start + 1;
}

/**
 * Index just past the delimiter matching the one at `open`, or -1 when the text
 * is unbalanced — which every caller reads as "unresolved" rather than guessing
 * where the object ended.
 */
function skipBalanced(source: string, open: number, depth = 0): number {
  const first = CLOSERS[source[open] as string];
  if (first === undefined || depth > MAX_NESTING) return -1;
  const stack: string[] = [first];
  let index = open + 1;
  while (index < source.length && stack.length > 0) {
    const char = source[index] as string;
    if (QUOTES.has(char)) {
      const end = skipString(source, index, depth + 1);
      if (end < 0) return -1;
      index = end;
      continue;
    }
    if (char === "/" && startsRegex(source, index)) {
      index = skipRegex(source, index);
      continue;
    }
    if (stack.length > MAX_NESTING) return -1;
    if (char === stack[stack.length - 1]) {
      stack.pop();
      index += 1;
      continue;
    }
    const closer = CLOSERS[char];
    if (closer !== undefined) {
      stack.push(closer);
      index += 1;
      continue;
    }
    if (char === "}" || char === ")" || char === "]") return -1;
    index += 1;
  }
  return stack.length === 0 ? index : -1;
}

interface ObjectMember {
  key: string;
  /** Raw source of the value; the key's own name for `{ files }`, empty for a method. */
  value: string;
  /** Position among the object's members: later members win. */
  at: number;
}

interface ObjectBody {
  members: ObjectMember[];
  /**
   * Positions of members that could define a key we cannot see — a spread, a
   * computed key, a member we failed to parse. One of these before the key we
   * want is harmless, since the key overrides it; one after it, or one with no
   * key at all to compare against, means we do not know what the object holds.
   */
  opaqueAt: number[];
}

/** Split an object literal's members on its own top-level commas. `text` starts at `{`. */
function splitMembers(text: string): string[] | null {
  const end = skipBalanced(text, 0);
  if (end !== text.length) return null;
  const parts: string[] = [];
  let start = 1;
  let index = 1;
  while (index < end - 1) {
    const char = text[index] as string;
    if (QUOTES.has(char)) {
      const next = skipString(text, index);
      if (next < 0) return null;
      index = next;
      continue;
    }
    if (char === "/" && startsRegex(text, index)) {
      index = skipRegex(text, index);
      continue;
    }
    if (CLOSERS[char] !== undefined) {
      const next = skipBalanced(text, index);
      if (next < 0) return null;
      index = next;
      continue;
    }
    if (char === ",") {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
    index += 1;
  }
  parts.push(text.slice(start, end - 1));
  return parts;
}

const MEMBER_KEY = /^(?:([A-Za-z_$][\w$]*)|(['"])((?:[^'"\\\n]|\\.)*)\2)\s*/;
/** `get`, `set`, `async` and `*` in every spelling, quoted key included. */
const ACCESSOR_MEMBER = /^(?:async|get|set)[\s'"*[]|^\*/;

/** Parse an object literal's own members. `text` must start at its `{`. */
function parseObject(text: string): ObjectBody | null {
  const parts = splitMembers(text);
  if (parts === null) return null;
  const body: ObjectBody = { members: [], opaqueAt: [] };
  let at = 0;
  for (const part of parts) {
    const member = part.trim();
    if (member.length === 0) continue;
    at += 1;
    // A spread, a computed key, a getter, a generator: each can define the key
    // we are after with a value no static read can produce.
    if (member.startsWith("...") || member.startsWith("[") || ACCESSOR_MEMBER.test(member)) {
      body.opaqueAt.push(at);
      continue;
    }
    const key = MEMBER_KEY.exec(member);
    if (!key) {
      body.opaqueAt.push(at);
      continue;
    }
    const name = key[1] ?? key[3] ?? "";
    // `"\u0072outes"` is the key `routes` spelled so that a raw comparison
    // misses it, which would hide a duplicate that overrides the one we read.
    if (name.includes("\\")) {
      body.opaqueAt.push(at);
      continue;
    }
    const rest = member.slice(key[0].length);
    if (rest.startsWith(":")) {
      body.members.push({ key: name, value: rest.slice(1), at });
      continue;
    }
    // `{ files }` and `routes() {}` both name the key without giving us a value
    // we can read; both are recorded so the key never reads as absent. Anything
    // else after the key is a member shape we did not understand.
    if (rest.startsWith("(")) {
      body.members.push({ key: name, value: "", at });
      continue;
    }
    if (rest.length > 0) {
      body.opaqueAt.push(at);
      continue;
    }
    body.members.push({ key: name, value: name, at });
  }
  return body;
}

/**
 * A type assertion trailing a value — `{ ... } satisfies Config` is still that
 * object. Deliberately one type reference and nothing else: a looser character
 * class swallows `as any && other`, which is an expression, not a type.
 */
const TRAILING_ASSERTION = /^\s*(?:as|satisfies)\s+[A-Za-z_$][\w$.]*(?:<[^<>]*>)?(?:\[\])?/;

/** The object literal a value begins with, or null when it does not begin with one. */
function leadingObject(value: string): string | null {
  const text = value.trimStart();
  if (!text.startsWith("{")) return null;
  const end = skipBalanced(text, 0);
  return end < 0 ? null : text.slice(0, end);
}

/** The object literal a value *is*, exactly — not one it merely starts with. */
function asObjectLiteral(value: string): string | null {
  const object = leadingObject(value);
  if (object === null) return null;
  const tail = value.trimStart().slice(object.length).replace(TRAILING_ASSERTION, "");
  return tail.trim().length === 0 ? object : null;
}

/**
 * True when the object is the whole exported expression rather than its first
 * operand. `export default {} ? realConfig : {}` starts with an object that has
 * nothing to do with the config, and reading it as the export is a confident
 * answer to a question we never parsed.
 */
function objectIsWholeStatement(value: string, object: string): boolean {
  const tail = value.trimStart().slice(object.length).replace(TRAILING_ASSERTION, "");
  const rest = tail.trimStart();
  if (rest.length === 0 || rest.startsWith(";")) return true;
  // No semicolon: only a line break followed by something that starts a
  // statement ends the expression. `? :`, `&&`, `.x` and `instanceof` all carry
  // it on, and the object we matched is then not the value being exported.
  return /^[\r\n]/.test(tail) && /^[A-Za-z_$}]/.test(rest) && !/^(?:instanceof|in)\b/.test(rest);
}

/** The string a value is, when its content is fixed at rest. */
function asStringLiteral(value: string): StaticRead {
  const text = value.trim();
  const quote = text[0];
  if (text.length < 2 || quote === undefined || !QUOTES.has(quote)) return UNRESOLVED;
  if (skipString(text, 0) !== text.length || text[text.length - 1] !== quote) return UNRESOLVED;
  const content = text.slice(1, -1);
  // A template with a substitution is a computed value wearing a literal's
  // quotes, and an escape would have to be evaluated to know what it spells.
  if (content.includes("${") || content.includes("\\")) return UNRESOLVED;
  return { status: "literal", value: content };
}

/**
 * Read a string down a path of keys through nested object literals.
 *
 * Nothing here evaluates: a key whose value is an identifier, a call, a
 * concatenation or an object we cannot delimit reads as `unresolved`, and only
 * an object enumerated whole can report a key as `absent`.
 */
function readStaticString(objectText: string, keys: readonly string[]): StaticRead {
  const body = parseObject(objectText);
  if (!body) return UNRESOLVED;
  const [key, ...rest] = keys;
  if (key === undefined) return UNRESOLVED;
  // A duplicate key is won by the last one written.
  const member = [...body.members].reverse().find((candidate) => candidate.key === key);
  if (!member) return body.opaqueAt.length > 0 ? UNRESOLVED : ABSENT;
  // A spread after the key we read overwrites it with something we cannot see.
  if (body.opaqueAt.some((position) => position > member.at)) return UNRESOLVED;
  if (rest.length === 0) return asStringLiteral(member.value);
  const nested = asObjectLiteral(member.value);
  return nested === null ? UNRESOLVED : readStaticString(nested, rest);
}

/**
 * Call wrappers that hand their argument straight back, so the argument is the
 * config — and only when imported from the module that defines them that way.
 */
const TRANSPARENT_WRAPPERS: Record<string, RegExp> = {
  defineConfig: /\bimport\s*\{[^{}]*\bdefineConfig\b[^{}]*\}\s*from\s*['"]vite['"]/,
};

function importsTransparentWrapper(source: string, mask: Uint8Array, name: string): boolean {
  const imported = TRANSPARENT_WRAPPERS[name];
  return imported !== undefined && findInCode(source, mask, imported) !== null;
}

const DEFAULT_EXPORT = /export\s+default|module\.exports\s*=|exports\.default\s*=/y;
const NAMED_EXPORT = /export\s*\{/y;

function isIdentifierChar(char: string | undefined): boolean {
  // Unicode-aware, so a non-ASCII identifier ending right before `export` is
  // not mistaken for a word boundary.
  return char !== undefined && /[\p{L}\p{N}_$]/u.test(char);
}

/**
 * Scan `source` as code, handing every top-level index to `visit`, which
 * returns the index to resume from. Strings, template substitutions and regex
 * literals are stepped over, so nothing inside them is ever mistaken for the
 * code we are looking for.
 */
function scanCode(source: string, visit: (index: number) => number | null): boolean {
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    if (QUOTES.has(char)) {
      const end = skipString(source, index);
      // An unterminated string means we lost track of what is code and what is
      // text, and a file we stopped reading is not a file with nothing in it.
      if (end < 0) return false;
      index = end;
      continue;
    }
    if (char === "/" && startsRegex(source, index)) {
      index = skipRegex(source, index);
      continue;
    }
    const resume = visit(index);
    index = resume === null ? index + 1 : resume;
  }
  return true;
}

/**
 * Which indices are inside a string, template or regex *body*.
 *
 * The opening quote counts as code, so a pattern that starts at one — an import
 * specifier — still matches, while the same text quoted inside another string
 * does not. This is what stops a decoy in a comment-like string from answering
 * for the real import.
 */
function literalMask(source: string): Uint8Array {
  const mask = new Uint8Array(source.length);
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    let end: number;
    if (QUOTES.has(char)) end = skipString(source, index);
    else if (char === "/" && startsRegex(source, index)) end = skipRegex(source, index);
    else {
      index += 1;
      continue;
    }
    if (end < 0) end = source.length;
    for (let inside = index + 1; inside < end && inside < mask.length; inside += 1) {
      mask[inside] = 1;
    }
    index = Math.max(end, index + 1);
  }
  return mask;
}

/** The first match of `pattern` that begins outside any string or regex body. */
function findInCode(source: string, mask: Uint8Array, pattern: RegExp): RegExpExecArray | null {
  const scan = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`
  );
  let match = scan.exec(source);
  while (match) {
    if (mask[match.index] !== 1) return match;
    scan.lastIndex = match.index + 1;
    match = scan.exec(source);
  }
  return null;
}

/** Assignments to an export we did not read, after or instead of the default one. */
const EXPORT_MUTATION = /\b(?:module\s*\.\s*exports|exports)\s*(?:\.|\[)/;
/** `export * as default from …` — a default this cannot follow. */
const STAR_DEFAULT_EXPORT = /\bexport\s*\*\s*as\s+default\b/;

/**
 * The argument text of every call to `name(...)`, in source order.
 *
 * Matched by comparison rather than by a regex built from `name`: an alias like
 * `kit$` would otherwise be interpolated into a pattern where `$` means the end
 * of the input, and the calls would never be found.
 */
function callArguments(
  source: string,
  name: string,
  ignoreBefore = 0
): { args: string[]; references: number } | null {
  const found: string[] = [];
  let references = 0;
  let failed = false;
  const whole = scanCode(source, (index) => {
    if (source[index] !== name[0] || !source.startsWith(name, index)) return null;
    if (isIdentifierChar(source[index - 1]) || source[index - 1] === ".") return null;
    let open = index + name.length;
    if (isIdentifierChar(source[open])) return null;
    while (open < source.length && /\s/.test(source[open] as string)) open += 1;
    if (source[open] !== "(") {
      // The plugin passed on rather than called — `const kit = sveltekit` —
      // means the call that matters may be one we never see.
      if (index > ignoreBefore) references += 1;
      return index + name.length;
    }
    const end = skipBalanced(source, open);
    if (end < 0) {
      failed = true;
      return source.length;
    }
    found.push(source.slice(open + 1, end - 1));
    return end;
  });
  return failed || !whole ? null : { args: found, references };
}

/**
 * The object a module exports as its default, as source text.
 *
 * `unresolved` covers everything indirect: `export default config`, a call we
 * do not know to be transparent, a re-export, two default-looking exports. The
 * regexes this replaces had no notion of the export at all, so any object that
 * merely lived in the file — a decoy, a disabled variant, a helper — could
 * answer for the one the app actually uses.
 */
type ExportedConfig = { status: "object"; text: string } | { status: "unresolved" | "absent" };

function exportedConfigObject(source: string): ExportedConfig {
  const values: string[] = [];
  let indirect = false;
  const whole = scanCode(source, (index) => {
    const char = source[index] as string;
    if (char !== "e" && char !== "m") return null;
    if (isIdentifierChar(source[index - 1]) || source[index - 1] === ".") return null;
    DEFAULT_EXPORT.lastIndex = index;
    const match = DEFAULT_EXPORT.exec(source);
    if (match) {
      values.push(source.slice(index + match[0].length));
      return index + match[0].length;
    }
    NAMED_EXPORT.lastIndex = index;
    const named = NAMED_EXPORT.exec(source);
    if (!named) return null;
    const brace = index + named[0].length - 1;
    const end = skipBalanced(source, brace);
    if (end < 0) {
      indirect = true;
      return source.length;
    }
    // `export { config as default }` names a default we cannot follow.
    if (/\bdefault\b/.test(source.slice(brace, end))) indirect = true;
    return end;
  });

  const mask = literalMask(source);
  // `module.exports.kit.files.routes = …` after the assignment we read, or
  // instead of one: either way the module exports something we did not read.
  const mutated =
    findInCode(source, mask, EXPORT_MUTATION) ?? findInCode(source, mask, STAR_DEFAULT_EXPORT);
  if (indirect || !whole || mutated) return { status: "unresolved" };
  if (values.length === 0) return { status: "absent" };
  // A module has one default. Two means we misread the file, and a misread
  // file is not one we may answer from.
  if (values.length > 1) return { status: "unresolved" };
  const value = (values[0] as string).trimStart();
  const direct = leadingObject(value);
  if (direct !== null) {
    return objectIsWholeStatement(value, direct)
      ? { status: "object", text: direct }
      : { status: "unresolved" };
  }
  const wrapper = /^([A-Za-z_$][\w$]*)\s*\(/.exec(value);
  // A local `function defineConfig(c) { return somethingElse; }` is transparent
  // in name only, so the helper has to be the imported one.
  if (!wrapper || !importsTransparentWrapper(source, mask, wrapper[1] as string)) {
    return { status: "unresolved" };
  }
  const open = wrapper[0].length - 1;
  const end = skipBalanced(value, open);
  if (end < 0 || !objectIsWholeStatement(value, value.slice(0, end))) {
    return { status: "unresolved" };
  }
  const inner = asObjectLiteral(value.slice(open + 1, end - 1));
  return inner === null ? { status: "unresolved" } : { status: "object", text: inner };
}

/**
 * What the Vite config says about where Kit's configuration comes from.
 *
 * `bypass` carries the flat `KitConfig` handed to the plugin — the argument is
 * not wrapped in a `kit` key — and means `svelte.config.*` is ignored outright,
 * which is what Kit has done since 2.62.0. `passthrough` is the ordinary
 * `sveltekit()`, where the Svelte config applies as it always did.
 */
type ViteKitConfig =
  { status: "bypass"; text: string } | { status: "passthrough" } | { status: "unresolved" };

const PASSTHROUGH: ViteKitConfig = { status: "passthrough" };

const KIT_VITE_MODULE = /['"]@sveltejs\/kit\/vite['"]/;
/** A call whose result is the plugin the config exports, rather than one bound aside. */
/**
 * The binding clause immediately before the module specifier. Matched against a
 * short window rather than the whole file: an unanchored import pattern
 * backtracks quadratically across a config full of other imports.
 */
const KIT_VITE_CLAUSE = /\{([^{}]*)\}\s*(?:from|=\s*require\s*\()\s*$/;
const KIT_VITE_NAMESPACE = /\*\s+as\s+[\w$]+\s*(?:from|=\s*require\s*\()\s*$/;
const IMPORT_CLAUSE_WINDOW = 400;
const SVELTEKIT_BINDING = /\bsveltekit\b(?:\s*(?::|as)\s*([A-Za-z_$][\w$]*))?/;

/**
 * The local name the `sveltekit` plugin factory is called by in this file.
 *
 * Null is the refusal, and it covers more than an alias we cannot follow: a
 * Vite config that never imports the plugin registers it from somewhere we did
 * not read, so whether it was handed a config is not a question this file can
 * answer. Guessing that a bare `sveltekit(` is the plugin — or that its absence
 * means there is no plugin config — is how a function of the same name, or a
 * shared plugin list, ends up deciding where we say the routes are.
 */
function sveltekitBinding(source: string, mask: Uint8Array): { name: string; end: number } | null {
  const module = findInCode(source, mask, KIT_VITE_MODULE);
  if (!module) return null;
  const before = source.slice(Math.max(0, module.index - IMPORT_CLAUSE_WINDOW), module.index);
  if (KIT_VITE_NAMESPACE.test(before)) return null;
  const clause = KIT_VITE_CLAUSE.exec(before);
  if (!clause) return null;
  const binding = SVELTEKIT_BINDING.exec(clause[1] as string);
  if (!binding) return null;
  return { name: binding[1] ?? "sveltekit", end: module.index + module[0].length };
}

/**
 * Whether the installed Kit reads a config passed to the Vite plugin at all.
 *
 * The argument only acquired that meaning in 2.62.0; before it, `sveltekit()`
 * took none and `svelte.config.js` applied whatever a caller passed. A version
 * we could not read is not a version we may assume either way.
 */
function viteConfigBypasses(kitVersion: string | null | undefined): boolean | null {
  if (!kitVersion) return null;
  const parts = /^(\d+)\.(\d+)\./.exec(kitVersion);
  if (!parts) return null;
  const major = Number(parts[1]);
  const minor = Number(parts[2]);
  return major > 2 || (major === 2 && minor >= 62);
}

/** A build script that points Vite at a config file we would never look for. */
const VITE_CONFIG_FLAG = /\bvite\b[^&|;]*\s(?:--config|-c)[\s=]/;

async function namesAnotherViteConfig(
  reader: ProjectFileReader,
  appRoot: string,
  options: ProjectReadOptions
): Promise<boolean> {
  const manifest = await readJsonFile(reader, joinPath(appRoot, "package.json"), options);
  const scripts = manifest?.["scripts"];
  if (typeof scripts !== "object" || scripts === null) return false;
  return Object.values(scripts as Record<string, unknown>).some(
    (script) => typeof script === "string" && VITE_CONFIG_FLAG.test(script)
  );
}

async function readViteKitConfig(
  reader: ProjectFileReader,
  appRoot: string,
  options: KitConfigReadOptions
): Promise<ViteKitConfig> {
  // `vite --config config/site.ts` puts the plugin registration in a file the
  // conventional names do not cover, so neither config here is authority.
  if (await namesAnotherViteConfig(reader, appRoot, options)) return { status: "unresolved" };
  for (const fileName of VITE_CONFIG_FILENAMES) {
    const read = await readBoundedTextFile(reader, joinPath(appRoot, fileName), options);
    if (read.status === "missing") continue;
    // A Vite config we were not allowed to read may be the one deciding the
    // Kit config, and nothing here can tell.
    if (read.status !== "ok") return { status: "unresolved" };
    const source = stripComments(read.text);
    const mask = literalMask(source);
    const imported = sveltekitBinding(source, mask);
    if (imported === null) return { status: "unresolved" };
    const calls = callArguments(source, imported.name, imported.end);
    // An imported plugin with no call we recognise, or one handed to something
    // else first, is configured somewhere we did not read.
    if (calls === null || calls.args.length === 0 || calls.references > 0) {
      return { status: "unresolved" };
    }
    const { args } = calls;
    const configured = args.filter((argument) => argument.trim().length > 0);
    if (configured.length === 0) return PASSTHROUGH;
    // Two plugin instances, or a configured one beside a bare one, is not a
    // shape to reason about; neither is an argument that is not a literal.
    if (configured.length !== args.length || configured.length > 1) {
      return { status: "unresolved" };
    }
    const bypasses = viteConfigBypasses(options.kitVersion);
    // A configured call under a Kit that ignores the argument, or under a
    // version we could not read, decides nothing we may report.
    if (bypasses === null) return { status: "unresolved" };
    if (!bypasses) return PASSTHROUGH;
    const text = asObjectLiteral(configured[0] as string);
    return text === null ? { status: "unresolved" } : { status: "bypass", text };
  }
  return PASSTHROUGH;
}

/**
 * Read one `kit.*` string out of the app's configuration, statically.
 *
 * The config is never executed. It is project code that runs with full Node
 * privileges, and detection must not run an untrusted repository — so a config
 * that computes the value, imports it, or assembles it from parts is reported
 * unresolved rather than guessed at. The Vite config is consulted first because
 * a config passed to `sveltekit(...)` replaces `svelte.config.*` entirely.
 */
async function readKitString(
  reader: ProjectFileReader,
  appRoot: string,
  keys: readonly string[],
  options: KitConfigReadOptions
): Promise<{ read: StaticRead; from: RoutesDirectorySource }> {
  const vite = await readViteKitConfig(reader, appRoot, options);
  if (vite.status === "unresolved") return { read: UNRESOLVED, from: "unresolved" };
  if (vite.status === "bypass") {
    // The plugin's argument is a flat `KitConfig`: `files.routes`, not `kit.files.routes`.
    return { read: readStaticString(vite.text, keys), from: "vite.config" };
  }

  for (const fileName of CONFIG_FILENAMES) {
    const read = await readBoundedTextFile(reader, joinPath(appRoot, fileName), options);
    if (read.status === "missing") continue;
    // A config refused for its size or its file type is a config we did not
    // read, which is not a project that configures nothing.
    if (read.status !== "ok") return { read: UNRESOLVED, from: "unresolved" };
    const exported = exportedConfigObject(stripComments(read.text));
    // A config file whose default export we did not find is a config we did not
    // read. Calling that "configures nothing" is the guess this whole module
    // exists to stop making.
    if (exported.status !== "object") return { read: UNRESOLVED, from: "svelte.config" };
    return { read: readStaticString(exported.text, ["kit", ...keys]), from: "svelte.config" };
  }
  return { read: ABSENT, from: "default" };
}

/**
 * `kit.paths.base` read statically, like the routes directory: `""` when the
 * config sets none, the literal when it is one, and null when it is computed
 * (usually from an environment variable) and so can't be known without
 * running the config.
 */
export async function resolveBasePath(
  reader: ProjectFileReader,
  appRoot: string,
  options: KitConfigReadOptions = {}
): Promise<string | null> {
  const { read } = await readKitString(reader, appRoot, ["paths", "base"], options);
  if (read.status === "absent") return "";
  return read.status === "literal" ? read.value : null;
}

/**
 * Where this app's routes live, and whether that was read or assumed.
 *
 * `source` is the point of the return shape: an unreadable config falls back to
 * `src/routes` like every other app, but says so, and a caller about to present
 * the route list as the project's truth can withhold it instead.
 */
export async function resolveRoutesDirectory(
  reader: ProjectFileReader,
  appRoot: string,
  options: KitConfigReadOptions = {}
): Promise<RoutesDirectory> {
  const fallback = joinPath(appRoot, DEFAULT_ROUTES_DIR);
  const { read, from } = await readKitString(reader, appRoot, ["files", "routes"], options);
  if (read.status === "unresolved") return { path: fallback, source: "unresolved" };
  // An absent key is Kit's own default, whichever config we read it out of.
  if (read.status === "absent") return { path: fallback, source: "default" };
  // Kept exactly as written: `" src/pages "` is a different directory from
  // `"src/pages"`, and trimming it would be reading a path the config does not
  // name. A value that is only whitespace names no directory at all.
  const configured = read.value;
  if (configured.trim().length === 0) return { path: fallback, source: "unresolved" };
  return {
    path: isAbsolutePath(configured) ? configured : joinPath(appRoot, configured),
    source: from === "unresolved" || from === "default" ? "unresolved" : from,
  };
}
