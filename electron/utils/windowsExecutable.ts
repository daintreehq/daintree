import { lstatSync, promises as fsPromises, statSync } from "node:fs";
import path from "node:path";

// Given a bare program name, Windows process creation (and Node's spawn, which
// mirrors it) looks in the working directory before PATH, so a same-named file
// in a repository root would run in place of the tool. Everything here resolves
// executables from PATH only, hands spawn an absolute path, and never consults
// the working directory.
//
// PATH is searched asynchronously, never with a synchronous stat: a PATH entry
// on an unreachable network share holds a filesystem call for the SMB timeout,
// which would freeze whichever event loop made it (Main, the pty host, the
// workspace host). Names are compared as Node reads the directory (Unicode), so
// a profile directory such as `C:\Users\山田` is matched as written.

const SYSTEM_TOOLS = {
  "cmd.exe": ["System32", "cmd.exe"],
  "powershell.exe": ["System32", "WindowsPowerShell", "v1.0", "powershell.exe"],
  "reg.exe": ["System32", "reg.exe"],
  "wsl.exe": ["System32", "wsl.exe"],
} as const satisfies Record<string, readonly string[]>;

export type WindowsSystemTool = keyof typeof SYSTEM_TOOLS;

// Drive-qualified (`C:\tools`) or UNC (`\\server\share`). `C:tools` and
// `\tools` both depend on the working directory, so neither counts.
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/;

// What process creation starts directly, in libuv's search order.
const NATIVE_EXTENSIONS = [".com", ".exe"];
// What a shell (and `cliSpawnTarget`) can start; batch files need cmd.exe.
const LAUNCHABLE_EXTENSIONS = new Set([".com", ".exe", ".bat", ".cmd"]);
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * How long one search waits on a PATH directory before treating it as holding
 * nothing. Local directories answer in milliseconds; this is for a share that
 * has gone away, whose listing would otherwise wait out the SMB timeout.
 */
export const WINDOWS_PATH_ENTRY_TIMEOUT_MS = 1_500;
// A directory whose listing failed after being written off is left alone this
// long, so every search does not pay the timeout again for a dead share.
const STALLED_RETRY_MS = 30_000;

const RESOLVED_CACHE_LIMIT = 64;

/** The key Node forwards for `name`: matched case-insensitively, first in sort order. */
export function windowsEnvKey(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const wanted = name.toUpperCase();
  return Object.keys(env)
    .sort()
    .find((candidate) => candidate.toUpperCase() === wanted);
}

export function windowsEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = windowsEnvKey(env, name);
  return key === undefined ? undefined : env[key];
}

export function isWindowsAbsolutePath(value: string): boolean {
  return WINDOWS_ABSOLUTE.test(value);
}

/**
 * PATH's directories in order. A `;` inside double quotes is part of the
 * directory (`"C:\a;b"`), and the quotes themselves are dropped, which is how
 * cmd.exe and libuv read them. Empty entries are skipped.
 */
export function splitWindowsPath(value: string): string[] {
  const entries: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of value) {
    if (char === '"') {
      quoted = !quoted;
    } else if (char === ";" && !quoted) {
      if (current) entries.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current) entries.push(current);
  return entries;
}

/** PATHEXT's launchable extensions (`.com`, `.exe`, `.bat`, `.cmd`) in its order and spelling. */
export function windowsLaunchExtensions(env: NodeJS.ProcessEnv = process.env): string[] {
  const seen = new Set<string>();
  const extensions: string[] = [];
  for (const raw of (windowsEnvValue(env, "PATHEXT") ?? DEFAULT_PATHEXT).split(";")) {
    const extension = raw.trim();
    const key = extension.toLowerCase();
    if (!LAUNCHABLE_EXTENSIONS.has(key) || seen.has(key)) continue;
    seen.add(key);
    extensions.push(extension);
  }
  return extensions;
}

/**
 * Synchronous check of one known file. Never used to search PATH: only for a
 * path already in hand, such as the target a shim names beside itself.
 */
export function isWindowsLaunchFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    // Windows Store execution aliases are reparse points: stat reports EACCES,
    // while CreateProcess can still launch the alias by its resolved file name.
    try {
      return lstatSync(file).isSymbolicLink();
    } catch {
      return false;
    }
  }
}

