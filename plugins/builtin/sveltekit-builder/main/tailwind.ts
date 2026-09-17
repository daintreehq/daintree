import path from "node:path";
import { createHash } from "node:crypto";
import type { ResponsiveRange } from "../shared/protocol.js";
import type { TailwindDesignSystem } from "../shared/tailwind/index.js";
import { readSource } from "./source.js";
import type { Workspace } from "./workspace.js";

/**
 * The project's Tailwind design system, loaded once per workspace and rebuilt
 * when the CSS entry or any of the project's own stylesheets it imports changes
 * — a theme file is where design tokens live. Dependency stylesheets under
 * `node_modules` aren't re-read on every request; an install arrives with a
 * change to the entry or a reopened workspace.
 */
export interface TailwindCache {
  cssEntry: string;
  /** The entry's revision this system was compiled from. */
  entryRevision: string;
  loaded: Promise<LoadedSystem>;
}

type LoadedSystem =
  | {
      status: "ok";
      system: TailwindDesignSystem;
      classNames: string[] | null;
      skippedModules: string[];
      /** The project's own imported stylesheets and the revision each was compiled from. */
      dependencies: Array<{ file: string; real: string; revision: string }>;
    }
  | { status: "unavailable"; reason: string };

type Unavailable = { status: "unavailable"; reason: string };

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

/**
 * `unknown`: the file could not be read, so it proves nothing either way.
 * `listed`: the scan saw it, so a failed read is a denial or a race, not a
 * missing conventional entry — `host.fs` reports all three as "missing".
 */
async function importsTailwind(
  workspace: Workspace,
  file: string,
  listed: boolean
): Promise<boolean | "unknown"> {
  const read = await readSource(workspace.fs, file);
  if (read.status === "ok") return IMPORTS_TAILWIND.test(read.text);
  return read.status === "missing" && !listed ? false : "unknown";
}

/**
 * The stylesheet that imports Tailwind, found by content rather than by name.
 * `certain` is false when a stylesheet or directory it found could not be read, so "no entry"
 * is not "this site doesn't use Tailwind". The scan's depth and size bounds are
 * not uncertainty: an entry is conventionally near the top of `src`, and a
 * plain-CSS site with many stylesheets must not read as a broken Tailwind one.
 */
async function findCssEntry(
  workspace: Workspace
): Promise<{ entry: string | null; certain: boolean }> {
  for (const relative of PREFERRED_ENTRIES) {
    const file = path.join(workspace.appRoot, ...relative.split("/"));
    if ((await importsTailwind(workspace, file, false)) === true) {
      return { entry: file, certain: true };
    }
  }

  let certain = true;
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
        // A directory the scan listed and then couldn't open may hold the entry.
        if (depth > 0) certain = false;
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
    const imports = await importsTailwind(workspace, file, true);
    if (imports === true) return { entry: file, certain: true };
    if (imports === "unknown") certain = false;
  }
  return { entry: null, certain };
}

type WorkspaceSystem =
  | { status: "ok"; revision: string; loaded: Extract<LoadedSystem, { status: "ok" }> }
  | { status: "unavailable"; reason: string; unused: boolean };

/** Completion and catalog results carry no `unused`; their schemas are strict. */
function unavailableOf(system: Extract<WorkspaceSystem, { status: "unavailable" }>): Unavailable {
  return { status: "unavailable", reason: system.reason };
}

export async function loadWorkspaceTailwind(workspace: Workspace): Promise<WorkspaceSystem> {
  let cssEntry = workspace.tailwind?.cssEntry ?? null;
  if (cssEntry === null) {
    const search = await findCssEntry(workspace);
    if (search.entry === null) {
      return search.certain
        ? {
            status: "unavailable",
            reason: "no stylesheet in this app imports tailwindcss",
            unused: true,
          }
        : {
            status: "unavailable",
            reason:
              "some stylesheets in this app couldn't be read, so its Tailwind entry wasn't found",
            unused: false,
          };
    }
    cssEntry = search.entry;
  }
  const read = await readSource(workspace.fs, cssEntry);
  if (read.status !== "ok") {
    // The remembered entry may have been deleted or renamed; look again next time.
    workspace.tailwind = null;
    return {
      status: "unavailable",
      reason: `${path.basename(cssEntry)} could not be read`,
      unused: false,
    };
  }

  let cache = workspace.tailwind;
  if (cache && cache.cssEntry === cssEntry && cache.entryRevision === read.revision) {
    const cached = await cache.loaded;
    if (cached.status === "ok" && !(await dependenciesUnchanged(cached))) {
      if (workspace.tailwind === cache) workspace.tailwind = null;
      cache = null;
    }
  } else {
    cache = null;
  }
  if (!cache) {
    cache = { cssEntry, entryRevision: read.revision, loaded: compile(workspace, cssEntry) };
    workspace.tailwind = cache;
  }
  const loaded = await cache.loaded;
  if (loaded.status !== "ok") {
    // A failure is often fixed without touching the entry (an install, an
    // imported file); caching it would pin "unavailable" until the entry changed.
    if (workspace.tailwind === cache) workspace.tailwind = null;
    return { ...loaded, unused: false };
  }
  return { status: "ok", revision: combinedRevision(cache.entryRevision, loaded), loaded };
}

