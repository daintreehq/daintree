import { promises as fsPromises } from "node:fs";
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
//
// Each of those calls also holds one of libuv's four threadpool threads, which
// every other fs call, DNS lookup and zlib job in the process shares. So a
// process keeps at most `PATH_FS_SLOTS` PATH-lookup calls outstanding, a slot
// is given back only when its call returns (a dead share keeps its thread
// whether or not anyone is still waiting), and finished listings are reused
// for a few seconds rather than read again by every lookup.

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
 * How long one PATH-lookup call may run before its directory is treated as
 * holding nothing. Local directories answer in milliseconds; this is for a
 * share that has gone away, whose listing would otherwise wait out the SMB
 * timeout.
 */
export const WINDOWS_PATH_ENTRY_TIMEOUT_MS = 1_500;
// A directory whose call failed after being written off is left alone this
// long, so every search does not pay the timeout again for a dead share.
const STALLED_RETRY_MS = 30_000;
// PATH-lookup calls one process keeps outstanding. While every one of them has
// outlived its deadline (two dead shares), one more is let through so the
// healthy entries can still be read; a third dead share then waits too.
const PATH_FS_SLOTS = 2;
// How long a search waits in all, queueing included, before treating the
// directories it has not heard from as holding nothing.
const SEARCH_DEADLINE_FACTOR = 2;
// How long a finished directory listing answers for the directory. Startup
// looks up every agent, git, the shell and the probes within moments of each
// other; a registry PATH refresh drops every listing at once.
const LISTING_TTL_MS = 3_000;

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
  /** How long one PATH-lookup call may run; see `WINDOWS_PATH_ENTRY_TIMEOUT_MS`. */
  timeoutMs?: number;
  /**
   * Read PATH with Windows rules whatever the host. For callers that only ever
   * search on Windows; elsewhere the host's rules apply, which is what lets
   * tests search real temporary directories.
   */
  win32Paths?: boolean;
}

/**
 * Whether `file` is something process creation can start: a file, or a
 * reparse point such as a Windows Store execution alias, which stat reports as
 * EACCES while CreateProcess still launches it by its resolved name.
 */
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

interface PathRules {
  isAbsolute: (directory: string) => boolean;
  key: (directory: string) => string;
  join: (directory: string, file: string) => string;
  dirname: (file: string) => string;
}

const WIN32_RULES: PathRules = {
  isAbsolute: isWindowsAbsolutePath,
  key: windowsDirectoryKey,
  join: path.win32.join,
  dirname: path.win32.dirname,
};

const POSIX_RULES: PathRules = {
  isAbsolute: path.posix.isAbsolute,
  key: (directory) => directory,
  join: path.posix.join,
  dirname: path.posix.dirname,
};

/**
 * Paths are built the host's way, which is `path.win32` wherever this runs for
 * real; the POSIX branch is what lets tests search real temporary directories.
 */
function pathRules(options: WindowsPathSearchOptions): PathRules {
  return options.win32Paths || process.platform === "win32" ? WIN32_RULES : POSIX_RULES;
}

/** PATH's absolute directories; one PATH lists twice is searched once, where it first appears. */
function searchDirectories(
  env: NodeJS.ProcessEnv,
  rules: PathRules
): Array<{ directory: string; key: string }> {
  const seen = new Set<string>();
  const directories: Array<{ directory: string; key: string }> = [];
  for (const directory of splitWindowsPath(windowsEnvValue(env, "PATH") ?? "")) {
    if (!rules.isAbsolute(directory)) continue;
    const key = rules.key(directory);
    if (seen.has(key)) continue;
    seen.add(key);
    directories.push({ directory, key });
  }
  return directories;
}

function isPathLike(name: string): boolean {
  return /[\\/:]/.test(name);
}

const TIMED_OUT = Symbol("timed out");
/** A call that found its directory written off when its turn came, and so touched nothing. */
const NOT_READ = Symbol("not read");
/** A directory that can be traversed but not listed (no FILE_LIST_DIRECTORY right). */
const UNLISTABLE = Symbol("unlistable");

