import { dirname, resolve } from "path";
import { realpathSync, promises as fs } from "fs";
import type { SimpleGit, StatusResult } from "simple-git";
import type { FileChangeDetail, GitStatus, WorktreeChanges } from "../types/index.js";
import { WorktreeRemovedError, toGitOperationError } from "./errorTypes.js";
import { logWarn, logError } from "./logger.js";
import { Cache } from "./cache.js";
import { createHardenedGit, createWslHardenedGit } from "./hardenedGit.js";
import type { WslGitInvocation } from "./hardenedGit.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";

const GIT_WORKTREE_CHANGES_CACHE = new Cache<string, WorktreeChanges>({
  maxSize: 100,
  defaultTTL: 15000, // 15s to cover 10s background polling + margin
});

const inFlightWorktreeChanges = new Map<string, Promise<WorktreeChanges>>();

export function invalidateWorktreeCache(cwd: string): void {
  GIT_WORKTREE_CHANGES_CACHE.invalidate(cwd);
}

export { invalidateWorktreeCache as invalidateGitStatusCache };

interface DiffStat {
  insertions: number | null;
  deletions: number | null;
}

// Per-file diff stat cache: skips redundant `git diff --numstat` work for files
// whose (HEAD OID, path, mtime, size) tuple is unchanged since last refresh.
// HEAD OID participates in the key, so commits/resets/checkouts self-invalidate.
const PER_FILE_DIFF_STAT_CACHE = new Cache<string, DiffStat>({
  maxSize: 2000,
  defaultTTL: 300_000,
});

function makeFileStatCacheKey(
  headOid: string,
  absolutePath: string,
  mtimeMs: number,
  size: number
): string {
  return `${headOid}:${absolutePath}:${mtimeMs}:${size}`;
}

// Test-only: clear the per-file diff stat cache between cases. Production code
// relies on (HEAD OID, mtime, size) self-invalidation and TTL eviction.
export function __clearPerFileDiffStatCacheForTesting(): void {
  PER_FILE_DIFF_STAT_CACHE.clear();
}

export type DiffStatMode = "staged" | "unstaged";

// Cache for staging-view diff stats keyed on `(cwd, headOid, mode)`. The
// dashboard's PER_FILE_DIFF_STAT_CACHE requires per-file (mtime, size) keys
// to participate; for the staging view we issue a single batched numstat per
// mode and the surrounding rate limit already gates refresh frequency, so a
// short TTL keyed on cwd is sufficient.
const STAGING_DIFF_STAT_CACHE = new Cache<string, Map<string, DiffStat>>({
  maxSize: 64,
  defaultTTL: 5_000,
});

function makeStagingCacheKey(cwd: string, headOid: string, mode: DiffStatMode): string {
  return `${cwd}:${headOid}:${mode}`;
}

export function __clearStagingDiffStatCacheForTesting(): void {
  STAGING_DIFF_STAT_CACHE.clear();
}

/**
 * Invalidate cached staging churn for a worktree. Called after explicit stage
 * or unstage operations so the next status refresh reflects the new index
 * state immediately, without waiting for the 5s TTL.
 */
export function invalidateStagingDiffStatCache(cwd: string): void {
  // Cache keys are `${cwd}:${headOid}:${mode}` — collect matches then drop
  // them. forEach skips expired entries, so this won't see those, which is
  // fine: they'd be re-fetched on the next read anyway.
  const toDrop: string[] = [];
  STAGING_DIFF_STAT_CACHE.forEach((_value, key) => {
    if (key.startsWith(`${cwd}:`)) toDrop.push(key);
  });
  for (const key of toDrop) {
    STAGING_DIFF_STAT_CACHE.invalidate(key);
  }
}

/**
 * Resolve per-file line stats for staging-view paths. Issues a single
 * `git diff --numstat` call per mode (staged vs unstaged), parses with the
 * shared `parseNumstat`, and caches the resulting map for ~5s keyed by cwd
 * and head OID. Empty `paths` returns an empty map without spawning git.
 *
 * Binary files surface as `{ insertions: null, deletions: null }`, matching
 * `parseNumstat`'s `-\t-` handling. Errors are swallowed and yield an empty
 * map — callers leave the entries' churn `null`.
 */
