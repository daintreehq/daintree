import { execFile } from "child_process";
import { promises as fsPromises } from "fs";
import { isAbsolute, join as pathJoin } from "path";
import { logWarn } from "./logger.js";
import { Cache } from "./cache.js";

// worktreePath → gitDir/commonDir is immutable for a live worktree and all
// removal/switch paths invalidate explicitly via clearGitDirCache /
// clearGitCommonDirCache, so successful resolutions never expire — a TTL
// would only force periodic git re-resolution on hot poll paths.
// The cache stores the resolution promise itself so concurrent callers for
// the same worktree share a single git spawn.
const SUCCESS_TTL_MS = Number.POSITIVE_INFINITY;
// A null result is NOT one thing. "This is definitively not a repository" is a
// stable answer worth caching for a long time — non-git folders are a supported
// workspace mode and re-probing them every poll would be pure waste. A spawn
// failure, a timeout, or a permission blip is the opposite: nothing about the
// worktree changed, we simply failed to look. Caching those for the same ten
// minutes is what darkens the git file watcher on Windows for #12042 —
// `GitFileWatcher.start()` bails on a null gitDir, so one transient failure
// leaves `WatcherController` in mode "none" (adaptive poll cadence, ~1.5s on
// the Performance profile) and `GitStatusPass` skips its stat pre-check, which
// is gated on a resolved gitDir. Every retry path then re-reads the same
// cached null. Transient failures therefore expire fast enough that the
// watcher's own 30s re-arm gets a genuine second attempt, without letting the
// poll loop re-spawn `git rev-parse` at its own cadence.
const DEFINITIVE_TTL_MS = 600_000;
const TRANSIENT_TTL_MS = 15_000;
const gitDirCache = new Cache<string, Promise<string | null>>({
  maxSize: 200,
  defaultTTL: DEFINITIVE_TTL_MS,
});
const gitCommonDirCache = new Cache<string, Promise<string | null>>({
  maxSize: 200,
  defaultTTL: DEFINITIVE_TTL_MS,
});

/** Exit code git uses for a fatal error, including "not a git repository". */
const GIT_FATAL_EXIT_CODE = 128;
// The one exit-128 fatal that is NOT a verdict about the path: git refuses to
// operate until `safe.directory` is configured, which the user can fix without
// the worktree ever changing. Matched on the stable English fragment git emits
// for it; a locale that translates the message just falls back to the
// definitive TTL, which is the pre-existing behaviour.
const DUBIOUS_OWNERSHIP_PATTERN = /dubious ownership/i;

type FailureKind = "definitive" | "transient";

type GitPathResolution = { path: string } | { path: null; failure: FailureKind };

/**
 * Decide whether a failed `git rev-parse` is a verdict about the worktree or a
 * failure to reach one. Deliberately keyed on the error's SHAPE rather than its
 * message: `execFile` reports a spawn failure as a string `code` (ENOENT when
 * git isn't on PATH, EPERM/EACCES/EBUSY when an AV scanner or a filesystem
 * holds the path) and a timeout as `killed`/`signal`, while a real git verdict
 * is a clean numeric exit. Message matching would be locale-dependent, so it is
 * used only to *downgrade* a fatal to transient, never to promote one.
 */
function classifyGitFailure(error: unknown, stderr: string): FailureKind {
  const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
  // Timed out (execFile's `timeout` kills the child) or killed by a signal.
  if (err?.killed === true || (err?.signal !== undefined && err.signal !== null)) {
    return "transient";
  }
  // Spawn-level failure: `code` is an errno string, not an exit status.
  if (typeof err?.code === "string") return "transient";
  // Any exit status other than git's fatal code isn't a "not a repository"
  // answer — usage errors and the like say nothing durable about the path.
  if (err?.code !== GIT_FATAL_EXIT_CODE) return "transient";
  if (DUBIOUS_OWNERSHIP_PATTERN.test(stderr)) return "transient";
  return "definitive";
}

export interface GitDirOptions {
  cache?: boolean;
  timeout?: number;
  logErrors?: boolean;
  cacheErrors?: boolean;
}

