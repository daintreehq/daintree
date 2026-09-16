/**
 * The filesystem surface the project model is allowed to assume.
 *
 * Deliberately narrower than `node:fs`: the plugin's main side hands this
 * straight through from `host.fs` (`PluginFsApi`), whose reads are capability-
 * gated and realpath-contained to the declared scopes. Structurally
 * `PluginFsApi` satisfies it — its richer `PluginFsDirEntry` / `PluginFsStat`
 * and its optional options argument are assignable to these — so no adapter is
 * needed at the call site, and a test can hand over a fixture tree instead.
 *
 * Note what is *not* here: `mkdir`, `rename`, `rm`. Detection reads. It never
 * repairs a project, and the host API would not let it.
 */
export interface ProjectFsDirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

export interface ProjectFsStat {
  isDirectory: boolean;
  isFile: boolean;
}

export interface ProjectFileReader {
  readFile(path: string): Promise<string>;
  readdir(path: string): Promise<ProjectFsDirEntry[]>;
  stat(path: string): Promise<ProjectFsStat>;
}

/**
 * Separator of an existing absolute path. Worktree paths arrive from the host
 * in the platform's own form, and a Windows path must not acquire a stray `/`
 * halfway through — `host.fs` containment compares resolved paths.
 */
function separatorOf(base: string): "\\" | "/" {
  return base.includes("\\") && !base.includes("/") ? "\\" : "/";
}

export function joinPath(base: string, ...parts: string[]): string {
  const sep = separatorOf(base);
  const trimmed = base.endsWith(sep) ? base.slice(0, -sep.length) : base;
  const tail = parts
    .flatMap((part) => part.split(/[\\/]+/))
    .filter((segment) => segment.length > 0 && segment !== ".");
  return tail.length === 0 ? trimmed : `${trimmed}${sep}${tail.join(sep)}`;
}

export function parentPath(target: string): string | null {
  const sep = separatorOf(target);
  const index = target.lastIndexOf(sep);
  if (index <= 0) return null;
  const parent = target.slice(0, index);
  // `C:\` and `/` are their own roots; stopping here avoids an endless climb.
  return parent.length === 0 || parent.endsWith(":") ? null : parent;
}

export function basename(target: string): string {
  const segments = target.split(/[\\/]+/).filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? target;
}

/** Separator-insensitive form, for comparing two paths that may spell the same place differently. */
function normaliseSeparators(target: string): string {
  return target.split(/[\\/]+/).join("/");
}

/**
 * Worktree-relative, POSIX-separated — the form every path on the wire takes,
 * so a route reported on macOS reads the same as one reported on Windows.
 * Returns the absolute path unchanged when it is not inside the root, which is
 * the honest answer for an app outside the worktree rather than a `../..` chain
 * the UI would have to re-resolve.
 */
export function toWorktreeRelative(worktreeRoot: string, target: string): string {
  const sep = separatorOf(worktreeRoot);
  const root = worktreeRoot.endsWith(sep) ? worktreeRoot.slice(0, -sep.length) : worktreeRoot;
  if (target === root) return ".";
  if (!target.startsWith(root + sep)) return target.split(/[\\/]+/).join("/");
  return target
    .slice(root.length + sep.length)
    .split(/[\\/]+/)
    .join("/");
}

/** True when `candidate` is `root` or lives under it. */
export function isWithin(root: string, candidate: string): boolean {
  const base = normaliseSeparators(root).replace(/\/+$/, "");
  const target = normaliseSeparators(candidate).replace(/\/+$/, "");
  return target === base || target.startsWith(`${base}/`);
}

/**
 * Every directory from `start` up to and including `stop`, nearest first. When
 * `start` is not under `stop` the walk is just `[start]` — an app root outside
 * the worktree gets no implicit access to the tree above it.
 */
export function directoriesUpTo(start: string, stop: string): string[] {
  if (!isWithin(stop, start)) return [start];
  const chain: string[] = [];
  let current: string | null = start;
  while (current && isWithin(stop, current)) {
    chain.push(current);
    if (current === stop) break;
    current = parentPath(current);
  }
  return chain;
}

export async function readTextFile(
  reader: ProjectFileReader,
  path: string
): Promise<string | null> {
  try {
    return await reader.readFile(path);
  } catch {
    return null;
  }
}

/**
 * Why a JSON read produced no object.
 *
 * `unreadable` and `malformed` are not `missing`. A resolution that climbs on
 * absence must stop on either of the other two, or an unreadable app-local
 * package silently reports the version of a package one directory up.
 */
export type JsonReadStatus = "ok" | "missing" | "malformed";

export interface JsonReadResult {
  status: JsonReadStatus;
  value: Record<string, unknown> | null;
}

export async function readJsonFileResult(
  reader: ProjectFileReader,
  path: string
): Promise<JsonReadResult> {
  const text = await readTextFile(reader, path);
  if (text === null) return { status: "missing", value: null };
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? { status: "ok", value: parsed as Record<string, unknown> }
      : { status: "malformed", value: null };
  } catch {
    return { status: "malformed", value: null };
  }
}

/**
 * The lenient form, for callers that genuinely cannot act on the difference: a
 * project with a broken `package.json` is a project we cannot support, not an
 * exception that should take the whole detection pass down.
 */
export async function readJsonFile(
  reader: ProjectFileReader,
  path: string
): Promise<Record<string, unknown> | null> {
  const text = await readTextFile(reader, path);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function readDirectory(
  reader: ProjectFileReader,
  path: string
): Promise<ProjectFsDirEntry[]> {
  try {
    return await reader.readdir(path);
  } catch {
    return [];
  }
}

export async function fileExists(reader: ProjectFileReader, path: string): Promise<boolean> {
  try {
    return (await reader.stat(path)).isFile;
  } catch {
    return false;
  }
}

export async function directoryExists(reader: ProjectFileReader, path: string): Promise<boolean> {
  try {
    return (await reader.stat(path)).isDirectory;
  } catch {
    return false;
  }
}