export async function getPerFileDiffStats(
  git: SimpleGit,
  cwd: string,
  headOid: string,
  paths: string[],
  mode: DiffStatMode
): Promise<Map<string, DiffStat>> {
  if (paths.length === 0) return new Map();
  if (mode === "staged" && !headOid) return new Map();

  const cacheKey = makeStagingCacheKey(cwd, headOid, mode);
  const cached = STAGING_DIFF_STAT_CACHE.get(cacheKey);
  if (cached) return cached;

  // For the unstaged side, compare working tree vs index (no HEAD ref) so
  // partially-staged files don't get their churn double-counted: lines that
  // are already staged should appear only in the staged row, not also under
  // unstaged. The staged side keeps `--cached` (index vs HEAD).
  const args =
    mode === "staged"
      ? ["--no-ext-diff", "--no-renames", "--numstat", "--cached", "--", ...paths]
      : ["--no-ext-diff", "--no-renames", "--numstat", "--", ...paths];

  try {
    const toplevel = (await git.revparse(["--show-toplevel"])).trim();
    if (!toplevel) return new Map();
    // Normalize to forward slashes on both sides so the absolute-to-relative
    // re-keying works on Windows, where `realpathSync` returns backslashes
    // but `status.files[].path` uses forward slashes.
    const gitRoot = realpathSync(toplevel).replace(/\\/g, "/");
    const diffOutput = await git.diff(args);
    const byAbsolutePath = parseNumstat(diffOutput, gitRoot);

    // Re-key by repo-relative path (matching status.files[].path). Callers
    // don't carry absolute paths through the staging handler.
    const byRelative = new Map<string, DiffStat>();
    const rootPrefix = gitRoot.endsWith("/") ? gitRoot : `${gitRoot}/`;
    for (const [absolutePath, stats] of byAbsolutePath) {
      const normalized = absolutePath.replace(/\\/g, "/");
      const relative = normalized.startsWith(rootPrefix)
        ? normalized.slice(rootPrefix.length)
        : normalized;
      byRelative.set(relative, stats);
    }

    STAGING_DIFF_STAT_CACHE.set(cacheKey, byRelative);
    return byRelative;
  } catch (error) {
    logWarn("Failed to read per-file diff stats; continuing without churn", {
      cwd,
      mode,
      message: (error as Error).message,
    });
    return new Map();
  }
}