/**
 * Error carrying the stderr git printed alongside it, so callers can tell a
 * "not a git repository" verdict from a fatal that only looks like one.
 */
class GitExecError extends Error {
  constructor(
    readonly originalError: unknown,
    readonly stderr: string
  ) {
    super((originalError as Error)?.message ?? "git failed");
    this.name = "GitExecError";
  }
}

function execGit(args: string[], cwd: string, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // windowsHide keeps the probe from flashing a console window: libuv only
    // sets CREATE_NO_WINDOW when the flag is passed, and Windows 11's default
    // "let Windows decide" terminal host escalates an unhidden spawn into a
    // full Windows Terminal window (#12042).
    execFile(
      "git",
      args,
      { cwd, timeout, encoding: "utf-8", windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(new GitExecError(error, typeof stderr === "string" ? stderr : ""));
        } else {
          resolve(typeof stdout === "string" ? stdout : String(stdout));
        }
      }
    );
  });
}

/**
 * Resolve the git dir for `worktreePath` from the `.git` entry alone — a
 * directory (regular repo) or a `gitdir: <path>` pointer file (linked
 * worktree / submodule) — without a subprocess. Both shapes are sanity-checked
 * by requiring `HEAD` inside the resolved dir, mirroring git's own repository
 * discovery, so a stray/corrupt `.git` falls back to the subprocess (which
 * then fails exactly as before). Returns `null` for every shape this helper
 * can't prove (no `.git` entry, subdirectory of a repo, bare repo) — the
 * caller MUST fall back to `git rev-parse`, never treat null as "not a repo".
 */
async function resolveGitDirFromFs(worktreePath: string): Promise<string | null> {
  const dotGit = pathJoin(worktreePath, ".git");
  try {
    const stat = await fsPromises.stat(dotGit);
    if (stat.isDirectory()) {
      await fsPromises.access(pathJoin(dotGit, "HEAD"));
      return dotGit;
    }
    if (!stat.isFile()) return null;
    const content = (await fsPromises.readFile(dotGit, "utf-8")).trim();
    if (!content.startsWith("gitdir:")) return null;
    const target = content.slice("gitdir:".length).trim();
    if (!target) return null;
    const resolved = isAbsolute(target) ? target : pathJoin(worktreePath, target);
    await fsPromises.access(pathJoin(resolved, "HEAD"));
    return resolved;
  } catch {
    return null;
  }
}

/**
 * Common-dir variant: resolve the git dir from the filesystem, then follow
 * the `commondir` pointer (absent for the main worktree, where the git dir is
 * the common dir). Only trusts the unambiguous shapes; anything else returns
 * `null` so the caller falls back to `git rev-parse --git-common-dir`.
 */