/** Each name in the directory, keyed case-insensitively; UNLISTABLE, or null when it cannot be read. */
type Listing = Map<string, WindowsDirectoryEntry> | typeof UNLISTABLE | null;

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

interface Signal {
  next(): Promise<void>;
  notify(): void;
}

function createSignal(): Signal {
  let fire: () => void = () => {};
  const arm = (): Promise<void> =>
    new Promise<void>((resolve) => {
      fire = resolve;
    });
  let pending = arm();
  return {
    next: () => pending,
    notify: () => {
      const fired = fire;
      pending = arm();
      fired();
    },
  };
}

/** One PATH-lookup call, queued or running. */
interface LimitedCall<T> {
  /** What the call returned, whenever that is. */
  result: Promise<T>;
  /**
   * Resolves once waiting on the call is pointless: it outlived its deadline,
   * or it is still queued while every lane is held by calls that did.
   */
  givenUp: Promise<typeof TIMED_OUT>;
}

interface CallSpec {
  /** 1 for a directory that has stalled before, read after every other. */
  priority: 0 | 1;
  timeoutMs: number;
  /** Run even after every waiter gave up (a listing still fills the cache). */
  keep: boolean;
  onOverdue(): void;
  onSettled(overdue: boolean): void;
}

interface QueuedCall {
  spec: CallSpec;
  start(): void;
  giveUp(): void;
  givenUp: boolean;
}

/**
 * At most `PATH_FS_SLOTS` calls outstanding, plus one while every outstanding
 * call has outlived its deadline. A slot is freed when its call returns, not
 * when a waiter stops waiting, because the thread is held until then.
 */
class PathFsLimiter {
  private running = 0;
  private overdue = 0;
  private readonly queues: [QueuedCall[], QueuedCall[]] = [[], []];

  constructor(private readonly changed: Signal) {}

  private canStart(): boolean {
    if (this.running < PATH_FS_SLOTS) return true;
    return this.running === this.overdue && this.running < PATH_FS_SLOTS + 1;
  }

  /** No lane can open until a call that outlived its deadline returns. */
  jammed(): boolean {
    return !this.canStart() && this.running === this.overdue;
  }

  submit<T>(spec: CallSpec, call: () => Promise<T>): LimitedCall<T> {
    let deliver!: (value: T) => void;
    let fail!: (error: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      deliver = resolve;
      fail = reject;
    });
    // Waiters race this against `givenUp`; one that stopped waiting must not
    // leave a late failure unhandled.
    result.catch(() => undefined);
    let giveUp!: () => void;
    const givenUp = new Promise<typeof TIMED_OUT>((resolve) => {
      giveUp = () => resolve(TIMED_OUT);
    });
    const queued: QueuedCall = {
      spec,
      givenUp: false,
      giveUp: () => {
        queued.givenUp = true;
        giveUp();
      },
      start: () => {
        this.running++;
        let overdue = false;
        const timer = setTimeout(() => {
          overdue = true;
          this.overdue++;
          giveUp();
          spec.onOverdue();
          this.pump();
        }, spec.timeoutMs);
        timer.unref?.();
        const settle = (finish: () => void): void => {
          clearTimeout(timer);
          this.running--;
          if (overdue) this.overdue--;
          spec.onSettled(overdue);
          finish();
          this.pump();
          this.changed.notify();
        };
        let running: Promise<T>;
        try {
          running = call();
        } catch (error) {
          running = Promise.reject(error);
        }
        running.then(
          (value) => settle(() => deliver(value)),
          (error: unknown) => settle(() => fail(error))
        );
      },
    };
    this.queues[spec.priority].push(queued);
    this.pump();
    return { result, givenUp };
  }

  private pump(): void {
    while (this.canStart()) {
      const next = this.queues[0].shift() ?? this.queues[1].shift();
      if (!next) return;
      // Nobody is waiting and nothing would be kept: a probe of a file, not a listing.
      if (next.givenUp && !next.spec.keep) continue;
      next.start();
    }
    if (this.jammed()) {
      for (const queue of this.queues) for (const waiting of queue) waiting.giveUp();
    }
  }
}