export function windowsSystemRoot(env: NodeJS.ProcessEnv = process.env): string {
  for (const name of ["SYSTEMROOT", "WINDIR"]) {
    const value = windowsEnvValue(env, name);
    if (value && WINDOWS_ABSOLUTE.test(value)) return value;
  }
  return "C:\\Windows";
}

/** Absolute path of an in-box Windows tool under `%SystemRoot%`. */
export function windowsSystemTool(
  name: WindowsSystemTool,
  env: NodeJS.ProcessEnv = process.env
): string {
  return path.win32.join(windowsSystemRoot(env), ...SYSTEM_TOOLS[name]);
}

/** One entry of a directory listing, as `readdir(..., { withFileTypes: true })` reports it. */
export interface WindowsDirectoryEntry {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** The filesystem calls a PATH search makes; a test seam. */
export interface WindowsPathFs {
  readdir(directory: string): Promise<WindowsDirectoryEntry[]>;
  stat(file: string): Promise<{ isFile(): boolean }>;
  lstat(file: string): Promise<{ isSymbolicLink(): boolean }>;
}

const nodePathFs: WindowsPathFs = {
  readdir: (directory) => fsPromises.readdir(directory, { withFileTypes: true }),
  stat: (file) => fsPromises.stat(file),
  lstat: (file) => fsPromises.lstat(file),
};

export interface WindowsPathSearchOptions {
  fs?: WindowsPathFs;
  /** How long to wait on one PATH directory; see `WINDOWS_PATH_ENTRY_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/** The asynchronous form of `isWindowsLaunchFile`. */
export async function isWindowsLaunchFileAsync(
  file: string,
  fs: WindowsPathFs = nodePathFs
): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    try {
      return (await fs.lstat(file)).isSymbolicLink();
    } catch {
      return false;
    }
  }
}

/** A directory as Windows compares it: any case, either slash, no trailing separator. */
function windowsDirectoryKey(directory: string): string {
  const normalized = directory.replace(/\//g, "\\").toLowerCase();
  const trimmed = normalized.replace(/\\+$/, "");
  return /^[a-z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed;
}

/**
 * Paths are built the host's way, which is `path.win32` wherever this runs for
 * real; the POSIX branch is what lets tests search real temporary directories.
 * A directory PATH lists twice is searched once, where it first appears.
 */
function searchDirectories(env: NodeJS.ProcessEnv): {
  directories: Array<{ directory: string; key: string }>;
  join: (directory: string, file: string) => string;
} {
  const isWindows = process.platform === "win32";
  const isAbsolute = isWindows ? isWindowsAbsolutePath : path.posix.isAbsolute;
  const seen = new Set<string>();
  const directories: Array<{ directory: string; key: string }> = [];
  for (const directory of splitWindowsPath(windowsEnvValue(env, "PATH") ?? "")) {
    if (!isAbsolute(directory)) continue;
    const key = isWindows ? windowsDirectoryKey(directory) : directory;
    if (seen.has(key)) continue;
    seen.add(key);
    directories.push({ directory, key });
  }
  return { directories, join: isWindows ? path.win32.join : path.posix.join };
}

function isPathLike(name: string): boolean {
  return /[\\/:]/.test(name);
}

type Listing = Map<string, WindowsDirectoryEntry> | null;

interface PathFsState {
  /** Listings in flight, shared by every search that wants the same directory meanwhile. */
  listings: Map<string, Promise<Listing>>;
  /**
   * Directories with a call that outlived its deadline. Skipped until that
   * call returns (and for `STALLED_RETRY_MS` more when it fails), so a dead
   * share holds one of libuv's four threadpool threads rather than one per
   * search queued up behind it.
   */
  stalled: Set<string>;
  resolved: Map<string, string>;
  resolving: Map<string, Promise<string | null>>;
}

let pathFsStates = new WeakMap<WindowsPathFs, PathFsState>();
let reportedStalls = new Set<string>();
let generation = 0;

function stateFor(fs: WindowsPathFs): PathFsState {
  let state = pathFsStates.get(fs);
  if (!state) {
    state = { listings: new Map(), stalled: new Set(), resolved: new Map(), resolving: new Map() };
    pathFsStates.set(fs, state);
  }
  return state;
}

/** Each name in the directory, keyed case-insensitively; null when it cannot be read. */
function listDirectory(
  state: PathFsState,
  key: string,
  directory: string,
  fs: WindowsPathFs
): Promise<Listing> {
  const inFlight = state.listings.get(key);
  if (inFlight) return inFlight;
  const listing = (async (): Promise<Listing> => {
    try {
      const byName = new Map<string, WindowsDirectoryEntry>();
      for (const entry of await fs.readdir(directory)) {
        const name = entry.name.toLowerCase();
        if (!byName.has(name)) byName.set(name, entry);
      }
      return byName;
    } catch {
      return null;
    }
  })();
  state.listings.set(key, listing);
  void listing.then(() => {
    if (state.listings.get(key) === listing) state.listings.delete(key);
  });
  return listing;
}

/**
 * Write `directory` off until the call that outlived its deadline settles:
 * `answered` resolves true if it got an answer (the share was only slow), false
 * if it failed, which keeps the directory skipped a while longer.
 */
function markStalled(
  state: PathFsState,
  key: string,
  directory: string,
  answered: Promise<boolean>,
  timeoutMs: number
): void {
  if (state.stalled.has(key)) return;
  state.stalled.add(key);
  if (!reportedStalls.has(key)) {
    reportedStalls.add(key);
    console.warn(
      `[windowsExecutable] PATH entry "${directory}" did not answer within ${timeoutMs} ms; searching without it until it does`
    );
  }
  void answered.then((ok) => {
    if (ok) {
      state.stalled.delete(key);
      return;
    }
    const retry = setTimeout(() => state.stalled.delete(key), STALLED_RETRY_MS);
    retry.unref?.();
  });
}

const TIMED_OUT = Symbol("timed out");

interface Deadline {
  reached: Promise<typeof TIMED_OUT>;
  cancel(): void;
}

function startDeadline(timeoutMs: number): Deadline {
  let timer: NodeJS.Timeout | undefined;
  const reached = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    timer.unref?.();
  });
  return { reached, cancel: () => clearTimeout(timer) };
}

