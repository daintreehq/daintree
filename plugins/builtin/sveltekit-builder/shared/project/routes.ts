import type { RouteNode } from "../protocol.js";
import {
  type ProjectFileReader,
  joinPath,
  readDirectory,
  readTextFile,
  toWorktreeRelative,
} from "./fs.js";

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
    endpointFile: null,
    errorFile: null,
  };
}

/** Something the routes tree says that SvelteKit would reject or that we could not read. */
export interface RouteDiagnostic {
  code: "unresolved-layout-reset" | "duplicate-route-id" | "traversal-truncated";
  message: string;
  /** Worktree-relative paths the diagnostic is about. */
  files: string[];
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
}

async function collectDirs(
  reader: ProjectFileReader,
  dir: RouteDir,
  depth: number,
  maxDepth: number,
  out: RouteDir[],
  state: CollectState
): Promise<void> {
  out.push(dir);
  state.visited += 1;
  const entries = await readDirectory(reader, dir.absPath);
  const children: RouteDir[] = [];

  for (const entry of entries) {
    const abs = joinPath(dir.absPath, entry.name);

    // A plain `readdir` describes a symlink as neither file nor directory, so
    // an entry of unknown kind is stat'ed rather than dropped: SvelteKit
    // follows a linked routes subtree and so must we.
    let isDirectory = entry.isDirectory;
    if (!entry.isDirectory && !entry.isFile) {
      try {
        isDirectory = (await reader.stat(abs)).isDirectory;
      } catch {
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
    else if (info.kind === "page-load" || info.kind === "page-server") dir.pageModuleFile = abs;
    else if (info.kind === "endpoint") dir.endpointFile = abs;
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

    nodes.push({
      routeId: routeIdFromSegments(dir.segments),
      pageFile: dir.page ? relative(dir.page.file) : null,
      layoutFiles,
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

export interface RoutesDirectory {
  /** Absolute path. May not exist — an app can point `kit.files.routes` at a directory it has not created. */
  path: string;
  /**
   * `unresolved` means the config names a routes directory we could not read
   * statically, so `path` is the default and the UI must say it is a fallback.
   */
  source: "svelte.config" | "default" | "unresolved";
}

export const DEFAULT_ROUTES_DIR = "src/routes";

const CONFIG_FILENAMES = [
  "svelte.config.js",
  "svelte.config.mjs",
  "svelte.config.ts",
  "svelte.config.cjs",
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

/**
 * Read `kit.files.routes` out of `svelte.config.*` statically.
 *
 * The config is never executed. It is project code that runs with full Node
 * privileges, and detection must not run an untrusted repository — so a config
 * that computes its routes directory is simply not statically readable and we
 * fall back to `src/routes`, which is what the overwhelming majority of apps
 * use anyway. The `source` field exists so the UI can say which of the two
 * happened instead of presenting a guess as a reading.
 */
export async function resolveRoutesDirectory(
  reader: ProjectFileReader,
  appRoot: string
): Promise<RoutesDirectory> {
  for (const fileName of CONFIG_FILENAMES) {
    const text = await readTextFile(reader, joinPath(appRoot, fileName));
    if (text === null) continue;
    const source = stripComments(text);
    const match =
      /\bkit\s*:\s*\{[\s\S]{0,4000}?\bfiles\s*:\s*\{[\s\S]{0,400}?\broutes\s*:\s*(['"`])([^'"`\n]*)\1\s*([,}])/.exec(
        source
      );
    // A template literal with a substitution is a computed value wearing a
    // literal's quotes, so it is rejected alongside concatenations and calls.
    const literal = match?.[2]?.includes("${") ? null : match?.[2];
    if (literal === null || literal === undefined) {
      // The key is there but its value is not a self-contained literal — a
      // concatenation, a template with a substitution, a call. We do not
      // execute project code to find out what it evaluates to, and guessing
      // `src/routes` while claiming we read the config would be a lie.
      const names = /\bkit\s*:\s*\{[\s\S]{0,4000}?\bfiles\s*:\s*\{[\s\S]{0,400}?\broutes\s*:/.test(
        source
      );
      return {
        path: joinPath(appRoot, DEFAULT_ROUTES_DIR),
        source: names ? "unresolved" : "default",
      };
    }
    const configured = literal.trim();
    if (configured) {
      return {
        path: isAbsolutePath(configured) ? configured : joinPath(appRoot, configured),
        source: "svelte.config",
      };
    }
    break;
  }
  return { path: joinPath(appRoot, DEFAULT_ROUTES_DIR), source: "default" };
}