function compile(workspace: Workspace, cssEntry: string): Promise<LoadedSystem> {
  return import("../shared/tailwind/index.js").then(
    async ({ loadTailwindDesignSystem }): Promise<LoadedSystem> => {
      const result = await loadTailwindDesignSystem({
        appRoot: workspace.appRoot,
        cssEntry,
        readRoot: workspace.worktreePath,
      });
      if (result.status !== "ok") return result;
      // The revisions of the bytes that were compiled, not of a later read: a
      // theme saved mid-compile must not be cached under its newer hash.
      const dependencies = result.stylesheets
        .filter((sheet) => !sheet.real.split(path.sep).includes("node_modules"))
        .map((sheet) => ({ file: sheet.path, real: sheet.real, revision: sheet.revision }));
      return {
        status: "ok",
        system: result.system,
        classNames: null,
        skippedModules: result.skippedModules,
        dependencies,
      };
    },
    (error: unknown): LoadedSystem => ({ status: "unavailable", reason: String(error) })
  );
}

async function dependenciesUnchanged(
  loaded: Extract<LoadedSystem, { status: "ok" }>
): Promise<boolean> {
  const { stylesheetRevision } = await import("../shared/tailwind/index.js");
  for (const dependency of loaded.dependencies) {
    // Unreadable now is a change: recompiling says why, where equality wouldn't.
    const now = await stylesheetRevision(dependency.file, dependency.real);
    if (now === null || now !== dependency.revision) return false;
  }
  return true;
}

/** One revision for everything the system was compiled from. */
function combinedRevision(
  entryRevision: string,
  loaded: Extract<LoadedSystem, { status: "ok" }>
): string {
  if (loaded.dependencies.length === 0) return entryRevision;
  const hash = createHash("sha256").update(entryRevision);
  for (const dependency of loaded.dependencies) {
    hash.update(`\0${dependency.file}\0${dependency.revision}`);
  }
  return hash.digest("hex");
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
  if (current.status !== "ok") return unavailableOf(current);
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
  if (current.status !== "ok") return unavailableOf(current);
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

const MAX_SKIPPED_REPORTED = 64;

export async function tailwindStatus(
  workspace: Workspace
): Promise<
  | { status: "available"; skippedModules: string[] }
  | { status: "unavailable"; reason: string; unused: boolean }
> {
  const current = await loadWorkspaceTailwind(workspace);
  if (current.status !== "ok") return current;
  return {
    status: "available",
    skippedModules: current.loaded.skippedModules
      .slice(0, MAX_SKIPPED_REPORTED)
      .map((id) => id.slice(0, 1024)),
  };
}

/**
 * Exactly what one token generates. Completion searches the class list, which
 * omits variants (`hover:p-4`) and arbitrary values (`w-[37px]`) that compile
 * perfectly well — so it can never answer "does this token do anything".
 */
export async function describeClass(
  workspace: Workspace,
  token: string
): Promise<
  | { status: "ok"; css: string | null; partial: boolean }
  | { status: "unavailable"; reason: string; unused: boolean }
> {
  const current = await loadWorkspaceTailwind(workspace);
  if (current.status !== "ok") return current;
  const { loaded } = current;
  let css: string | null;
  try {
    css = loaded.system.cssFor(token);
  } catch {
    css = null;
  }
  return {
    status: "ok",
    css: css === null ? null : css.slice(0, MAX_CANDIDATE_CSS_CHARS),
    partial: loaded.skippedModules.length > 0,
  };
}

/**
 * Which of the element's tokens each candidate would fight with. Built on the
 * declarations the project's Tailwind generates, so variants, composing
 * utilities and shorthands are judged by what they write, not by name.
 */
export async function classConflicts(
  workspace: Workspace,
  existing: string[],
  candidates: string[]
): Promise<
  | { status: "ok"; conflicts: Array<{ candidate: string; token: string; properties: string[] }> }
  | Unavailable
> {
  const current = await loadWorkspaceTailwind(workspace);
  if (current.status !== "ok") return unavailableOf(current);
  const { findConflicts } = await import("../shared/tailwind/index.js");
  const conflicts: Array<{ candidate: string; token: string; properties: string[] }> = [];
  for (const candidate of candidates) {
    try {
      for (const conflict of findConflicts(current.loaded.system, existing, candidate).conflicts) {
        if (candidates.includes(conflict.token)) continue;
        conflicts.push({
          candidate,
          token: conflict.token,
          properties: conflict.properties.slice(0, 64),
        });
      }
    } catch {
      // One candidate the engine can't analyse doesn't hide the others' conflicts.
    }
  }
  return { status: "ok", conflicts: conflicts.slice(0, 256) };
}
