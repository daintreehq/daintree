import { dirname, resolve } from "path";
import { realpathSync, promises as fs } from "fs";
import { simpleGit, SimpleGit, StatusResult } from "simple-git";
import type { FileChangeDetail, GitStatus, WorktreeChanges } from "../types/index.js";
import { GitError, WorktreeRemovedError } from "./errorTypes.js";
import { logWarn, logError } from "./logger.js";
import { Cache } from "./cache.js";

const GIT_WORKTREE_CHANGES_CACHE = new Cache<string, WorktreeChanges>({
  maxSize: 100,
  defaultTTL: 15000, // 15s to cover 10s background polling + margin
});

export function invalidateWorktreeCache(cwd: string): void {
  GIT_WORKTREE_CHANGES_CACHE.invalidate(cwd);
}

export { invalidateWorktreeCache as invalidateGitStatusCache };

interface DiffStat {
  insertions: number | null;
  deletions: number | null;
}

const NUMSTAT_PATH_SPLITTERS = ["=>", "->"];

function normalizeNumstatPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  for (const splitter of NUMSTAT_PATH_SPLITTERS) {
    const idx = trimmed.lastIndexOf(splitter);
    if (idx !== -1) {
      return trimmed
        .slice(idx + splitter.length)
        .replace(/[{}]/g, "")
        .trim();
    }
  }
  return trimmed.replace(/[{}]/g, "");
}

function parseNumstat(diffOutput: string, gitRoot: string): Map<string, DiffStat> {
  const stats = new Map<string, DiffStat>();
  const lines = diffOutput.split("\n");

  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;

    const [insertionsRaw, deletionsRaw, ...pathParts] = parts;
    const rawPath = pathParts.join("\t");
    const normalizedPath = normalizeNumstatPath(rawPath);
    const absolutePath = resolve(gitRoot, normalizedPath);

    const insertions = insertionsRaw === "-" ? null : Number.parseInt(insertionsRaw, 10);
    const deletions = deletionsRaw === "-" ? null : Number.parseInt(deletionsRaw, 10);

    stats.set(absolutePath, {
      insertions: Number.isNaN(insertions) ? null : insertions,
      deletions: Number.isNaN(deletions) ? null : deletions,
    });
  }

  return stats;
}

export async function getCommitCount(cwd: string): Promise<number> {
  try {
    const git = simpleGit(cwd);
    const count = await git.raw(["rev-list", "--count", "HEAD"]);
    return parseInt(count.trim(), 10);
  } catch (error) {
    logWarn("Failed to get commit count", { cwd, error: (error as Error).message });
    return 0;
  }
}

export interface CommitInfo {
  hash: string;
  shortHash: string;
  message: string;
  body?: string;
  author: { name: string; email: string };
  date: string;
}

export interface ListCommitsOptions {
  cwd: string;
  search?: string;
  branch?: string;
  skip?: number;
  limit?: number;
}

export interface ListCommitsResult {
  items: CommitInfo[];
  hasMore: boolean;
  total: number;
}

export async function listCommits(options: ListCommitsOptions): Promise<ListCommitsResult> {
  const { cwd, search, branch, skip = 0, limit = 30 } = options;

  try {
    const git = simpleGit(cwd);

    const totalCountStr = await git.raw(["rev-list", "--count", branch || "HEAD"]);
    const total = parseInt(totalCountStr.trim(), 10);

    const logOptions: string[] = [
      "log",
      "--format=%H|%h|%s|%b|%an|%ae|%aI|END",
      `--skip=${skip}`,
      `-n`,
      `${limit + 1}`,
    ];

    if (search) {
      logOptions.push(`--grep=${search}`, "-i");
    }

    if (branch) {
      logOptions.push(branch);
    }

    const output = await git.raw(logOptions);

    const commits: CommitInfo[] = [];
    const entries = output.split("|END").filter((entry) => entry.trim());

    for (const entry of entries.slice(0, limit)) {
      const parts = entry.trim().split("|");
      if (parts.length >= 7) {
        const [hash, shortHash, message, body, authorName, authorEmail, date] = parts;
        commits.push({
          hash,
          shortHash,
          message,
          body: body?.trim() || undefined,
          author: { name: authorName, email: authorEmail },
          date,
        });
      }
    }

    return {
      items: commits,
      hasMore: entries.length > limit,
      total,
    };
  } catch (error) {
    logWarn("Failed to list commits", { cwd, error: (error as Error).message });
    return { items: [], hasMore: false, total: 0 };
  }
}