interface DirectoryResult {
  directory: string;
  found: string[];
  /** The directory did not answer in time and was treated as holding nothing. */
  skipped: boolean;
}

/** `files` (in priority order) that `directory` holds as launchable files. */
async function searchDirectory(
  directory: string,
  key: string,
  files: readonly string[],
  join: (directory: string, file: string) => string,
  fs: WindowsPathFs,
  deadline: Deadline,
  timeoutMs: number
): Promise<DirectoryResult> {
  const state = stateFor(fs);
  if (state.stalled.has(key)) return { directory, found: [], skipped: true };
  const listing = listDirectory(state, key, directory, fs);
  const entries = await Promise.race([listing, deadline.reached]);
  if (entries === TIMED_OUT) {
    const answered = listing.then((listed) => listed !== null);
    markStalled(state, key, directory, answered, timeoutMs);
    return { directory, found: [], skipped: true };
  }
  const found: string[] = [];
  if (!entries) return { directory, found, skipped: false };
  for (const file of files) {
    const entry = entries.get(file.toLowerCase());
    if (!entry || entry.isDirectory()) continue;
    // The listing's own name, so the result reads the way `where` would list it.
    const candidate = join(directory, entry.name);
    if (!entry.isFile()) {
      // A reparse point: a symlink (WinGet's Links), or a Store execution alias.
      const check = isWindowsLaunchFileAsync(candidate, fs);
      const launchable = await Promise.race([check, deadline.reached]);
      if (launchable === TIMED_OUT) {
        markStalled(
          state,
          key,
          directory,
          check.then(() => true),
          timeoutMs
        );
        return { directory, found, skipped: true };
      }
      if (!launchable) continue;
    }
    found.push(candidate);
  }
  return { directory, found, skipped: false };
}

export interface WindowsPathSearch {
  /** Matches in PATH order; within a directory, in the order the candidates were given. */
  paths: string[];
  /** PATH directories that did not answer in time and were treated as holding nothing. */
  skipped: string[];
}

/**
 * Searches every absolute PATH directory at once, each bounded by `timeoutMs`,
 * and reads the results back in PATH order. With `first`, it returns as soon as
 * the earliest directory holding a match is known.
 */
