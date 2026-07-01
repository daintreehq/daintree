import { execSync } from "child_process";
import { isAbsolute, join as pathJoin } from "path";
import { logWarn } from "./logger.js";
import { Cache } from "./cache.js";

// worktreePath → gitDir/commonDir is immutable for a live worktree and all
// removal/switch paths invalidate explicitly via clearGitDirCache /
// clearGitCommonDirCache, so successful resolutions never expire — a TTL
// would only force periodic blocking execSync re-resolution on hot poll
// paths. Cached error (null) entries keep the default TTL so transient
// failures self-heal.
const SUCCESS_TTL_MS = Number.POSITIVE_INFINITY;
const gitDirCache = new Cache<string, string | null>({ maxSize: 200, defaultTTL: 600_000 });
const gitCommonDirCache = new Cache<string, string | null>({ maxSize: 200, defaultTTL: 600_000 });

export interface GitDirOptions {
  cache?: boolean;
  timeout?: number;
  logErrors?: boolean;
  cacheErrors?: boolean;
}

export function getGitDir(worktreePath: string, options: GitDirOptions = {}): string | null {
  const { cache = true, timeout = 5000, logErrors = false, cacheErrors = true } = options;

  if (cache && gitDirCache.has(worktreePath)) {
    return gitDirCache.get(worktreePath)!;
  }

  try {
    const result = execSync("git rev-parse --git-dir", {
      cwd: worktreePath,
      encoding: "utf-8",
      timeout,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const resolved = isAbsolute(result) ? result : pathJoin(worktreePath, result);

    if (cache) {
      gitDirCache.set(worktreePath, resolved, SUCCESS_TTL_MS);
    }

    return resolved;
  } catch (error) {
    if (logErrors) {
      logWarn("Failed to resolve git directory", {
        path: worktreePath,
        error: (error as Error).message,
      });
    }

    if (cache && cacheErrors) {
      gitDirCache.set(worktreePath, null);
    }

    return null;
  }
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
export function getGitCommonDir(worktreePath: string, options: GitDirOptions = {}): string | null {
  const { cache = true, timeout = 5000, logErrors = false, cacheErrors = true } = options;

  if (cache && gitCommonDirCache.has(worktreePath)) {
    return gitCommonDirCache.get(worktreePath)!;
  }

  try {
    const result = execSync("git rev-parse --git-common-dir", {
      cwd: worktreePath,
      encoding: "utf-8",
      timeout,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const resolved = isAbsolute(result) ? result : pathJoin(worktreePath, result);

    if (cache) {
      gitCommonDirCache.set(worktreePath, resolved, SUCCESS_TTL_MS);
    }

    return resolved;
  } catch (error) {
    if (logErrors) {
      logWarn("Failed to resolve git common directory", {
        path: worktreePath,
        error: (error as Error).message,
      });
    }

    if (cache && cacheErrors) {
      gitCommonDirCache.set(worktreePath, null);
    }

    return null;
  }
}

/**
 * Resolve the currently checked-out branch name for a worktree. Returns `null`
 * for a detached HEAD (git emits the literal "HEAD") or on any failure. Not
 * cached: unlike the git dir, the branch is mutable over a worktree's life.
 * Used best-effort at terminal-close time to stamp a resume sanity-check onto
 * the journal record, so it runs with a short default timeout and never throws.
 */
export function getGitBranch(
  worktreePath: string,
  options: { timeout?: number } = {}
): string | null {
  const { timeout = 500 } = options;
  try {
    const result = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: worktreePath,
      encoding: "utf-8",
      timeout,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
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

export function getGitNotePath(
  worktreePath: string,
  filename: string = "daintree/note"
): string | null {
  const gitDir = getGitDir(worktreePath);
  return gitDir ? pathJoin(gitDir, filename) : null;
}