interface StalledDirectory {
  /** Calls to the directory that outlived their deadline and have not returned. */
  outstanding: number;
  /** Whether one of them came back with an answer, so the share is only slow. */
  answered: boolean;
  retry?: NodeJS.Timeout;
}

interface CachedListing {
  listing: Listing;
  at: number;
  generation: number;
}

interface ResolvedHit {
  file: string;
  /** Directories the search that found it went past without an answer. */
  skipped: string[];
  skippedKeys: string[];
}

interface PathFsState {
  limiter: PathFsLimiter;
  changed: Signal;
  /** Listings queued or in flight, shared by every search that wants the same directory meanwhile. */
  listings: Map<string, LimitedCall<Listing | typeof NOT_READ>>;
  /** Finished listings, answering for their directory for `LISTING_TTL_MS`. */
  listed: Map<string, CachedListing>;
  /**
   * Directories with a call that outlived its deadline. Skipped until that
   * call returns (and for `STALLED_RETRY_MS` more when it fails), so a dead
   * share holds one threadpool thread rather than one per search queued up
   * behind it.
   */
  stalled: Map<string, StalledDirectory>;
  /** Directories that have stalled and not answered promptly since: read last. */
  suspect: Set<string>;
  resolved: Map<string, ResolvedHit>;
  resolving: Map<string, Promise<WindowsExecutableLookup>>;
}

let pathFsStates = new WeakMap<WindowsPathFs, PathFsState>();
let reportedStalls = new Set<string>();
let generation = 0;

function stateFor(fs: WindowsPathFs): PathFsState {
  let state = pathFsStates.get(fs);
  if (!state) {
    const changed = createSignal();
    state = {
      limiter: new PathFsLimiter(changed),
      changed,
      listings: new Map(),
      listed: new Map(),
      stalled: new Map(),
      suspect: new Set(),
      resolved: new Map(),
      resolving: new Map(),
    };
    pathFsStates.set(fs, state);
  }
  return state;
}

/** Write `directory` off until the call that outlived its deadline returns. */
function markStalled(state: PathFsState, key: string, directory: string, timeoutMs: number): void {
  state.suspect.add(key);
  const stalled = state.stalled.get(key);
  if (stalled) {
    stalled.outstanding++;
    if (stalled.retry) clearTimeout(stalled.retry);
    stalled.retry = undefined;
    return;
  }
  state.stalled.set(key, { outstanding: 1, answered: false });
  if (!reportedStalls.has(key)) {
    reportedStalls.add(key);
    console.warn(
      `[windowsExecutable] PATH entry "${directory}" did not answer within ${timeoutMs} ms; searching without it until it does`
    );
  }
}

/**
 * One of the directory's overdue calls returned. Once none is left, the
 * directory is searched again at once if one of them got an answer (the share
 * was only slow), or after `STALLED_RETRY_MS` if they all failed.
 */
function releaseStalled(state: PathFsState, key: string, answered: boolean): void {
  const stalled = state.stalled.get(key);
  if (!stalled) return;
  stalled.outstanding = Math.max(0, stalled.outstanding - 1);
  stalled.answered ||= answered;
  if (stalled.outstanding > 0) return;
  const clear = (): void => {
    if (state.stalled.get(key) !== stalled) return;
    state.stalled.delete(key);
    state.changed.notify();
  };
  if (stalled.answered) {
    clear();
    return;
  }
  stalled.retry = setTimeout(clear, STALLED_RETRY_MS);
  stalled.retry.unref?.();
}

function isFresh(cached: CachedListing): boolean {
  const age = Date.now() - cached.at;
  return cached.generation === generation && age >= 0 && age < LISTING_TTL_MS;
}

function settledCall<T>(value: T): LimitedCall<T> {
  return { result: Promise.resolve(value), givenUp: new Promise<typeof TIMED_OUT>(() => {}) };
}

function isListingDenied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EACCES" || code === "EPERM";
}

