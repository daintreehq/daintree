import {
  type ProjectFileReader,
  joinPath,
  readDirectoryBounded,
  readJsonFile,
  toWorktreeRelative,
} from "./fs.js";

/**
 * Directories a project-wide scan must never descend into. `node_modules` is
 * the expensive one — an install can hold thousands of nested `package.json`
 * files, many of which depend on `@sveltejs/kit`, so walking it would both cost
 * seconds and report a dependency's own fixtures as the user's app.
 */
export const SKIPPED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".svelte-kit",
  "dist",
  "build",
  ".output",
  ".vercel",
  ".netlify",
]);

/**
 * Hidden directories (`.tmp`, `.cache`, `.turbo`) hold scratch copies, caches
 * and tool state, never the app a preview is running — a performance run's
 * copy of the site made every real app ambiguous.
 */
function isSkippedDirectory(name: string): boolean {
  return name.startsWith(".") || SKIPPED_DIRECTORY_NAMES.has(name);
}

export const KIT_PACKAGE = "@sveltejs/kit";

/** Depth below the worktree root. `apps/site` is 2; the default leaves room for a nested workspace app. */
const DEFAULT_MAX_DEPTH = 5;

/** Hard stop on a pathological tree, so detection cannot become a directory crawl. */
const DEFAULT_MAX_DIRECTORIES = 2000;

export interface SvelteKitApp {
  /** Absolute path of the app root — the directory owning the `package.json`. */
  appRoot: string;
  /** Same directory as the user sees it: worktree-relative, POSIX, `.` at the root. */
  relativePath: string;
  /** `name` from `package.json`. Null when unnamed — private apps often are. */
  packageName: string | null;
  /**
   * The declared `@sveltejs/kit` range. Evidence of intent only: it is what the
   * version gate must *not* be decided on (see `versions.ts`).
   */
  declaredKitRange: string;
}

export interface DiscoveryOptions {
  maxDepth?: number;
  maxDirectories?: number;
  /**
   * Cancels the walk between directories, and — through the reader it was
   * bound to — the read in flight. What it cannot interrupt is a `JSON.parse`
   * already running: that is synchronous, and the metadata byte cap is what
   * bounds it.
   */
  signal?: AbortSignal;
}

export interface DiscoveryResult {
  apps: SvelteKitApp[];
  /**
   * False when the scan hit its depth or directory budget, so the app list is
   * "what we found", not "what is there". Auto-selection is suppressed on a
   * truncated scan: "the only app" is a claim a partial walk cannot make.
   */
  complete: boolean;
}

function dependencyRecord(manifest: Record<string, unknown>, key: string): Record<string, string> {
  const raw = manifest[key];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

/** `dependencies` and `devDependencies` merged; SvelteKit is normally a dev dependency. */
export function declaredDependencies(manifest: Record<string, unknown>): Record<string, string> {
  return {
    ...dependencyRecord(manifest, "dependencies"),
    ...dependencyRecord(manifest, "devDependencies"),
  };
}

/**
 * Every SvelteKit app root under a worktree, outermost first.
 *
 * The app root is not the git root and the two identities stay separate all the
 * way to the wire: a monorepo's `apps/site` is an app root whose worktree is the
 * repository above it. More than one result is the normal monorepo case and the
 * caller must ask the user rather than pick — hence `packageName`, which is the
 * only label a chooser can show.
 */
export async function discoverSvelteKitApps(
  reader: ProjectFileReader,
  worktreeRoot: string,
  options: DiscoveryOptions = {}
): Promise<DiscoveryResult> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxDirectories = options.maxDirectories ?? DEFAULT_MAX_DIRECTORIES;
  const { signal } = options;

  const found: SvelteKitApp[] = [];
  let queue: string[] = [worktreeRoot];
  let visited = 0;
  let truncated = false;

  for (let depth = 0; depth <= maxDepth && queue.length > 0; depth += 1) {
    const next: string[] = [];
    for (const dir of queue) {
      if (visited >= maxDirectories) {
        truncated = true;
        break;
      }
      // Checked per directory rather than per read: a closed workspace stops
      // the walk here, so nothing further is scheduled.
      signal?.throwIfAborted();
      visited += 1;

      const manifest = await readJsonFile(reader, joinPath(dir, "package.json"), { signal });
      if (manifest) {
        const range = declaredDependencies(manifest)[KIT_PACKAGE];
        if (typeof range === "string") {
          const name = manifest["name"];
          found.push({
            appRoot: dir,
            relativePath: toWorktreeRelative(worktreeRoot, dir),
            packageName: typeof name === "string" && name.length > 0 ? name : null,
            declaredKitRange: range,
          });
        }
      }

      const { entries: children, truncated: listingTruncated } = await readDirectoryBounded(
        reader,
        dir,
        { signal }
      );
      // A listing that hit the entry cap may hide an app, so the scan is no
      // more "the whole tree" than one that hit the directory budget.
      truncated ||= listingTruncated;
      if (depth === maxDepth) {
        truncated ||= children.some(
          (entry) => entry.isDirectory && !isSkippedDirectory(entry.name)
        );
        continue;
      }
      for (const entry of children) {
        if (!entry.isDirectory) continue;
        if (isSkippedDirectory(entry.name)) continue;
        // Queued against the remaining visit budget, not against the listing.
        // Without this a root of 2000 directories each holding thousands more
        // accumulates millions of paths the walk will never visit: the budget
        // bounds what is read, and this bounds what is retained to read it.
        if (visited + next.length >= maxDirectories) {
          truncated = true;
          break;
        }
        next.push(joinPath(dir, entry.name));
      }
    }
    queue = next;
  }

  return {
    apps: found.sort((a, b) => a.appRoot.localeCompare(b.appRoot)),
    complete: !truncated,
  };
}

/** The app list alone, for callers that have already decided truncation is acceptable. */
export async function findSvelteKitApps(
  reader: ProjectFileReader,
  worktreeRoot: string,
  options: DiscoveryOptions = {}
): Promise<SvelteKitApp[]> {
  return (await discoverSvelteKitApps(reader, worktreeRoot, options)).apps;
}

/**
 * Pick the app the caller asked for, or the only one there is.
 *
 * Returns null when there is a genuine choice to make. Guessing here is what
 * produces an editor bound to the docs site while the user is looking at the
 * marketing site, so ambiguity is propagated rather than resolved.
 */
export function selectApp(
  result: DiscoveryResult | SvelteKitApp[],
  requestedAppRoot?: string
): SvelteKitApp | null {
  const { apps, complete } = Array.isArray(result) ? { apps: result, complete: true } : result;
  if (requestedAppRoot) {
    // An explicit choice stands on its own: the scan's completeness has no
    // bearing on an app the caller already named.
    return apps.find((app) => app.appRoot === requestedAppRoot) ?? null;
  }
  return complete && apps.length === 1 ? (apps[0] ?? null) : null;
}
