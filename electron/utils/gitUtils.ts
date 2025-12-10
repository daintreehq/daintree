import { execSync } from "child_process";
import { join as pathJoin } from "path";
import { logWarn } from "./logger.js";

const gitDirCache = new Map<string, string | null>();

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

    const resolved = result.startsWith("/") ? result : pathJoin(worktreePath, result);

    if (cache) {
      gitDirCache.set(worktreePath, resolved);
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

export function clearGitDirCache(worktreePath?: string): void {
  if (worktreePath) {
    gitDirCache.delete(worktreePath);
  } else {
    gitDirCache.clear();
  }
}

export function getGitNotePath(
  worktreePath: string,
  filename: string = "canopy/note"
): string | null {
  const gitDir = getGitDir(worktreePath);
  return gitDir ? pathJoin(gitDir, filename) : null;
}
