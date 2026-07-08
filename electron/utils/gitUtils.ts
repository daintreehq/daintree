import { execFile } from "child_process";
import { promises as fsPromises } from "fs";
import { isAbsolute, join as pathJoin } from "path";
import { logWarn } from "./logger.js";
import { Cache } from "./cache.js";

// worktreePath → gitDir/commonDir is immutable for a live worktree and all
// removal/switch paths invalidate explicitly via clearGitDirCache /
// clearGitCommonDirCache, so successful resolutions never expire — a TTL
// would only force periodic git re-resolution on hot poll paths. Cached
// error (null) entries keep the default TTL so transient failures self-heal.
// The cache stores the resolution promise itself so concurrent callers for
// the same worktree share a single git spawn.
const SUCCESS_TTL_MS = Number.POSITIVE_INFINITY;
const gitDirCache = new Cache<string, Promise<string | null>>({
  maxSize: 200,
  defaultTTL: 600_000,
});
const gitCommonDirCache = new Cache<string, Promise<string | null>>({
  maxSize: 200,
  defaultTTL: 600_000,
});

export interface GitDirOptions {
  cache?: boolean;
  timeout?: number;
  logErrors?: boolean;
  cacheErrors?: boolean;
}

function execGit(args: string[], cwd: string, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout, encoding: "utf-8" }, (error, stdout) => {
      if (error) {
        reject(error);
      } else {
        resolve(typeof stdout === "string" ? stdout : String(stdout));
      }
    });
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
): Promise<string | null> {
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
    if (fast !== null) return fast;
  }
  try {
    const result = (await execGit(["rev-parse", revParseFlag], worktreePath, timeout)).trim();
    return isAbsolute(result) ? result : pathJoin(worktreePath, result);
  } catch (error) {
    if (logErrors) {
      logWarn(warnMessage, {
        path: worktreePath,
        error: (error as Error).message,
      });
    }
    return null;
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

  const promise = resolveGitPath(revParseFlag, worktreePath, timeout, logErrors, warnMessage);

  if (cache) {
    // Insert at the error TTL while in flight; upgrade to the permanent TTL
    // on success, or drop the entry when errors shouldn't be cached.
    cacheStore.set(worktreePath, promise);
    void promise.then((resolved) => {
      if (cacheStore.get(worktreePath) !== promise) {
        return;
      }
      if (resolved !== null) {
        cacheStore.set(worktreePath, promise, SUCCESS_TTL_MS);
      } else if (!cacheErrors) {
        cacheStore.invalidate(worktreePath);
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
