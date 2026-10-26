import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { holdsCredentialOrId } from "./voiceKeytermSecrets.js";

// A manifest bigger than this is generated output, not something a person wrote.
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_WORKSPACE_PACKAGES = 40;
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

async function readManifest(dir: string): Promise<Manifest | null> {
  try {
    const path = join(dir, "package.json");
    if ((await stat(path)).size > MAX_MANIFEST_BYTES) return null;
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
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

// Only the common `dir/*` and literal `dir/pkg` forms; anything fancier is skipped
// rather than globbed, because a hint isn't worth walking a monorepo for.
async function workspaceDirs(root: string, patterns: string[]): Promise<string[]> {
  const dirs: string[] = [];
  for (const pattern of patterns) {
    if (dirs.length >= MAX_WORKSPACE_PACKAGES) break;
    const segments = pattern.replace(/^\.\//, "").replace(/\/+$/, "").split("/");
    if (segments.some((s) => s === ".." || s === "**" || s === "")) continue;
    if (segments.length === 2 && segments[1] === "*") {
      try {
        const entries = await readdir(join(root, segments[0]!), { withFileTypes: true });
        for (const entry of entries) {
          if (dirs.length >= MAX_WORKSPACE_PACKAGES) break;
          if (entry.isDirectory() && !entry.name.startsWith(".")) {
            dirs.push(join(root, segments[0]!, entry.name));
          }
        }
      } catch {
        // The glob's parent doesn't exist.
      }
    } else if (!segments.some((s) => s.includes("*"))) {
      dirs.push(join(root, ...segments));
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
 * handful of small file reads at most.
 */
export async function deriveRepoNames(root: string): Promise<RepoNames> {
  const manifest = await readManifest(root);
  const names: string[] = [];
  if (typeof manifest?.name === "string") names.push(manifest.name);

  const packageDirs = await workspaceDirs(root, workspacePatterns(manifest?.workspaces));
  const workspaceManifests = await Promise.all(packageDirs.map((dir) => readManifest(dir)));
  for (const m of workspaceManifests) {
    if (typeof m?.name === "string") names.push(m.name);
  }

  try {
    const entries = await readdir(root, { withFileTypes: true });
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
