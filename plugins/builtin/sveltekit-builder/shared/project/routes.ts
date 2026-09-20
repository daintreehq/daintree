import type { RouteDiagnostic, RouteNode, RoutesDirectorySource } from "../protocol.js";
import {
  type ProjectFileReader,
  type ProjectReadOptions,
  isWithin,
  joinPath,
  normalisePath,
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
  // One directory is one truncation, however many of its children were cut:
  // the diagnostic names the directory, so N copies of it are N identical
  // messages on the wire.
  let truncatedHere = false;

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
        if (!truncatedHere) {
          truncatedHere = true;
          state.truncated.push(dir);
        }
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
  /**
   * The worktree the app belongs to, which bounds where a config may point the
   * route walk. Absent means the app root bounds it — the honest default for a
   * caller that has not said what the tree is.
   */
  worktreeRoot?: string;
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

/**
 * The config files SvelteKit itself looks for, in its own order. Kit names
 * exactly these two — its Vite plugin warns about `svelte.config.js` and
 * `svelte.config.ts` when a config is passed instead — so reading a value out
 * of any other spelling would be reporting a file the app never loads.
 */
const CONFIG_FILENAMES = ["svelte.config.js", "svelte.config.ts"];

/**
 * Spellings a project may keep but Kit does not load. Their presence is not a
 * reading and not an absence either: it is a file that looks authoritative and
 * may or may not be, depending on a loader we are not running.
 */
const UNLOADED_CONFIG_FILENAMES = ["svelte.config.mjs", "svelte.config.cjs"];

/**
 * Since Kit 2.62.0 a config passed to the Vite plugin — `sveltekit({ ... })` —
 * is used *instead of* `svelte.config.js` rather than merged with it. So these
 * files decide whether anything read from `svelte.config.*` describes the app
 * at all.
 */
/** Vite's own resolution order for an unnamed config. */
const VITE_CONFIG_FILENAMES = [
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.ts",
  "vite.config.cjs",
  "vite.config.mts",
  "vite.config.cts",
];

/** Every character JavaScript ends a line comment at. */
const LINE_TERMINATORS = new Set(["\n", "\r", "\u2028", "\u2029"]);

/**
 * Comments removed; string contents preserved so a path is never mangled.
 *
 * Regex literals are stepped over rather than read for comment markers: `/[//]/`
 * is a valid regex whose body looks exactly like the start of a line comment,
 * and deleting the rest of that line takes real code — including an assignment
 * that would have changed the answer — out of the file before anything else
 * sees it. Null when a `/` cannot be classified, since a stripper that guesses
 * there produces a file that is no longer the one on disk.
 */
function stripComments(source: string): string | null {
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
      while (i < source.length && !LINE_TERMINATORS.has(source[i] as string)) i += 1;
      out += "\n";
      // The terminator itself is re-read, except that we just emitted one.
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 1;
      out += " ";
      continue;
    }
    if (char === "/") {
      // Classified against what has been emitted so far, which is this file
      // with its comments already gone — the same text every later pass sees.
      const kind = classifySlash(out, out.length);
      if (kind === "ambiguous") return null;
      if (kind === "regex") {
        const end = skipRegex(source, i);
        out += source.slice(i, end);
        i = end - 1;
        continue;
      }
    }
    out += char;
  }
  return out;
}

/**
 * Absolute *for this project's platform*. `C:/routes` is a directory named `C:`
 * on macOS, which Kit resolves against the app root like any other relative
 * path, so the drive form only counts when the app root is a Windows path.
 */
function isAbsolutePath(value: string, appRoot: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(appRoot)) {
    return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\");
  }
  return value.startsWith("/");
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
/**
 * Reserved words a regex may follow. A word that is not reserved is a value,
 * and a value can only be divided — so the list has to be the whole set, not
 * the common few: `void /}}};/` misread as a division swallows the config.
 */
