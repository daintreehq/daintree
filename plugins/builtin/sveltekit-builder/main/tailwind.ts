import path from "node:path";
import type { ResponsiveRange } from "../shared/protocol.js";
import type { TailwindDesignSystem } from "../shared/tailwind/index.js";
import { readSource } from "./source.js";
import type { Workspace } from "./workspace.js";

/**
 * The project's Tailwind design system, loaded once per workspace and rebuilt
 * when the CSS entry's bytes change. Only the entry is hashed: an `@import`ed
 * stylesheet or plugin changing underneath it is not noticed until the entry
 * changes or the workspace is reopened.
 */
export interface TailwindCache {
  cssEntry: string;
  revision: string;
  loaded: Promise<LoadedSystem>;
}

type LoadedSystem =
  | { status: "ok"; system: TailwindDesignSystem; classNames: string[] | null }
  | { status: "unavailable"; reason: string };

/** Conventional entries first; SvelteKit's templates have used both. */
const PREFERRED_ENTRIES = ["src/app.css", "src/routes/layout.css", "src/app.pcss"];
const CSS_SCAN_ROOT = "src";
const CSS_SCAN_MAX_DEPTH = 4;
const CSS_SCAN_MAX_DIRECTORIES = 200;
const CSS_SCAN_MAX_FILES = 60;
const IMPORTS_TAILWIND = /@import\s+(?:url\()?\s*["']tailwindcss(?:\/[^"']*)?["']|@tailwind\s/;
const SKIPPED = new Set(["node_modules", ".svelte-kit", "build", "dist", ".git"]);

export const MAX_THEME_TOKENS = 2000;
export const MAX_CANDIDATE_CSS_CHARS = 4000;
const MAX_COMPILES_PER_RESULT = 5;
const THEME_NAMESPACES = [
  "--color-",
  "--spacing",
  "--font-",
  "--text-",
  "--radius-",
  "--breakpoint-",
];

async function importsTailwind(workspace: Workspace, file: string): Promise<boolean> {
  const read = await readSource(workspace.fs, file);
  return read.status === "ok" && IMPORTS_TAILWIND.test(read.text);
}

/** The stylesheet that imports Tailwind, found by content rather than by name. */
async function findCssEntry(workspace: Workspace): Promise<string | null> {
  for (const relative of PREFERRED_ENTRIES) {
    const file = path.join(workspace.appRoot, ...relative.split("/"));
    if (await importsTailwind(workspace, file)) return file;
  }

  const found: string[] = [];
  let queue = [path.join(workspace.appRoot, CSS_SCAN_ROOT)];
  let visited = 0;
  for (let depth = 0; depth <= CSS_SCAN_MAX_DEPTH && queue.length > 0; depth++) {
    const next: string[] = [];
    for (const directory of queue) {
      if (visited++ >= CSS_SCAN_MAX_DIRECTORIES || found.length >= CSS_SCAN_MAX_FILES) break;
      let entries;
      try {
        entries = await workspace.fs.readdir(directory);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory && !SKIPPED.has(entry.name)) next.push(full);
        else if (entry.isFile && /\.(css|pcss|postcss)$/.test(entry.name)) found.push(full);
      }
    }
    queue = next;
  }
  // Shortest path first: the entry is conventionally near the top of `src`.
  found.sort((a, b) => a.length - b.length || a.localeCompare(b));
  for (const file of found.slice(0, CSS_SCAN_MAX_FILES)) {
    if (await importsTailwind(workspace, file)) return file;
  }
  return null;
}

type WorkspaceSystem =
  | { status: "ok"; revision: string; loaded: Extract<LoadedSystem, { status: "ok" }> }
  | { status: "unavailable"; reason: string };