async function resolveCommonDirFromFs(worktreePath: string): Promise<string | null> {
  const gitDir = await resolveGitDirFromFs(worktreePath);
  if (!gitDir) return null;
  try {
    const content = (await fsPromises.readFile(pathJoin(gitDir, "commondir"), "utf-8")).trim();
    if (!content) return gitDir;
    return isAbsolute(content) ? content : pathJoin(gitDir, content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return gitDir;
    return null;
  }
}

async function resolveGitPath(
  revParseFlag: string,
  worktreePath: string,
  timeout: number,
  logErrors: boolean,
  warnMessage: string
): Promise<GitPathResolution> {
  // Filesystem fast path: covers the regular-repo and linked-worktree shapes
  // without forking git. A null here is "can't prove it cheaply", not "not a
  // repo" — the subprocess below stays the source of truth for those.
  const fastResolver =
    revParseFlag === "--git-dir"
      ? resolveGitDirFromFs
      : revParseFlag === "--git-common-dir"
        ? resolveCommonDirFromFs
        : null;
  if (fastResolver) {
    const fast = await fastResolver(worktreePath);
    if (fast !== null) return { path: fast };
  }
  try {
    const result = (await execGit(["rev-parse", revParseFlag], worktreePath, timeout)).trim();
    return { path: isAbsolute(result) ? result : pathJoin(worktreePath, result) };
  } catch (error) {
    const execError = error instanceof GitExecError ? error : null;
    // Unwrap so the log keeps reporting git's own message, not the wrapper's.
    const rootCause = execError ? execError.originalError : error;
    if (logErrors) {
      logWarn(warnMessage, {
        path: worktreePath,
        error: (rootCause as Error | undefined)?.message ?? String(rootCause),
      });
    }
    return {
      path: null,
      failure: classifyGitFailure(rootCause, execError?.stderr ?? ""),
    };
  }
}

function cachedResolveGitPath(
  cacheStore: Cache<string, Promise<string | null>>,
  revParseFlag: string,
  warnMessage: string,
  worktreePath: string,
  options: GitDirOptions
): Promise<string | null> {
  const { cache = true, timeout = 5000, logErrors = false, cacheErrors = true } = options;

  if (cache) {
    const cached = cacheStore.get(worktreePath);
    if (cached !== undefined) {
      return cached;
    }
  }

  const resolution = resolveGitPath(revParseFlag, worktreePath, timeout, logErrors, warnMessage);
  const promise = resolution.then((resolved) => resolved.path);

  if (cache) {
    // Insert at the definitive TTL while in flight; on settlement re-stamp with
    // the TTL the outcome actually earns — permanent for a success, the short
    // window for a transient failure, unchanged for a definitive one — or drop
    // the entry when errors shouldn't be cached.
    cacheStore.set(worktreePath, promise);
    void resolution.then((resolved) => {
      if (cacheStore.get(worktreePath) !== promise) {
        return;
      }
      if (resolved.path !== null) {
        cacheStore.set(worktreePath, promise, SUCCESS_TTL_MS);
      } else if (!cacheErrors) {
        cacheStore.invalidate(worktreePath);
      } else if (resolved.failure === "transient") {
        cacheStore.set(worktreePath, promise, TRANSIENT_TTL_MS);
      }
    });
  }

  return promise;
}

export function getGitDir(
  worktreePath: string,
  options: GitDirOptions = {}
): Promise<string | null> {
  return cachedResolveGitPath(
    gitDirCache,
    "--git-dir",
    "Failed to resolve git directory",
    worktreePath,
    options
  );
}

/**
 * Resolve `--git-common-dir` for a worktree. Linked worktrees share the main
 * repo's `.git` directory; common-dir returns that shared path, while
 * `--git-dir` returns the per-worktree `.git/worktrees/<name>` location.
 *
 * The shared path is the correct serialization key for any operation that
 * touches `.git/objects` or `packed-refs` — most importantly background
 * fetches across sibling worktrees.
 */
export function getGitCommonDir(
  worktreePath: string,
  options: GitDirOptions = {}
): Promise<string | null> {
  return cachedResolveGitPath(
    gitCommonDirCache,
    "--git-common-dir",
    "Failed to resolve git common directory",
    worktreePath,
    options
  );
}

/**
 * Resolve the currently checked-out branch name for a worktree. Returns `null`
 * for a detached HEAD (git emits the literal "HEAD") or on any failure. Not
 * cached: unlike the git dir, the branch is mutable over a worktree's life.
 * Used best-effort at terminal-close time to stamp a resume sanity-check onto
 * the journal record, so it runs with a short default timeout and never throws.
 */
export async function getGitBranch(
  worktreePath: string,
  options: { timeout?: number } = {}
): Promise<string | null> {
  const { timeout = 500 } = options;
  try {
    const result = (
      await execGit(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath, timeout)
    ).trim();
    if (!result || result === "HEAD") return null;
    return result;
  } catch {
    return null;
  }
}

export function clearGitDirCache(worktreePath?: string): void {
  if (worktreePath) {
    gitDirCache.invalidate(worktreePath);
  } else {
    gitDirCache.clear();
  }
}

export function clearGitCommonDirCache(worktreePath?: string): void {
  if (worktreePath) {
    gitCommonDirCache.invalidate(worktreePath);
  } else {
    gitCommonDirCache.clear();
  }
}

export async function getGitNotePath(
  worktreePath: string,
  filename: string = "daintree/note"
): Promise<string | null> {
  const gitDir = await getGitDir(worktreePath);
  return gitDir ? pathJoin(gitDir, filename) : null;
}