function readListing(
  state: PathFsState,
  key: string,
  directory: string,
  fs: WindowsPathFs,
  timeoutMs: number
): LimitedCall<Listing | typeof NOT_READ> {
  const cached = state.listed.get(key);
  if (cached && isFresh(cached)) return settledCall(cached.listing);
  const inFlight = state.listings.get(key);
  if (inFlight) return inFlight;
  const readFor = generation;
  let listing: Listing | typeof NOT_READ = NOT_READ;
  const call = state.limiter.submit(
    {
      priority: state.suspect.has(key) ? 1 : 0,
      timeoutMs,
      keep: true,
      onOverdue: () => markStalled(state, key, directory, timeoutMs),
      onSettled: (overdue) => {
        if (state.listings.get(key) === call) state.listings.delete(key);
        if (listing === NOT_READ) return;
        if (readFor === generation) {
          state.listed.set(key, { listing, at: Date.now(), generation: readFor });
        }
        if (overdue) releaseStalled(state, key, listing !== null);
        else state.suspect.delete(key);
      },
    },
    async () => {
      if (state.stalled.has(key)) return NOT_READ;
      try {
        const byName = new Map<string, WindowsDirectoryEntry>();
        for (const entry of await fs.readdir(directory)) {
          const name = entry.name.toLowerCase();
          if (!byName.has(name)) byName.set(name, entry);
        }
        listing = byName;
      } catch (error) {
        listing = isListingDenied(error) ? UNLISTABLE : null;
      }
      return listing;
    }
  );
  state.listings.set(key, call);
  return call;
}

/** Whether `file` (in `directory`) is launchable, as one PATH-lookup call. */
function checkLaunchFile(
  state: PathFsState,
  key: string,
  directory: string,
  file: string,
  fs: WindowsPathFs,
  timeoutMs: number
): LimitedCall<boolean | typeof NOT_READ> {
  return state.limiter.submit(
    {
      priority: state.suspect.has(key) ? 1 : 0,
      timeoutMs,
      keep: false,
      onOverdue: () => markStalled(state, key, directory, timeoutMs),
      onSettled: (overdue) => {
        if (overdue) releaseStalled(state, key, true);
        else state.suspect.delete(key);
      },
    },
    async () => (state.stalled.has(key) ? NOT_READ : isWindowsLaunchFileAsync(file, fs))
  );
}

function waitFor<T>(call: LimitedCall<T>, deadline: Deadline): Promise<T | typeof TIMED_OUT> {
  return Promise.race([call.result, call.givenUp, deadline.reached]);
}

interface SearchContext {
  state: PathFsState;
  fs: WindowsPathFs;
  rules: PathRules;
  timeoutMs: number;
  deadline: Deadline;
  first: boolean;
}

interface DirectoryResult {
  directory: string;
  found: string[];
  /** The directory did not answer in time and was treated as holding nothing. */
  skipped: boolean;
}