const REGEX_KEYWORDS = new Set([
  "await",
  "case",
  "default",
  "delete",
  "do",
  "else",
  "extends",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

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

/**
 * Closers after which a `/` could equally begin a regex or divide.
 *
 * `if (x) /re/.test(s)` and `(a + b) / c` differ only in whether the `)` closed
 * a control-flow head, which cannot be known without parsing statements.
 */
const AMBIGUOUS_BEFORE_SLASH = new Set([")", "]", "}"]);

/**
 * What a `/` is: the opening of a regex, a division, or a question this scanner
 * cannot answer.
 *
 * `ambiguous` is not a defeat to route around. Guessing division swallows the
 * rest of a regex body — including any braces in it — and a swallowed `}}};`
 * can end the config object early and leave a shorter object that still parses.
 * That reads as a confident answer about a file we mis-scanned, so the file is
 * abandoned instead.
 */
type SlashKind = "regex" | "division" | "ambiguous";

function classifySlash(source: string, at: number): SlashKind {
  let index = at - 1;
  while (index >= 0 && /\s/.test(source[index] as string)) index -= 1;
  if (index < 0) return "regex";
  const previous = source[index] as string;
  // `n++ / 2` divides; `n + /re/` does not. The doubled operator is the only
  // difference, and reading it as a regex swallows the rest of the line.
  if ((previous === "+" || previous === "-") && source[index - 1] === previous) return "ambiguous";
  if (REGEX_PRECEDERS.has(previous)) return "regex";
  if (AMBIGUOUS_BEFORE_SLASH.has(previous)) return "ambiguous";
  // Walked back rather than sliced: these files run to a quarter of a megabyte
  // and a slice per `/` would make the scan quadratic.
  let start = index;
  while (start >= 0 && /[\w$]/.test(source[start] as string)) start -= 1;
  // A value — identifier, number, string end — can only be divided.
  if (start === index) return "division";
  // `box.return / 2` reads a property that happens to be spelled like a
  // keyword, and a property is a value.
  if (source[start] === ".") return "division";
  return REGEX_KEYWORDS.has(source.slice(start + 1, index + 1)) ? "regex" : "division";
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
    if (char === "/") {
      const kind = classifySlash(source, index);
      if (kind === "ambiguous") return -1;
      if (kind === "regex") {
        index = skipRegex(source, index);
        continue;
      }
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
    if (char === "/") {
      const kind = classifySlash(text, index);
      if (kind === "ambiguous") return null;
      if (kind === "regex") {
        index = skipRegex(text, index);
        continue;
      }
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
    // `__proto__`, quoted or not, gives the object a prototype, and every key
    // we then fail to find could be inherited from it.
    if (name.includes("\\") || name === "__proto__") {
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
  // A line break is neither: a template normalises CRLF to LF when it is
  // evaluated, so the text here is not the string the config holds.
  if (content.includes("${") || content.includes("\\") || /[\r\n\u2028\u2029]/.test(content)) {
    return UNRESOLVED;
  }
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

/** Whole-string version, prerelease and build metadata included. */
const KIT_VERSION = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

const KIT_VITE_MODULE = /['"]@sveltejs\/kit\/vite['"]/;
const VITE_MODULE = /['"]vite['"]/;

/**
 * Call wrappers that hand their argument straight back, so the argument is the
 * config — and only when imported from the module that defines them that way.
 */
const TRANSPARENT_WRAPPERS: { imported: string; module: RegExp }[] = [
  { imported: "defineConfig", module: VITE_MODULE },
];

function importsTransparentWrapper(source: string, mask: Uint8Array, name: string): boolean {
  return TRANSPARENT_WRAPPERS.some(({ imported, module }) =>
    importedBindings(source, mask, module, imported).names.includes(name)
  );
}

const DEFAULT_EXPORT = /export\s+default|module\.exports\s*=|exports\.default\s*=/y;
const NAMED_EXPORT = /export\s*\{/y;

/** True when `at` begins a statement rather than continuing an expression. */
function startsStatement(source: string, at: number): boolean {
  let index = at - 1;
  while (index >= 0 && /\s/.test(source[index] as string)) index -= 1;
  if (index < 0) return true;
  const previous = source[index] as string;
  return previous === ";" || previous === "}" || previous === "{";
}

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
function scanCode(source: string, visit: (index: number, depth: number) => number | null): boolean {
  let index = 0;
  let depth = 0;
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
    if (char === "/") {
      const kind = classifySlash(source, index);
      if (kind === "ambiguous") return false;
      if (kind === "regex") {
        index = skipRegex(source, index);
        continue;
      }
    }
    const resume = visit(index, depth);
    if (resume !== null) {
      index = resume;
      continue;
    }
    // Depth is what tells a module-level `module.exports = …` from the same
    // text inside a function that may never run.
    if (CLOSERS[char] !== undefined) depth += 1;
    else if (char === "}" || char === ")" || char === "]") depth -= 1;
    index += 1;
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
function literalMask(source: string): Uint8Array | null {
  const mask = new Uint8Array(source.length);
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    let end: number;
    if (QUOTES.has(char)) end = skipString(source, index);
    else if (char === "/") {
      const kind = classifySlash(source, index);
      // Null, not a best guess: a mask built past a `/` we misread marks the
      // wrong spans as text, and every probe run over it is then unsound.
      if (kind === "ambiguous") return null;
      if (kind !== "regex") {
        index += 1;
        continue;
      }
      end = skipRegex(source, index);
    } else {
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

/** Every match of `pattern` that begins outside any string or regex body. */
function findAllInCode(source: string, mask: Uint8Array, pattern: RegExp): RegExpExecArray[] {
  const scan = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`
  );
  const found: RegExpExecArray[] = [];
  let match = scan.exec(source);
  while (match) {
    if (mask[match.index] !== 1) found.push(match);
    scan.lastIndex = match.index + 1;
    match = scan.exec(source);
  }
  return found;
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

/**
 * Any mention of the CommonJS export object.
 *
 * Every one of them is a refusal except the single assignment we read: a later
 * `module.exports.kit.files.routes = …`, an `Object.assign(module.exports, …)`,
 * a `module["exports"] = …` — each reaches the object we are reporting, and
 * none of them is something a static read can follow.
 */
const EXPORT_REFERENCE = /\b(?:module|exports)\b/;
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
  const whole = scanCode(source, (index): number | null => {
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
  // The span of the one accepted `module.exports = …`, so every other mention
  // of the export object can be counted against it.
  let commonJsSpan: [number, number] = [-1, -1];
  const whole = scanCode(source, (index, depth) => {
    const char = source[index] as string;
    if (char !== "e" && char !== "m") return null;
    if (isIdentifierChar(source[index - 1]) || source[index - 1] === ".") return null;
    DEFAULT_EXPORT.lastIndex = index;
    const match = DEFAULT_EXPORT.exec(source);
    if (match) {
      // `function f(module) { module.exports = … }` assigns to a parameter, not
      // to this module, and a nested `export default` is not valid JavaScript
      // at all — either way we are reading something we did not understand.
      // Depth alone does not mean the assignment runs: `if (false)
      // module.exports = …` is at depth zero and exports nothing. An
      // expression statement follows `;`, `}` or the start of the file.
      if (depth !== 0 || !startsStatement(source, index)) {
        indirect = true;
        return source.length;
      }
      if (char === "m" || match[0].startsWith("exports")) {
        commonJsSpan = [index, index + match[0].length];
      }
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
  if (mask === null) return { status: "unresolved" };
  const mentions = findAllInCode(source, mask, EXPORT_REFERENCE).filter(
    (mention) => mention.index < commonJsSpan[0] || mention.index >= commonJsSpan[1]
  );
  if (indirect || !whole || mentions.length > 0 || findInCode(source, mask, STAR_DEFAULT_EXPORT)) {
    return { status: "unresolved" };
  }
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

/**
 * The binding clause immediately before the module specifier. Matched against a
 * short window rather than the whole file: an unanchored import pattern
 * backtracks quadratically across a config full of other imports.
 */
// `import` only. A `const { x } = require("vite")` names a `require` the file
// itself may have defined, and following it authorises whatever that local
// function returns.
const IMPORT_CLAUSE = /\bimport\s*\{([^{}]*)\}\s*from\s*$/;
const NAMESPACE_CLAUSE = /\bimport\s*\*\s*as\s+[\w$]+\s*from\s*$/;
const IMPORT_SPECIFIER = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/;
const IMPORT_CLAUSE_WINDOW = 400;

interface ImportedBindings {
  /** Local names the module's `imported` export is bound to, in source order. */
  names: string[];
  /** Index just past the last import statement, so its own clause is not read as a use. */
  end: number;
  /** True when an import of this module was in a shape we could not read. */
  opaque: boolean;
}

/**
 * Every local name an export of `module` is bound to in this file.
 *
 * The *local* name is the point. A wrapper is transparent because of the module
 * it came from, not because of how this file spells it, and a file that aliases
 * the import is free to give the original spelling to a function of its own —
 * `import { defineConfig as viteConfig } from "vite"` beside a local
 * `function defineConfig`. Matching the imported spelling there authorises the
 * wrong function.
 */
function importedBindings(
  source: string,
  mask: Uint8Array,
  module: RegExp,
  imported: string
): ImportedBindings {
  const bindings: ImportedBindings = { names: [], end: 0, opaque: false };
  for (const match of findAllInCode(source, mask, module)) {
    bindings.end = Math.max(bindings.end, match.index + match[0].length);
    // Only a binding clause counts. `export { sveltekit } from "@sveltejs/kit/vite"`
    // re-exports the plugin without binding it here at all, and reading it as a
    // local `sveltekit` hands the name to whatever else this file calls that.
    const before = source.slice(Math.max(0, match.index - IMPORT_CLAUSE_WINDOW), match.index);
    if (NAMESPACE_CLAUSE.test(before)) {
      bindings.opaque = true;
      continue;
    }
    const clause = IMPORT_CLAUSE.exec(before);
    if (!clause) {
      // A specifier of this module that is not a named import we can read — a
      // bare side-effect import, a dynamic one, a clause longer than the window.
      bindings.opaque = true;
      continue;
    }
    for (const specifier of (clause[1] as string).split(",")) {
      const text = specifier.trim();
      if (text.length === 0) continue;
      const parsed = IMPORT_SPECIFIER.exec(text);
      if (!parsed) {
        bindings.opaque = true;
        continue;
      }
      if (parsed[1] !== imported) continue;
      bindings.names.push(parsed[2] ?? (parsed[1] as string));
    }
  }
  return bindings;
}

/**
 * The one local name the `sveltekit` plugin factory is called by in this file.
 *
 * Null is the refusal, and it covers more than an alias we cannot follow. A
 * Vite config that never imports the plugin registers it from somewhere we did
 * not read; a file that imports it twice under two names calls one of them from
 * its exported plugin list and the other from somewhere that may never run, and
 * which is which needs the dataflow this deliberately does not do.
 */
function sveltekitBinding(source: string, mask: Uint8Array): { name: string; end: number } | null {
  const bindings = importedBindings(source, mask, KIT_VITE_MODULE, "sveltekit");
  const unique = new Set(bindings.names);
  if (bindings.opaque || unique.size !== 1) return null;
  return { name: bindings.names[0] as string, end: bindings.end };
}

/**
 * Whether the installed Kit reads a config passed to the Vite plugin at all.
 *
 * The argument only acquired that meaning in 2.62.0; before it, `sveltekit()`
 * took none and `svelte.config.js` applied whatever a caller passed. A version
 * we could not read — a range, a prerelease of the boundary release, anything
 * that is not a plain version — is not a version we may assume either way.
 */
function viteConfigBypasses(kitVersion: string | null | undefined): boolean | null {
  if (!kitVersion) return null;
  // The whole string is validated: `2.61.0 || 2.70.0` is a range, not a
  // version, and reading its prefix would call the app old on the strength of
  // its first operand.
  const parts = KIT_VERSION.exec(kitVersion.trim());
  if (!parts) return null;
  const major = Number(parts[1]);
  const minor = Number(parts[2]);
  // `2.62.0-next.1` is before 2.62.0, not after it, and which prerelease line
  // it belongs to is more than this needs to know.
  if (parts[4] !== undefined && major === 2 && minor === 62) return null;
  return major > 2 || (major === 2 && minor >= 62);
}

/**
 * The flag itself, matched inside one command rather than across a whole
 * script. The command is split off first because a single pattern spanning
 * `vite` and the flag backtracks over every whitespace position when no flag
 * follows, and a manifest read is bounded at 256 KiB, not at a shell line.
 */
const VITE_CONFIG_FLAG = /(?:^|\s)["']?(?:--config|-c)["']?[\s=]/;

/** Long enough for any real script; past it the string is not a command line. */
const MAX_SCRIPT_BYTES = 4096;

/** A build script that points Vite at a config file we would never look for. */
function scriptNamesAnotherViteConfig(script: string): boolean {
  if (script.length > MAX_SCRIPT_BYTES) return false;
  return script.split(/[&|;]/).some((command) => {
    const vite = /\bvite\b/.exec(command);
    return vite !== null && VITE_CONFIG_FLAG.test(command.slice(vite.index + vite[0].length));
  });
}

async function namesAnotherViteConfig(
  reader: ProjectFileReader,
  appRoot: string,
  options: ProjectReadOptions
): Promise<boolean> {
  const manifest = await readJsonFile(reader, joinPath(appRoot, "package.json"), options);
  const scripts = manifest?.["scripts"];
  if (typeof scripts !== "object" || scripts === null) return false;
  return Object.values(scripts as Record<string, unknown>).some(
    (script) => typeof script === "string" && scriptNamesAnotherViteConfig(script)
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
    // A `/` we could not classify leaves us unable to say what in this file is
    // code, and the plugin call is exactly what we would be looking for in it.
    if (source === null) return { status: "unresolved" };
    const mask = literalMask(source);
    if (mask === null) return { status: "unresolved" };
    const imported = sveltekitBinding(source, mask);
    if (imported === null) return { status: "unresolved" };
    // The call has to be inside the object this file exports. One bound aside,
    // or a file whose default export comes from elsewhere, configures a plugin
    // that may never be the one Vite loads.
    const exported = exportedConfigObject(source);
    if (exported.status !== "object") return { status: "unresolved" };
    const calls = callArguments(exported.text, imported.name);
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
    const stripped = stripComments(read.text);
    if (stripped === null) return { read: UNRESOLVED, from: "unresolved" };
    const exported = exportedConfigObject(stripped);
    // A config file whose default export we did not find is a config we did not
    // read. Calling that "configures nothing" is the guess this whole module
    // exists to stop making.
    if (exported.status !== "object") return { read: UNRESOLVED, from: "svelte.config" };
    return { read: readStaticString(exported.text, ["kit", ...keys]), from: "svelte.config" };
  }
  // No file Kit loads. A spelling it does not load, sitting there configuring
  // something, is a reason to say we do not know rather than to report the
  // default: which of the two the app gets depends on the loader.
  for (const fileName of UNLOADED_CONFIG_FILENAMES) {
    const read = await readBoundedTextFile(reader, joinPath(appRoot, fileName), options);
    if (read.status !== "missing") return { read: UNRESOLVED, from: "unresolved" };
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
/**
 * Where Kit puts the routes when the config names no `files.routes`: inside
 * `files.src`, which is `src` unless the config says otherwise.
 */
async function routesUnderSrc(
  reader: ProjectFileReader,
  appRoot: string,
  fallback: string,
  options: KitConfigReadOptions
): Promise<RoutesDirectory> {
  const { read, from } = await readKitString(reader, appRoot, ["files", "src"], options);
  if (read.status === "unresolved") return { path: fallback, source: "unresolved" };
  if (read.status === "absent") return { path: fallback, source: "default" };
  const src = read.value;
  if (src.trim().length === 0) return { path: fallback, source: "unresolved" };
  const base = isAbsolutePath(src, appRoot) ? src : joinPath(appRoot, src);
  const path = normalisePath(joinPath(base, "routes"));
  if (!isWithin(options.worktreeRoot ?? appRoot, path)) {
    return { path: fallback, source: "unresolved" };
  }
  return {
    path,
    source: from === "unresolved" || from === "default" ? "unresolved" : from,
  };
}

export async function resolveRoutesDirectory(
  reader: ProjectFileReader,
  appRoot: string,
  options: KitConfigReadOptions = {}
): Promise<RoutesDirectory> {
  const fallback = joinPath(appRoot, DEFAULT_ROUTES_DIR);
  const { read, from } = await readKitString(reader, appRoot, ["files", "routes"], options);
  if (read.status === "unresolved") return { path: fallback, source: "unresolved" };
  // `files.routes` unset does not mean `src/routes`: Kit derives it from
  // `files.src`, which defaults to `src` but is a configuration option of its
  // own. Reading the fallback without asking is how `files: { src: "app" }`
  // gets reported as an unconfigured `src/routes`.
  if (read.status === "absent") return await routesUnderSrc(reader, appRoot, fallback, options);
  // Kept exactly as written: `" src/pages "` is a different directory from
  // `"src/pages"`, and trimming it would be reading a path the config does not
  // name. A value that is only whitespace names no directory at all.
  const configured = read.value;
  if (configured.trim().length === 0) return { path: fallback, source: "unresolved" };
  const path = normalisePath(
    isAbsolutePath(configured, appRoot) ? configured : joinPath(appRoot, configured)
  );
  // `joinPath` strips `.` but not `..`, and the config belongs to a repository
  // the user may not have chosen to trust. A route walk outside the tree — and
  // the absolute paths `toWorktreeRelative` would then put on the wire — is a
  // config we report as unreadable rather than one we follow.
  if (!isWithin(options.worktreeRoot ?? appRoot, path)) {
    return { path: fallback, source: "unresolved" };
  }
  return {
    path,
    source: from === "unresolved" || from === "default" ? "unresolved" : from,
  };
}