async function searchPath(
  files: readonly string[],
  env: NodeJS.ProcessEnv,
  options: WindowsPathSearchOptions,
  first: boolean
): Promise<WindowsPathSearch> {
  const fs = options.fs ?? nodePathFs;
  const timeoutMs = options.timeoutMs ?? WINDOWS_PATH_ENTRY_TIMEOUT_MS;
  const { directories, join } = searchDirectories(env);
  const deadline = startDeadline(timeoutMs);
  const searches = directories.map(({ directory, key }) =>
    searchDirectory(directory, key, files, join, fs, deadline, timeoutMs)
  );
  void Promise.all(searches).then(deadline.cancel, deadline.cancel);
  const paths: string[] = [];
  const skipped: string[] = [];
  for (const search of searches) {
    const result = await search;
    if (result.skipped) skipped.push(result.directory);
    paths.push(...result.found);
    if (first && paths.length > 0) return { paths: paths.slice(0, 1), skipped };
  }
  return { paths, skipped };
}

/** The file names a bare `name` can start as from a shell: PATHEXT order, `.com`/`.exe`/`.bat`/`.cmd` only. */
function launchCandidates(name: string, env: NodeJS.ProcessEnv): string[] | null {
  if (!name || isPathLike(name) || /[\0\r\n"*?<>|]/.test(name)) return null;
  // Lower-case extensions, as npm, Scoop and installers write them.
  return LAUNCHABLE_EXTENSIONS.has(path.win32.extname(name).toLowerCase())
    ? [name]
    : windowsLaunchExtensions(env).map((extension) => `${name}${extension.toLowerCase()}`);
}

/**
 * Every file a bare `name` could start as from PATH, in PATH order: each
 * directory's matches in PATHEXT order, limited to `.com`, `.exe`, `.bat` and
 * `.cmd` (npm and Scoop install agents as `.cmd` shims). A name that already
 * carries one of those extensions is looked up as given. Relative PATH entries
 * are skipped, so the working directory is never searched. A path, or a name
 * with characters no file name can hold, finds nothing. A directory that does
 * not answer within the timeout counts as holding nothing and is reported in
 * `skipped`.
 */
export async function scanWindowsPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  options: WindowsPathSearchOptions = {}
): Promise<WindowsPathSearch> {
  const files = launchCandidates(name, env);
  if (!files) return { paths: [], skipped: [] };
  return searchPath(files, env, options, false);
}

/** The file a shell would start for a bare `name` from PATH, or null when PATH has none. */
export async function findWindowsCommand(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  options: WindowsPathSearchOptions = {}
): Promise<string | null> {
  const files = launchCandidates(name, env);
  if (!files) return null;
  return (await searchPath(files, env, options, true)).paths[0] ?? null;
}

function resolvedKey(name: string, env: NodeJS.ProcessEnv): string {
  return `${generation}\0${name.toLowerCase()}\0${windowsEnvValue(env, "PATH") ?? ""}`;
}

/**
 * Whether a cached hit is still there: one stat, bounded like a PATH search and
 * skipped (so a fresh search follows) while its directory is written off.
 */
async function stillOnPath(
  file: string,
  options: WindowsPathSearchOptions,
  fs: WindowsPathFs
): Promise<boolean> {
  const isWindows = process.platform === "win32";
  const directory = (isWindows ? path.win32 : path.posix).dirname(file);
  const key = isWindows ? windowsDirectoryKey(directory) : directory;
  const state = stateFor(fs);
  if (state.stalled.has(key)) return false;
  const timeoutMs = options.timeoutMs ?? WINDOWS_PATH_ENTRY_TIMEOUT_MS;
  const deadline = startDeadline(timeoutMs);
  try {
    const check = isWindowsLaunchFileAsync(file, fs);
    const launchable = await Promise.race([check, deadline.reached]);
    if (launchable !== TIMED_OUT) return launchable;
    markStalled(
      state,
      key,
      directory,
      check.then(() => true),
      timeoutMs
    );
    return false;
  } finally {
    deadline.cancel();
  }
}

/**
 * Absolute path of the first `name` found in the PATH directories, or null when
 * none has it. Tried as libuv tries it: the name as given when it has an
 * extension, then with `.com`, then `.exe` appended (the files process creation
 * starts directly). Empty, `.` and other relative PATH entries are skipped, so
 * the working directory is never searched. A name that is already a path is
 * returned unchanged.
 *
 * Hits are cached per (name, PATH) and re-checked on every use, so a removed
 * file is searched for again; a miss is not cached. Concurrent lookups of one
 * name share a search. `invalidateWindowsExecutableCache` drops every hit when a
 * PATH refresh may have put a new candidate ahead of a cached one.
 */
export function resolveWindowsExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  options: WindowsPathSearchOptions = {}
): Promise<string | null> {
  if (!name || isPathLike(name)) return Promise.resolve(name || null);
  const fs = options.fs ?? nodePathFs;
  const state = stateFor(fs);
  const key = resolvedKey(name, env);
  const pending = state.resolving.get(key);
  if (pending) return pending;
  const resolution = (async (): Promise<string | null> => {
    const cached = state.resolved.get(key);
    if (cached !== undefined) {
      if (await stillOnPath(cached, options, fs)) return cached;
      if (state.resolved.get(key) === cached) state.resolved.delete(key);
    }
    const files = [
      ...(path.win32.extname(name) ? [name] : []),
      ...NATIVE_EXTENSIONS.map((extension) => `${name}${extension}`),
    ];
    const file = (await searchPath(files, env, options, true)).paths[0] ?? null;
    if (file !== null && key === resolvedKey(name, env)) {
      if (state.resolved.size >= RESOLVED_CACHE_LIMIT) state.resolved.clear();
      state.resolved.set(key, file);
    }
    return file;
  })();
  state.resolving.set(key, resolution);
  const settle = (): void => {
    if (state.resolving.get(key) === resolution) state.resolving.delete(key);
  };
  void resolution.then(settle, settle);
  return resolution;
}