function normalizeNumstatPath(rawPath: string): string {
  return rawPath.trim();
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
    const git = createHardenedGit(cwd);
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
    const git = createHardenedGit(cwd);

    const totalCountStr = await git.raw(["rev-list", "--count", branch || "HEAD"]);
    const total = parseInt(totalCountStr.trim(), 10);

    const logOptions: string[] = [
      "log",
      "--format=%H%x00%h%x00%s%x00%b%x00%an%x00%ae%x00%aI%x00END",
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
    const entries = output.split("\x00END").filter((entry) => entry.trim());

    for (const entry of entries.slice(0, limit)) {
      const parts = entry.trim().split("\x00");
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
    const git = createHardenedGit(worktreePath);
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

export interface GetWorktreeChangesOptions {
  forceRefresh?: boolean;
  cacheTTL?: number;
  /**
   * When set, route git through WSL using `createWslHardenedGit`. The caller
   * must provide the distro name and POSIX path (already translated from the
   * UNC). Set only on Windows for worktrees the user has opted into.
   */
  wsl?: WslGitInvocation;
}

function gitForChanges(cwd: string, opts: GetWorktreeChangesOptions): SimpleGit {
  if (opts.wsl) {
    try {
      return createWslHardenedGit(opts.wsl);
    } catch {
      // Fall back to native git if the WSL invocation is rejected (e.g. wrong
      // platform, missing distro). Polling continues using the slower path.
    }
  }
  return createHardenedGit(cwd);
}

export async function getWorktreeChangesWithStats(
  cwd: string,
  forceRefreshOrOptions: boolean | GetWorktreeChangesOptions = false
): Promise<WorktreeChanges> {
  // Support both legacy boolean and new options object
  // Guard against null/undefined being passed as second argument
  const options: GetWorktreeChangesOptions =
    typeof forceRefreshOrOptions === "boolean"
      ? { forceRefresh: forceRefreshOrOptions }
      : forceRefreshOrOptions && typeof forceRefreshOrOptions === "object"
        ? forceRefreshOrOptions
        : {};

  const { forceRefresh = false, cacheTTL } = options;
  if (!forceRefresh) {
    const cached = GIT_WORKTREE_CHANGES_CACHE.get(cwd);
    if (cached) {
      return {
        ...cached,
        changes: cached.changes.map((change) => ({ ...change })),
      };
    }

    const inFlight = inFlightWorktreeChanges.get(cwd);
    if (inFlight) {
      return inFlight;
    }
  }

  const fetchPromise = (async () => {
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
      const git: SimpleGit = gitForChanges(cwd, options);
      const status: StatusResult = await git.status();

      // Consolidate rev-parse into a single spawn; HEAD may not exist in empty
      // repos — fall back to a solo --show-toplevel call when it doesn't.
      const revParsePromise = git
        .raw(["rev-parse", "HEAD", "--show-toplevel"])
        .then((output) => {
          const lines = output.trim().split("\n");
          return { headOid: lines[0]?.trim() ?? "", toplevelRaw: lines[1]?.trim() ?? "" };
        })
        .catch(async () => {
          const toplevelRaw = await git.revparse(["--show-toplevel"]);
          return { headOid: "", toplevelRaw };
        });

      const [{ toplevelRaw, headOid }, logOutput] = await Promise.all([
        revParsePromise,
        git.raw(["log", "-1", "--format=%at%x09%an%x09%ae%x09%s"]).catch(() => ""),
      ]);

      const gitRoot = realpathSync(toplevelRaw.trim());

      let lastCommitMessage: string | undefined;
      let lastCommitTimestampMs: number | undefined;
      let lastCommitAuthor: { name: string; email: string } | undefined;
      if (logOutput) {
        const [tsLine, authorName, authorEmail, ...msgParts] = logOutput.split("\t");
        const parsed = Number.parseInt((tsLine ?? "").trim(), 10);
        lastCommitTimestampMs = Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : undefined;
        lastCommitMessage = msgParts.join("\t").trim() || undefined;
        if (authorName?.trim()) {
          lastCommitAuthor = {
            name: authorName.trim(),
            email: (authorEmail ?? "").trim() || "",
          };
        }
      }

      // Deduplicate: a partially-staged file appears in both `modified` and
      // `staged`, and double-counting wastes the 100-file budget reserved for
      // the per-file cache fast path.
      const trackedChangedFiles = [
        ...new Set([
          ...status.modified,
          ...status.created,
          ...status.deleted,
          ...status.renamed.map((r) => r.to),
          ...status.staged,
        ]),
      ];

      // Early stat pass: gather (mtimeMs, size) for each tracked file so we can
      // probe the per-file cache before shelling out to `git diff`. Stat failures
      // (e.g. deleted files) fall through to the cache-miss path, matching prior
      // behaviour.
      const useScopedDiff =
        trackedChangedFiles.length > 0 &&
        trackedChangedFiles.length <= MAX_FILES_FOR_NUMSTAT &&
        headOid !== "";

      const cacheMissPaths: string[] = [];
      const hitStats = new Map<string, DiffStat>();
      const fileMetaByRel = new Map<
        string,
        { absolutePath: string; mtimeMs: number; size: number }
      >();
      const absPathToMeta = new Map<string, { mtimeMs: number; size: number }>();

      if (useScopedDiff) {
        const statResults = await Promise.allSettled(
          trackedChangedFiles.map((rel) => fs.stat(resolve(gitRoot, rel)))
        );
        for (let i = 0; i < trackedChangedFiles.length; i++) {
          const rel = trackedChangedFiles[i];
          const result = statResults[i];
          if (result.status !== "fulfilled") {
            cacheMissPaths.push(rel);
            continue;
          }
          const absolutePath = resolve(gitRoot, rel);
          const mtimeMs = result.value.mtimeMs;
          const size = result.value.size;
          fileMetaByRel.set(rel, { absolutePath, mtimeMs, size });
          absPathToMeta.set(absolutePath, { mtimeMs, size });
          const cached = PER_FILE_DIFF_STAT_CACHE.get(
            makeFileStatCacheKey(headOid, absolutePath, mtimeMs, size)
          );
          if (cached) {
            hitStats.set(absolutePath, cached);
          } else {
            cacheMissPaths.push(rel);
          }
        }
      } else {
        for (const rel of trackedChangedFiles) cacheMissPaths.push(rel);
      }

      let diffOutput = "";
      let diffSucceeded = false;

      try {
        if (cacheMissPaths.length === 0) {
          diffOutput = "";
          diffSucceeded = true;
        } else if (trackedChangedFiles.length > MAX_FILES_FOR_NUMSTAT) {
          // Escape hatch: skip per-file caching and run an unscoped numstat over
          // the first 100 files to keep argv length bounded.
          const limitedFiles = trackedChangedFiles.slice(0, MAX_FILES_FOR_NUMSTAT);
          diffOutput = await git.diff([
            "--no-ext-diff",
            "--no-renames",
            "--numstat",
            "HEAD",
            "--",
            ...limitedFiles,
          ]);
          logWarn("Large changeset detected; limiting numstat to first 100 files", {
            cwd,
            totalFiles: trackedChangedFiles.length,
            limitedTo: MAX_FILES_FOR_NUMSTAT,
          });
        } else {
          diffOutput = await git.diff([
            "--no-ext-diff",
            "--no-renames",
            "--numstat",
            "HEAD",
            "--",
            ...cacheMissPaths,
          ]);
          diffSucceeded = true;
        }
      } catch (error) {
        logWarn("Failed to read numstat diff; continuing without line stats", {
          cwd,
          message: (error as Error).message,
        });
      }

      const diffStats = parseNumstat(diffOutput, gitRoot);

      // Populate per-file cache with newly-computed stats from cache-miss files
      // (only when the diff itself succeeded — never cache failure outcomes).
      if (useScopedDiff && diffSucceeded) {
        for (const rel of cacheMissPaths) {
          const meta = fileMetaByRel.get(rel);
          if (!meta) continue;
          const stats = diffStats.get(meta.absolutePath);
          if (!stats) continue;
          PER_FILE_DIFF_STAT_CACHE.set(
            makeFileStatCacheKey(headOid, meta.absolutePath, meta.mtimeMs, meta.size),
            stats
          );
        }
      }

      // Merge cache hits into diffStats so addChange picks them up uniformly.
      for (const [absolutePath, stats] of hitStats) {
        if (!diffStats.has(absolutePath)) {
          diffStats.set(absolutePath, stats);
        }
      }

      const changesMap = new Map<string, FileChangeDetail>();

      const countFileLines = async (filePath: string): Promise<number | null> => {
        try {
          const stats = await fs.stat(filePath);
          const MAX_FILE_SIZE = 10 * 1024 * 1024;
          if (stats.size > MAX_FILE_SIZE) {
            return null;
          }

          const cacheKey = headOid
            ? makeFileStatCacheKey(headOid, filePath, stats.mtimeMs, stats.size)
            : "";
          if (cacheKey) {
            const cached = PER_FILE_DIFF_STAT_CACHE.get(cacheKey);
            if (cached && cached.insertions !== null) {
              return cached.insertions;
            }
          }

          const buffer = await fs.readFile(filePath);

          const sampleSize = Math.min(buffer.length, 8192);
          if (buffer.subarray(0, sampleSize).indexOf(0) !== -1) {
            return null;
          }

          const content = buffer.toString("utf-8");

          let lineCount = 0;
          if (content.length > 0) {
            for (let i = 0; i < content.length; i++) {
              if (content[i] === "\n") {
                lineCount++;
              }
            }
            if (content[content.length - 1] !== "\n") {
              lineCount++;
            }
          }

          if (cacheKey) {
            PER_FILE_DIFF_STAT_CACHE.set(cacheKey, { insertions: lineCount, deletions: 0 });
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

      for (const file of status.staged) {
        await addChange(file, "modified");
      }

      if (status.conflicted) {
        for (const file of status.conflicted) {
          await addChange(file, "conflicted");
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
          const earlyMeta = absPathToMeta.get(change.path);
          if (earlyMeta !== undefined) {
            change.mtimeMs = earlyMeta.mtimeMs;
            return earlyMeta.mtimeMs;
          }
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

      const tracking = status.tracking && status.tracking.length > 0 ? status.tracking : null;
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
        lastCommitAuthor,
        ahead: tracking ? status.ahead : undefined,
        behind: tracking ? status.behind : undefined,
        tracking,
      };

      GIT_WORKTREE_CHANGES_CACHE.set(cwd, result, cacheTTL);
      return result;
    } catch (error) {
      if (error instanceof WorktreeRemovedError) {
        throw error;
      }

      const errorMessage = formatErrorMessage(error, "Git worktree changes failed");
      if (
        errorMessage.includes("ENOENT") ||
        errorMessage.includes("no such file or directory") ||
        errorMessage.includes("Unable to read current working directory") ||
        errorMessage.includes("not a git repository")
      ) {
        throw new WorktreeRemovedError(cwd, error instanceof Error ? error : undefined);
      }

      const gitError = toGitOperationError(error, { cwd, op: "status" });
      logError("Git worktree changes operation failed", gitError, { cwd });
      throw gitError;
    }
  })();

  if (!forceRefresh) {
    inFlightWorktreeChanges.set(cwd, fetchPromise);
  }

  try {
    return await fetchPromise;
  } finally {
    if (inFlightWorktreeChanges.get(cwd) === fetchPromise) {
      inFlightWorktreeChanges.delete(cwd);
    }
  }
}