/** `files` (in priority order) that `directory` holds as launchable files. */
async function searchDirectory(
  context: SearchContext,
  directory: string,
  key: string,
  files: readonly string[]
): Promise<DirectoryResult> {
  const { state, fs, rules, timeoutMs, deadline } = context;
  const found: string[] = [];
  const skipped = (): DirectoryResult => ({ directory, found, skipped: true });
  if (state.stalled.has(key)) return skipped();
  const listing = await waitFor(readListing(state, key, directory, fs, timeoutMs), deadline);
  if (listing === TIMED_OUT || listing === NOT_READ) return skipped();
  if (listing === null) return { directory, found, skipped: false };
  if (listing === UNLISTABLE) {
    // Traversal without listing: ask for each candidate by name instead.
    for (const file of files) {
      const candidate = rules.join(directory, file);
      const check = checkLaunchFile(state, key, directory, candidate, fs, timeoutMs);
      const launchable = await waitFor(check, deadline);
      if (launchable === TIMED_OUT || launchable === NOT_READ) return skipped();
      if (!launchable) continue;
      found.push(candidate);
      if (context.first) break;
    }
    return { directory, found, skipped: false };
  }
  for (const file of files) {
    const entry = listing.get(file.toLowerCase());
    if (!entry || entry.isDirectory()) continue;
    // The listing's own name, so the result reads the way `where` would list it.
    const candidate = rules.join(directory, entry.name);
    if (!entry.isFile()) {
      // A reparse point: a symlink (WinGet's Links), or a Store execution alias.
      const check = checkLaunchFile(state, key, directory, candidate, fs, timeoutMs);
      const launchable = await waitFor(check, deadline);
      if (launchable === TIMED_OUT || launchable === NOT_READ) return skipped();
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
 * Searches the absolute PATH directories through the shared slots, highest
 * priority and earliest in PATH first, each call bounded by `timeoutMs` and the
 * whole search by twice that, and reads the results back in PATH order. With
 * `first`, it returns as soon as the earliest directory holding a match is known.
 */
async function searchPath(
  files: readonly string[],
  env: NodeJS.ProcessEnv,
  options: WindowsPathSearchOptions,
  first: boolean
): Promise<WindowsPathSearch> {
  const fs = options.fs ?? nodePathFs;
  const timeoutMs = options.timeoutMs ?? WINDOWS_PATH_ENTRY_TIMEOUT_MS;
  const rules = pathRules(options);
  const directories = searchDirectories(env, rules);
  const deadline = startDeadline(timeoutMs * SEARCH_DEADLINE_FACTOR);
  const state = stateFor(fs);
  const context: SearchContext = { state, fs, rules, timeoutMs, deadline, first };
  // Submitted healthy-first, so a directory that stalled before does not take
  // a free slot ahead of the rest; read back in PATH order all the same.
  const searches: Array<Promise<DirectoryResult>> = new Array(directories.length);
  const submitOrder = directories
    .map((entry, index) => ({ ...entry, index, suspect: state.suspect.has(entry.key) }))
    .sort((a, b) => Number(a.suspect) - Number(b.suspect) || a.index - b.index);
  for (const { directory, key, index } of submitOrder) {
    searches[index] = searchDirectory(context, directory, key, files);
  }
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

/**
 * The first of `files` (exact file names, tried in order within each
 * directory) found in the absolute PATH directories, or null. For callers that
 * build their own candidate list; it is not cached.
 */
export async function findWindowsPathFile(
  files: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  options: WindowsPathSearchOptions = {}
): Promise<string | null> {
  const names = files.filter((file) => file && !isPathLike(file) && !/[\0\r\n"*?<>|]/.test(file));
  if (names.length === 0) return null;
  return (await searchPath(names, env, options, true)).paths[0] ?? null;
}

function resolvedKey(name: string, env: NodeJS.ProcessEnv, rules: PathRules): string {
  const flavour = rules === WIN32_RULES ? "w" : "p";
  return `${generation}\0${flavour}\0${name.toLowerCase()}\0${windowsEnvValue(env, "PATH") ?? ""}`;
}

/**
 * Whether a cached hit is still there: one stat, bounded like a PATH search and
 * skipped (so a fresh search follows) while its directory is written off. A
 * stat that finds the file gone also drops the directory's listing, which
 * evidently no longer describes it.
 */
async function stillOnPath(
  file: string,
  options: WindowsPathSearchOptions,
  fs: WindowsPathFs
): Promise<boolean> {
  const rules = pathRules(options);
  const directory = rules.dirname(file);
  const key = rules.key(directory);
  const state = stateFor(fs);
  if (state.stalled.has(key)) return false;
  const timeoutMs = options.timeoutMs ?? WINDOWS_PATH_ENTRY_TIMEOUT_MS;
  const deadline = startDeadline(timeoutMs * SEARCH_DEADLINE_FACTOR);
  try {
    const check = checkLaunchFile(state, key, directory, file, fs, timeoutMs);
    const launchable = await waitFor(check, deadline);
    if (launchable === true) return true;
    if (launchable === false) state.listed.delete(key);
    return false;
  } finally {
    deadline.cancel();
  }
}

export interface WindowsExecutableLookup {
  file: string | null;
  /**
   * PATH directories the search went past without an answer. A non-empty list
   * makes the answer provisional: one of them may hold an earlier candidate.
   */
  skipped: string[];
}

/**
 * `resolveWindowsExecutable`, also reporting the PATH directories the search
 * had to go past without an answer.
 */
export function lookupWindowsExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  options: WindowsPathSearchOptions = {}
): Promise<WindowsExecutableLookup> {
  if (!name || isPathLike(name)) return Promise.resolve({ file: name || null, skipped: [] });
  const fs = options.fs ?? nodePathFs;
  const state = stateFor(fs);
  const rules = pathRules(options);
  const key = resolvedKey(name, env, rules);
  const pending = state.resolving.get(key);
  if (pending) return pending;
  const resolution = (async (): Promise<WindowsExecutableLookup> => {
    const cached = state.resolved.get(key);
    if (cached !== undefined) {
      // A directory it went past is answering again: it may hold an earlier candidate.
      const reachable = cached.skippedKeys.some((skipped) => !state.stalled.has(skipped));
      if (!reachable && (await stillOnPath(cached.file, options, fs))) {
        return { file: cached.file, skipped: cached.skipped };
      }
      if (state.resolved.get(key) === cached) state.resolved.delete(key);
    }
    const files = [
      ...(path.win32.extname(name) ? [name] : []),
      ...NATIVE_EXTENSIONS.map((extension) => `${name}${extension}`),
    ];
    const search = await searchPath(files, env, options, true);
    const file = search.paths[0] ?? null;
    if (file !== null && key === resolvedKey(name, env, rules)) {
      if (state.resolved.size >= RESOLVED_CACHE_LIMIT) state.resolved.clear();
      state.resolved.set(key, {
        file,
        skipped: search.skipped,
        skippedKeys: search.skipped.map(rules.key),
      });
    }
    return { file, skipped: search.skipped };
  })();
  state.resolving.set(key, resolution);
  const settle = (): void => {
    if (state.resolving.get(key) === resolution) state.resolving.delete(key);
  };
  void resolution.then(settle, settle);
  return resolution;
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
 * file is searched for again; a miss is not cached, though the directory
 * listings a search reads answer for a few seconds. Concurrent lookups of one
 * name share a search. `invalidateWindowsExecutableCache` drops every hit and
 * listing when a PATH refresh may have put a new candidate ahead of a cached one.
 */
export async function resolveWindowsExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  options: WindowsPathSearchOptions = {}
): Promise<string | null> {
  return (await lookupWindowsExecutable(name, env, options)).file;
}

/**
 * Resolves once one of `directories` (PATH entries a search reported as
 * skipped) can be read again: its overdue call has returned, or the retry
 * window after a failed one has passed, and a lookup slot can open. Never
 * rejects; it waits as long as that takes.
 */
export async function windowsPathEntriesReadable(
  directories: readonly string[],
  options: WindowsPathSearchOptions = {}
): Promise<void> {
  if (directories.length === 0) return;
  const state = stateFor(options.fs ?? nodePathFs);
  const keys = directories.map(pathRules(options).key);
  while (state.limiter.jammed() || keys.every((key) => state.stalled.has(key))) {
    await state.changed.next();
  }
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
  return stateFor(nodePathFs).resolved.get(resolvedKey(name, env, pathRules({})))?.file;
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
 * Forget every resolved path and directory listing; the runtime PATH refresh
 * calls this. Stalled directories stay written off until their outstanding
 * call returns, and calls already running keep their slots.
 */
export function invalidateWindowsExecutableCache(): void {
  generation++;
  const state = stateFor(nodePathFs);
  state.resolved.clear();
  state.listed.clear();
}

/** Test seam: forget every resolved path, listing, stalled directory, slot and logged stall. */
export function resetWindowsExecutableCache(): void {
  generation++;
  pathFsStates = new WeakMap();
  reportedStalls = new Set();
}