/**
 * What an earlier asynchronous lookup found for `name` on the current PATH,
 * without touching the disk: the absolute path, or undefined when no lookup has
 * found it since PATH last changed or the cache was last invalidated.
 */
export function peekWindowsExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  if (!name || isPathLike(name)) return name || undefined;
  return stateFor(nodePathFs).resolved.get(resolvedKey(name, env));
}

/** On Windows, resolve `names` from PATH ahead of the first spawn that needs them. */
export async function prewarmWindowsExecutables(
  names: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (process.platform !== "win32") return;
  await Promise.all(names.map((name) => resolveWindowsExecutable(name, env).catch(() => null)));
}

/**
 * The error spawn reports for a program it cannot find, so a PATH miss reaches
 * callers in the shape they already handle (`code` and `syscall` are what the
 * missing-git classifier reads).
 */
export function windowsExecutableNotFound(name: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`spawn ${name} ENOENT`), {
    errno: -4058,
    code: "ENOENT",
    syscall: `spawn ${name}`,
    path: name,
  });
}

/**
 * `name` for spawn: its absolute PATH location on Windows, unchanged elsewhere.
 * On Windows a name PATH does not hold rejects with spawn's ENOENT instead of
 * being handed to spawn bare, which would search the working directory first.
 */
export async function resolveExecutableForSpawn(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Promise<string> {
  if (platform !== "win32") return name;
  const file = await resolveWindowsExecutable(name, env);
  if (file === null) throw windowsExecutableNotFound(name);
  return file;
}

/**
 * The synchronous form of `resolveExecutableForSpawn`, for a caller that cannot
 * wait. It never searches PATH itself: on Windows it returns what an earlier
 * asynchronous lookup (`prewarmWindowsExecutables`, `resolveExecutableForSpawn`)
 * found, and otherwise starts one and throws spawn's ENOENT. It never hands
 * spawn a bare name there.
 */
export function executableForSpawn(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform !== "win32") return name;
  const file = peekWindowsExecutable(name, env);
  if (file !== undefined) return file;
  void resolveWindowsExecutable(name, env).catch(() => null);
  throw windowsExecutableNotFound(name);
}

/** Bumped by every invalidation; lets a dependent cache tell its answer is stale. */
export function windowsExecutableCacheGeneration(): number {
  return generation;
}

/**
 * Forget every resolved path; the runtime PATH refresh calls this. Stalled
 * directories stay written off until their outstanding call returns.
 */
export function invalidateWindowsExecutableCache(): void {
  generation++;
  stateFor(nodePathFs).resolved.clear();
}

/** Test seam: forget every resolved path, stalled directory and logged stall. */
export function resetWindowsExecutableCache(): void {
  generation++;
  pathFsStates = new WeakMap();
  reportedStalls = new Set();
}