export async function loadWorkspaceTailwind(workspace: Workspace): Promise<WorkspaceSystem> {
  const cssEntry = workspace.tailwind?.cssEntry ?? (await findCssEntry(workspace));
  if (cssEntry === null) {
    return { status: "unavailable", reason: "no stylesheet in this app imports tailwindcss" };
  }
  const read = await readSource(workspace.fs, cssEntry);
  if (read.status !== "ok") {
    // The remembered entry may have been deleted or renamed; look again next time.
    workspace.tailwind = null;
    return { status: "unavailable", reason: `${path.basename(cssEntry)} could not be read` };
  }

  let cache = workspace.tailwind;
  if (!cache || cache.cssEntry !== cssEntry || cache.revision !== read.revision) {
    const loaded = import("../shared/tailwind/index.js").then(
      async ({ loadTailwindDesignSystem }): Promise<LoadedSystem> => {
        const result = await loadTailwindDesignSystem({ appRoot: workspace.appRoot, cssEntry });
        return result.status === "ok"
          ? { status: "ok", system: result.system, classNames: null }
          : result;
      },
      (error: unknown): LoadedSystem => ({ status: "unavailable", reason: String(error) })
    );
    cache = { cssEntry, revision: read.revision, loaded };
    workspace.tailwind = cache;
  }
  const loaded = await cache.loaded;
  if (loaded.status !== "ok") {
    // A failure is often fixed without touching the entry (an install, an
    // imported file); caching it would pin "unavailable" until the entry changed.
    if (workspace.tailwind === cache) workspace.tailwind = null;
    return loaded;
  }
  return { status: "ok", revision: cache.revision, loaded };
}

export async function tailwindCatalog(workspace: Workspace): Promise<
  | {
      status: "ok";
      catalogRevision: string;
      ranges: ResponsiveRange[];
      themeTokens: Record<string, string>;
    }
  | { status: "unavailable"; reason: string }
> {
  const current = await loadWorkspaceTailwind(workspace);
  if (current.status !== "ok") return current;
  const { system } = current.loaded;
  const { resolveResponsiveRanges } = await import("../shared/tailwind/index.js");
  const themeTokens: Record<string, string> = {};
  let count = 0;
  for (const namespace of THEME_NAMESPACES) {
    for (const entry of system.themeNamespace(namespace)) {
      if (count++ >= MAX_THEME_TOKENS) break;
      themeTokens[`${namespace}${entry.name}`] = entry.value;
    }
  }
  return {
    status: "ok",
    catalogRevision: current.revision,
    ranges: resolveResponsiveRanges(system),
    themeTokens,
  };
}

/**
 * Prefix matches rank before substring matches; within each, the class list's
 * own order. Candidates that generate no CSS in this project are dropped — a
 * completion that does nothing is worse than none.
 */
export async function completeClasses(
  workspace: Workspace,
  query: string,
  limit: number
): Promise<
  | { status: "ok"; candidates: Array<{ candidate: string; css: string }> }
  | { status: "unavailable"; reason: string }
> {
  const current = await loadWorkspaceTailwind(workspace);
  if (current.status !== "ok") return current;
  const { loaded } = current;
  loaded.classNames ??= loaded.system.classNames();
  const needle = query.trim();
  const names = loaded.classNames;
  const prefix = names.filter((name) => name.startsWith(needle));
  const infix =
    prefix.length >= limit || needle.length === 0
      ? []
      : names.filter((name) => !name.startsWith(needle) && name.includes(needle));

  const candidates: Array<{ candidate: string; css: string }> = [];
  // Class-list entries can be patterns that generate nothing; bound how many
  // are compiled so a query matching thousands of them stays cheap.
  let budget = limit * MAX_COMPILES_PER_RESULT;
  for (const candidate of [...prefix, ...infix]) {
    if (candidates.length >= limit || budget-- <= 0) break;
    const css = loaded.system.cssFor(candidate);
    if (css === null) continue;
    candidates.push({ candidate, css: css.slice(0, MAX_CANDIDATE_CSS_CHARS) });
  }
  return { status: "ok", candidates };
}