export async function getLatestTrackedFileMtime(worktreePath: string): Promise<number | null> {
  try {
    const git = simpleGit(worktreePath);
    const unixSeconds = await git.raw(["log", "-1", "--format=%ct"]);
    const parsed = Number.parseInt(unixSeconds.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : null;
  } catch (error) {
    logWarn("Failed to get latest commit timestamp", {
      worktreePath,
      error: (error as Error).message,
    });
    return null;
  }
}

export async function getWorktreeChangesWithStats(
  cwd: string,
  forceRefresh = false
): Promise<WorktreeChanges> {
  if (!forceRefresh) {
    const cached = GIT_WORKTREE_CHANGES_CACHE.get(cwd);
    if (cached) {
      return {
        ...cached,
        changes: cached.changes.map((change) => ({ ...change })),
      };
    }
  }

  const MAX_FILES_FOR_NUMSTAT = 100;
  try {
    await fs.access(cwd);
  } catch (accessError) {
    const nodeError = accessError as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      throw new WorktreeRemovedError(cwd, nodeError);
    }
    throw accessError;
  }

  try {
    const git: SimpleGit = simpleGit(cwd);
    const status: StatusResult = await git.status();
    const gitRoot = realpathSync((await git.revparse(["--show-toplevel"])).trim());

    let lastCommitMessage: string | undefined;
    let lastCommitTimestampMs: number | undefined;
    try {
      const output = await git.raw(["log", "-1", "--format=%ct%n%s"]);
      const [tsLine, ...msgLines] = output.split("\n");
      const parsed = Number.parseInt((tsLine ?? "").trim(), 10);
      lastCommitTimestampMs = Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : undefined;
      lastCommitMessage = msgLines.join("\n").trim() || undefined;
    } catch {
      // Silently ignore - this is a non-critical field
    }

    const trackedChangedFiles = [
      ...status.modified,
      ...status.created,
      ...status.deleted,
      ...status.renamed.map((r) => r.to),
    ];

    let diffOutput = "";

    try {
      if (trackedChangedFiles.length === 0) {
        diffOutput = "";
      } else if (trackedChangedFiles.length <= MAX_FILES_FOR_NUMSTAT) {
        diffOutput = await git.diff(["--numstat", "HEAD"]);
      } else {
        const limitedFiles = trackedChangedFiles.slice(0, MAX_FILES_FOR_NUMSTAT);
        diffOutput = await git.diff(["--numstat", "HEAD", "--", ...limitedFiles]);
        logWarn("Large changeset detected; limiting numstat to first 100 files", {
          cwd,
          totalFiles: trackedChangedFiles.length,
          limitedTo: MAX_FILES_FOR_NUMSTAT,
        });
      }
    } catch (error) {
      logWarn("Failed to read numstat diff; continuing without line stats", {
        cwd,
        message: (error as Error).message,
      });
    }

    const diffStats = parseNumstat(diffOutput, gitRoot);
    const changesMap = new Map<string, FileChangeDetail>();

    const countFileLines = async (filePath: string): Promise<number | null> => {
      try {
        const stats = await fs.stat(filePath);
        const MAX_FILE_SIZE = 10 * 1024 * 1024;
        if (stats.size > MAX_FILE_SIZE) {
          return null;
        }

        const buffer = await fs.readFile(filePath);

        const sampleSize = Math.min(buffer.length, 8192);
        for (let i = 0; i < sampleSize; i++) {
          if (buffer[i] === 0) {
            return null;
          }
        }

        const content = buffer.toString("utf-8");

        if (content.length === 0) {
          return 0;
        }

        let lineCount = 0;
        for (let i = 0; i < content.length; i++) {
          if (content[i] === "\n") {
            lineCount++;
          }
        }

        if (content[content.length - 1] !== "\n") {
          lineCount++;
        }

        return lineCount;
      } catch (_error) {
        return null;
      }
    };

    const addChange = async (pathFragment: string, statusValue: GitStatus) => {
      const absolutePath = resolve(gitRoot, pathFragment);
      const existing = changesMap.get(absolutePath);
      if (existing) {
        return;
      }

      const statsForFile = diffStats.get(absolutePath);
      let insertions: number | null;
      let deletions: number | null;

      if (statusValue === "untracked" && !statsForFile) {
        insertions = await countFileLines(absolutePath);
        deletions = null;
      } else {
        insertions = statsForFile?.insertions ?? (statusValue === "untracked" ? null : 0);
        deletions = statsForFile?.deletions ?? (statusValue === "untracked" ? null : 0);
      }

      changesMap.set(absolutePath, {
        path: absolutePath,
        status: statusValue,
        insertions,
        deletions,
      });
    };

    for (const file of status.modified) {
      await addChange(file, "modified");
    }

    for (const file of status.renamed) {
      if (typeof file !== "string" && file.to) {
        await addChange(file.to, "renamed");
      }
    }

    for (const file of status.created) {
      await addChange(file, "added");
    }

    for (const file of status.deleted) {
      await addChange(file, "deleted");
    }

    if (status.conflicted) {
      for (const file of status.conflicted) {
        await addChange(file, "modified");
      }
    }

    const untrackedFiles = status.not_added;
    const MAX_UNTRACKED_FILES = 200;
    const concurrencyLimit = 10;

    const limitedUntrackedFiles =
      untrackedFiles.length > MAX_UNTRACKED_FILES
        ? untrackedFiles.slice(0, MAX_UNTRACKED_FILES)
        : untrackedFiles;

    if (untrackedFiles.length > MAX_UNTRACKED_FILES) {
      logWarn("Large number of untracked files; limiting to first 200", {
        cwd,
        totalUntracked: untrackedFiles.length,
        limitedTo: MAX_UNTRACKED_FILES,
      });
    }

    for (let i = 0; i < limitedUntrackedFiles.length; i += concurrencyLimit) {
      const batch = limitedUntrackedFiles.slice(i, i + concurrencyLimit);
      await Promise.all(batch.map((file) => addChange(file, "untracked")));
    }

    for (const [absolutePath, stats] of diffStats.entries()) {
      if (changesMap.has(absolutePath)) continue;
      changesMap.set(absolutePath, {
        path: absolutePath,
        status: "modified",
        insertions: stats.insertions ?? 0,
        deletions: stats.deletions ?? 0,
      });
    }

    const mtimes = await Promise.all(
      Array.from(changesMap.values()).map(async (change) => {
        const targetPath = change.status === "deleted" ? dirname(change.path) : change.path;

        try {
          const stat = await fs.stat(targetPath);
          change.mtimeMs = stat.mtimeMs;
          return stat.mtimeMs;
        } catch {
          change.mtimeMs = 0;
          return 0;
        }
      })
    );

    const changes = Array.from(changesMap.values());
    const totalInsertions = changes.reduce((sum, change) => sum + (change.insertions ?? 0), 0);
    const totalDeletions = changes.reduce((sum, change) => sum + (change.deletions ?? 0), 0);
    const latestFileMtime = mtimes.length > 0 ? Math.max(...mtimes) : 0;

    const result: WorktreeChanges = {
      worktreeId: realpathSync(cwd),
      rootPath: gitRoot,
      changes,
      changedFileCount: changes.length,
      totalInsertions,
      totalDeletions,
      insertions: totalInsertions,
      deletions: totalDeletions,
      latestFileMtime,
      lastUpdated: Date.now(),
      lastCommitMessage,
      lastCommitTimestampMs,
    };

    GIT_WORKTREE_CHANGES_CACHE.set(cwd, result);
    return result;
  } catch (error) {
    if (error instanceof WorktreeRemovedError) {
      throw error;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    if (
      errorMessage.includes("ENOENT") ||
      errorMessage.includes("no such file or directory") ||
      errorMessage.includes("Unable to read current working directory")
    ) {
      throw new WorktreeRemovedError(cwd, error instanceof Error ? error : undefined);
    }

    const cause = error instanceof Error ? error : new Error(String(error));
    const gitError = new GitError("Failed to get git worktree changes", { cwd }, cause);
    logError("Git worktree changes operation failed", gitError, { cwd });
    throw gitError;
  }
}
