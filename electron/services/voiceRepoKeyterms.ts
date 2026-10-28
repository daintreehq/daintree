import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { stripUtf8Bom } from "../utils/stripUtf8Bom.js";
import { holdsCredentialOrId } from "./voiceKeytermSecrets.js";

// A manifest bigger than this is generated output, not something a person wrote.
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_WORKSPACE_PACKAGES = 40;
// A pattern whose parent is missing or empty adds no package, so the package cap
// alone wouldn't stop a manifest listing thousands of them.
export const MAX_WORKSPACE_PATTERNS = 20;
const MAX_DEPENDENCIES = 60;
const MAX_TOP_LEVEL_ENTRIES = 80;

const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  "target",
  "tmp",
  "temp",
  "src",
  "lib",
  "docs",
  "test",
  "tests",
  "scripts",
  "public",
  "assets",
]);

export interface RepoNames {
  /** Ranked best-first: the repo's own name, workspace packages, directories, then dependencies. */
  names: string[];
}

interface Manifest {
  name?: unknown;
  workspaces?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// Resolved before reading, so a symlinked manifest or package dir can't pull
// names from outside the repo, and a FIFO or device (whose stat size is 0)
// can't block the read or stream past the size cap.
async function readManifest(realRoot: string, dir: string): Promise<Manifest | null> {
  try {
    const path = await realpath(join(dir, "package.json"));
    if (!isWithin(realRoot, path)) return null;
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) return null;
    const parsed: unknown = JSON.parse(stripUtf8Bom(await readFile(path, "utf8")));
    return parsed && typeof parsed === "object" ? (parsed as Manifest) : null;
  } catch {
    return null;
  }
}

function workspacePatterns(workspaces: unknown): string[] {
  const list = Array.isArray(workspaces)
    ? workspaces
    : workspaces && typeof workspaces === "object"
      ? (workspaces as { packages?: unknown }).packages
      : undefined;
  return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : [];
}

/**
 * A workspace pattern's path segments, split on either separator because
 * Windows reads `..\x` as a parent hop. Null for anything that could leave
 * the root or needs a real glob.
 */
export function workspacePatternSegments(pattern: string): string[] | null {
  const segments = pattern
    .replace(/^\.[\\/]/, "")
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/);
  if (segments.some((s) => s === ".." || s === "**" || s === "" || s.includes(":"))) return null;
  return segments;
}

// Only the common `dir/*` and literal `dir/pkg` forms; anything fancier is skipped
// rather than globbed, because a hint isn't worth walking a monorepo for.
async function workspaceDirs(
  realRoot: string,
  patterns: string[],
  spent: () => boolean
): Promise<string[]> {
  const dirs: string[] = [];
  for (const pattern of patterns.slice(0, MAX_WORKSPACE_PATTERNS)) {
    if (dirs.length >= MAX_WORKSPACE_PACKAGES || spent()) break;
    const segments = workspacePatternSegments(pattern);
    if (!segments) continue;
    if (segments.length === 2 && segments[1] === "*") {
      try {
        const parent = await realpath(join(realRoot, segments[0]!));
        if (!isWithin(realRoot, parent)) continue;
        const entries = await readdir(parent, { withFileTypes: true });
        for (const entry of entries) {
          if (dirs.length >= MAX_WORKSPACE_PACKAGES) break;
          if (entry.isDirectory() && !entry.name.startsWith(".")) {
            dirs.push(join(parent, entry.name));
          }
        }
      } catch {
        // The glob's parent doesn't exist.
      }
    } else if (!segments.some((s) => s.includes("*"))) {
      const dir = join(realRoot, ...segments);
      if (isWithin(realRoot, dir)) dirs.push(dir);
    }
  }
  return dirs;
}

function objectKeys(value: unknown): string[] {
  return value && typeof value === "object" ? Object.keys(value) : [];
}

/**
 * Names the repository itself carries: the package name, workspace package
 * names, top-level directories and dependency names. Read fresh per session and
 * never stored. Every read is a bounded one, so a large monorepo costs a
 * handful of small file reads at most, and none starts after `deadline`
 * (a `performance.now()` time), since the caller has stopped waiting by then.
 */
export async function deriveRepoNames(root: string, deadline = Infinity): Promise<RepoNames> {
  const spent = () => performance.now() >= deadline;
  if (spent()) return { names: [] };
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return { names: [] };
  }

  const manifest = spent() ? null : await readManifest(realRoot, realRoot);
  const names: string[] = [];
  if (typeof manifest?.name === "string") names.push(manifest.name);

  const packageDirs = await workspaceDirs(realRoot, workspacePatterns(manifest?.workspaces), spent);
  const workspaceManifests = spent()
    ? []
    : await Promise.all(packageDirs.map((dir) => readManifest(realRoot, dir)));
  for (const m of workspaceManifests) {
    if (typeof m?.name === "string") names.push(m.name);
  }

  try {
    const entries = spent() ? [] : await readdir(realRoot, { withFileTypes: true });
    for (const entry of entries.slice(0, MAX_TOP_LEVEL_ENTRIES)) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      if (IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
      names.push(entry.name);
    }
  } catch {
    // An unreadable root yields only what the manifest gave.
  }

  const dependencies = [
    ...objectKeys(manifest?.dependencies),
    ...objectKeys(manifest?.devDependencies),
  ].slice(0, MAX_DEPENDENCIES);
  names.push(...dependencies);

  return { names: names.filter((name) => !holdsCredentialOrId(name)) };
}

/** `@scope/some-pkg` is said as "some pkg"; the scope is a publishing detail. */
export function stripPackageScope(name: string): string {
  return name.startsWith("@") ? name.split("/").slice(1).join("/") : name;
}
