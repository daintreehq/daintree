import { dirname, isAbsolute, resolve } from "path";
import { promises as fs, type Stats } from "fs";
import type { SimpleGit, StatusResult } from "simple-git";
import type { FileChangeDetail, GitStatus, WorktreeChanges } from "../types/index.js";
import { WorktreeRemovedError, toGitOperationError } from "./errorTypes.js";
import { logWarn, logError } from "./logger.js";
import { Cache } from "./cache.js";
import { createHardenedGit, createWslHardenedGit } from "./hardenedGit.js";
import type { WslGitInvocation } from "./hardenedGit.js";
import { getGitDir } from "./gitUtils.js";
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

export interface DiffStat {
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

// Untracked-file line counts are a pure function of file content, so the key
// deliberately excludes HEAD OID — commits must not thrash these entries. The
// prefix keeps them disjoint from tracked-diff keys in the shared cache.
function makeUntrackedLineCountCacheKey(
  absolutePath: string,
  mtimeMs: number,
  size: number
): string {
  return `untracked:${absolutePath}:${mtimeMs}:${size}`;
}

// Test-only: clear the per-file diff stat cache between cases. Production code
// relies on (HEAD OID, mtime, size) self-invalidation and TTL eviction.
export function __clearPerFileDiffStatCacheForTesting(): void {
  PER_FILE_DIFF_STAT_CACHE.clear();
}

// Cache last-commit metadata keyed on HEAD OID. The log output is a pure
// function of the commit object, so the OID is sufficient for invalidation —
// commits, amends, resets, and checkouts all change the OID. Per-worktree
// bound (maxSize matches GIT_WORKTREE_CHANGES_CACHE) keeps memory stable
// across long sessions with many worktrees.
const LAST_COMMIT_LOG_CACHE = new Cache<string, string>({
  maxSize: 100,
  defaultTTL: 300_000,
});

export function __clearLastCommitLogCacheForTesting(): void {
  LAST_COMMIT_LOG_CACHE.clear();
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
    // re-keying works on Windows, where `realpath` returns backslashes
    // but `status.files[].path` uses forward slashes.
    const gitRoot = (await fs.realpath(toplevel)).replace(/\\/g, "/");
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

export function parseNumstat(diffOutput: string, gitRoot: string): Map<string, DiffStat> {
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
    const git = await createHardenedGit(cwd);
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

const COMMIT_LOG_FORMAT = "--format=%H%x00%h%x00%s%x00%b%x00%an%x00%ae%x00%aI%x00END";

// Matches a 4–40 char hex string (git's minimum abbreviated SHA is 4 chars).
// Used to decide whether a search query might be a commit-hash prefix.
const COMMIT_HASH_PREFIX_RE = /^[0-9a-f]{4,40}$/i;

function parseCommitOutput(output: string): CommitInfo[] {
  const commits: CommitInfo[] = [];
  const entries = output.split("\x00END").filter((entry) => entry.trim());

  for (const entry of entries) {
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

  return commits;
}

export async function listCommits(options: ListCommitsOptions): Promise<ListCommitsResult> {
  const { cwd, search, branch, skip = 0, limit = 30 } = options;

  try {
    const git = await createHardenedGit(cwd);

    const totalCountStr = await git.raw(["rev-list", "--count", branch || "HEAD"]);
    const total = parseInt(totalCountStr.trim(), 10);

    // `--grep` only matches commit-message text, so a hash-prefix query returns
    // nothing. On the first page, additionally resolve hash-like queries directly
    // and pin the match to the top of the results. Gated to skip === 0 so the
    // pinned commit doesn't re-appear on every paginated page.
    let hashCommit: CommitInfo | null = null;
    if (search && skip === 0 && COMMIT_HASH_PREFIX_RE.test(search)) {
      try {
        const fullHash = (await git.raw(["rev-parse", "--verify", `${search}^{commit}`])).trim();
        if (fullHash) {
          const hashOutput = await git.raw(["log", COMMIT_LOG_FORMAT, "-1", fullHash]);
          hashCommit = parseCommitOutput(hashOutput)[0] ?? null;
        }
      } catch {
        // rev-parse/log failed (not found, ambiguous, or < 4 unique chars) —
        // fall through to the message-grep pass below.
        hashCommit = null;
      }
    }

    const logOptions: string[] = ["log", COMMIT_LOG_FORMAT, `--skip=${skip}`, `-n`, `${limit + 1}`];

    if (search) {
      logOptions.push(`--grep=${search}`, "-i");
    }

    if (branch) {
      logOptions.push(branch);
    }

    const output = await git.raw(logOptions);
    const msgCommits = parseCommitOutput(output);

    // The hash match is purely additive: it's pinned ahead of a full page of
    // message results rather than displacing one, so pagination stays aligned to
    // the message stream and `hasMore` reflects the (deduplicated) message count.
    const dedupedMsg = hashCommit
      ? msgCommits.filter((c) => c.hash !== hashCommit!.hash)
      : msgCommits;
    const pageMsg = dedupedMsg.slice(0, limit);
    const items = hashCommit ? [hashCommit, ...pageMsg] : pageMsg;
    const hasMore = dedupedMsg.length > limit;

    return {
      items,
      hasMore,
      total,
    };
  } catch (error) {
    logWarn("Failed to list commits", { cwd, error: (error as Error).message });
    return { items: [], hasMore: false, total: 0 };
  }
}

export async function getLatestTrackedFileMtime(worktreePath: string): Promise<number | null> {
  try {
    const git = await createHardenedGit(worktreePath);
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

// Static per-worktree facts consumed by every status pass: the realpath'd
// `--show-toplevel` and `realpath(cwd)`. Entries are validated against the
// (dev, ino) captured at resolution time, so a worktree deleted and
// recreated at the same path self-invalidates without any explicit hook.
// Inode identity is a proxy, not proof — a symlink ancestor retargeted at a
// bind-mount of the same inode would keep a stale realpath — but no product
// worktree flow produces that shape. Eliminates the per-pass
// `rev-parse HEAD --show-toplevel` subprocess (the OID comes from
// resolveHeadOidFromFs below); any ambiguity falls back to the subprocess.
interface WorktreeStaticInfo {
  gitRoot: string;
  realCwd: string;
  dev: number;
  ino: number;
}

const WORKTREE_STATIC_CACHE = new Cache<string, WorktreeStaticInfo>({
  maxSize: 100,
  defaultTTL: Number.POSITIVE_INFINITY,
});

// The `commondir` pointer inside a linked worktree's git dir is immutable for
// the life of that git dir, and its absence (main worktree) is stable too.
const COMMON_DIR_CACHE = new Cache<string, string>({
  maxSize: 100,
  defaultTTL: Number.POSITIVE_INFINITY,
});

// Parsed packed-refs keyed by (path, mtimeMs, size) — reparsed only when the
// file actually changes. Small maxSize: one live entry per repo.
const PACKED_REFS_CACHE = new Cache<string, Map<string, string>>({
  maxSize: 8,
  defaultTTL: 300_000,
});

export function __clearWorktreeStaticCacheForTesting(): void {
  WORKTREE_STATIC_CACHE.clear();
  COMMON_DIR_CACHE.clear();
  PACKED_REFS_CACHE.clear();
}

// SHA-1 or SHA-256 object id.
const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// Characters git forbids anywhere in a refname (check-ref-format), plus the
// "@{" sequence. Segment rules handled separately below.
// eslint-disable-next-line no-control-regex
const REF_FORBIDDEN_RE = /[\x00-\x20~^:?*[\\\x7f]|@\{/;

/**
 * Conservative `git check-ref-format` subset. A refname that fails here is
 * never resolved as a filesystem path — the caller falls back to the
 * subprocess, which applies git's exact rules. Prevents a malformed HEAD
 * (e.g. `ref: refs/heads/../../ORIG_HEAD`) from escaping the refs tree and
 * returning an OID rev-parse would have rejected.
 */
function isSafeRefName(refName: string): boolean {
  if (REF_FORBIDDEN_RE.test(refName)) return false;
  if (refName.endsWith(".") || refName.includes("..")) return false;
  for (const segment of refName.split("/")) {
    if (!segment || segment.startsWith(".") || segment.endsWith(".lock")) return false;
  }
  return true;
}

async function resolveCommonDirForGitDir(gitDir: string): Promise<string> {
  const cached = COMMON_DIR_CACHE.get(gitDir);
  if (cached !== undefined) return cached;
  try {
    const content = (await fs.readFile(resolve(gitDir, "commondir"), "utf-8")).trim();
    const result = content ? (isAbsolute(content) ? content : resolve(gitDir, content)) : gitDir;
    COMMON_DIR_CACHE.set(gitDir, result);
    return result;
  } catch (error) {
    // ENOENT is the stable "main worktree" shape and safe to cache; any other
    // error is treated as transient and retried on the next pass.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      COMMON_DIR_CACHE.set(gitDir, gitDir);
    }
    return gitDir;
  }
}

async function resolvePackedRef(commonDir: string, refName: string): Promise<string | null> {
  const packedPath = resolve(commonDir, "packed-refs");
  let stat: Stats;
  try {
    stat = await fs.stat(packedPath);
  } catch {
    return null;
  }
  // ino participates because git replaces packed-refs via rename: a rewrite
  // within the same mtime granularity window (coarse-timestamp filesystems)
  // with an identical size would otherwise serve the stale map.
  const cacheKey = `${packedPath}:${stat.ino}:${stat.mtimeMs}:${stat.size}`;
  let refs = PACKED_REFS_CACHE.get(cacheKey);
  if (!refs) {
    try {
      const content = await fs.readFile(packedPath, "utf-8");
      refs = new Map();
      for (const line of content.split("\n")) {
        // Skip the header and peeled-tag (^<oid>) lines.
        if (!line || line.startsWith("#") || line.startsWith("^")) continue;
        const spaceIdx = line.indexOf(" ");
        if (spaceIdx <= 0) continue;
        const oid = line.slice(0, spaceIdx);
        if (!OID_RE.test(oid)) continue;
        const packedRefName = line.slice(spaceIdx + 1).trim();
        // Only refs/heads/* are ever queried; dropping tags/remotes keeps the
        // cached map small on repos with tens of thousands of refs.
        if (!packedRefName.startsWith("refs/heads/")) continue;
        refs.set(packedRefName, oid);
      }
      PACKED_REFS_CACHE.set(cacheKey, refs);
    } catch {
      return null;
    }
  }
  return refs.get(refName) ?? null;
}

/**
 * Resolve the current HEAD commit OID from `.git` metadata files — the same
 * resolution `git rev-parse HEAD` performs for the common shapes — without a
 * subprocess. Returns `null` whenever the answer is not unambiguous
 * (missing/malformed HEAD, a ref outside `refs/heads/`, an unborn branch,
 * packed-refs anomalies); callers must then fall back to the subprocess,
 * which preserves exact git semantics.
 */
async function resolveHeadOidFromFs(cwd: string): Promise<string | null> {
  const gitDir = await getGitDir(cwd, { cache: true, logErrors: false });
  if (!gitDir) return null;
  let head: string;
  try {
    head = (await fs.readFile(resolve(gitDir, "HEAD"), "utf-8")).trim();
  } catch {
    return null;
  }
  if (OID_RE.test(head)) return head; // detached HEAD carries the OID directly
  if (!head.startsWith("ref:")) return null;
  const refName = head.slice(4).trim();
  // Only refs/heads/* are shared through the common dir; anything else
  // (refs/bisect, per-worktree refs) keeps the subprocess path. Malformed
  // refnames are rejected rather than resolved as paths.
  if (!refName.startsWith("refs/heads/") || !isSafeRefName(refName)) return null;
  const commonDir = await resolveCommonDirForGitDir(gitDir);
  try {
    const loose = (await fs.readFile(resolve(commonDir, refName), "utf-8")).trim();
    return OID_RE.test(loose) ? loose : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
  }
  return resolvePackedRef(commonDir, refName);
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

async function gitForChanges(cwd: string, opts: GetWorktreeChangesOptions): Promise<SimpleGit> {
  if (opts.wsl) {
    try {
      // `await` so a rejected factory promise lands in this catch and falls
      // back, matching the previous synchronous-throw behaviour.
      return await createWslHardenedGit(opts.wsl);
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
    // stat instead of access: the (dev, ino) pair doubles as the validity
    // check for the static-info cache below. Error mapping is unchanged.
    let cwdStat: Stats;
    try {
      cwdStat = await fs.stat(cwd);
    } catch (accessError) {
      const nodeError = accessError as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        throw new WorktreeRemovedError(cwd, nodeError);
      }
      throw accessError;
    }

    try {
      const git: SimpleGit = await gitForChanges(cwd, options);

      // Fast path: with the static facts (toplevel, realpath) cached for this
      // exact directory inode AND an unambiguous fs-resolved HEAD OID, the
      // `rev-parse HEAD --show-toplevel` subprocess is redundant. Resolved
      // AFTER the status spawn so the OID is sampled at the same point in the
      // pass as the subprocess it replaces — keeping the (unavoidable,
      // pre-existing) mid-pass HEAD-move race window identical to before.
      const staticEntry = WORKTREE_STATIC_CACHE.get(cwd);
      const staticInfo =
        staticEntry && staticEntry.dev === cwdStat.dev && staticEntry.ino === cwdStat.ino
          ? staticEntry
          : undefined;

      const status: StatusResult = await git.status();
      const fsOid = staticInfo ? await resolveHeadOidFromFs(cwd) : null;

      let headOid: string;
      let gitRoot: string;
      let realCwd: string;
      if (staticInfo && fsOid !== null) {
        headOid = fsOid;
        gitRoot = staticInfo.gitRoot;
        realCwd = staticInfo.realCwd;
      } else {
        // Consolidate rev-parse into a single spawn; HEAD may not exist in
        // empty repos — fall back to a solo --show-toplevel call when it
        // doesn't.
        const revParsed = await git
          .raw(["rev-parse", "HEAD", "--show-toplevel"])
          .then((output) => {
            const lines = output.trim().split("\n");
            return { headOid: lines[0]?.trim() ?? "", toplevelRaw: lines[1]?.trim() ?? "" };
          })
          .catch(async () => {
            const toplevelRaw = await git.revparse(["--show-toplevel"]);
            return { headOid: "", toplevelRaw };
          });
        headOid = revParsed.headOid;
        gitRoot = await fs.realpath(revParsed.toplevelRaw.trim());
        realCwd = await fs.realpath(cwd);
        WORKTREE_STATIC_CACHE.set(cwd, {
          gitRoot,
          realCwd,
          dev: cwdStat.dev,
          ino: cwdStat.ino,
        });
      }

      // The log output is a pure function of the HEAD OID, so the cache
      // self-invalidates on every commit, amend, reset, or checkout. On cache
      // miss we spawn the log and store the result; empty-repo paths yield
      // headOid="" and are not cached (always spawn).
      const cachedLog = headOid ? LAST_COMMIT_LOG_CACHE.get(headOid) : undefined;
      const logOutput =
        cachedLog !== undefined
          ? cachedLog
          : await git.raw(["log", "-1", "--format=%at%x09%an%x09%ae%x09%s"]).catch(() => "");
      if (headOid && cachedLog === undefined) {
        LAST_COMMIT_LOG_CACHE.set(headOid, logOutput);
      }

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

          const cacheKey = makeUntrackedLineCountCacheKey(filePath, stats.mtimeMs, stats.size);
          const cached = PER_FILE_DIFF_STAT_CACHE.get(cacheKey);
          if (cached && cached.insertions !== null) {
            return cached.insertions;
          }

          const buffer = await fs.readFile(filePath);

          const sampleSize = Math.min(buffer.length, 8192);
          if (buffer.subarray(0, sampleSize).indexOf(0) !== -1) {
            return null;
          }

          // Count newline bytes directly — decoding up to 10MB to a string
          // would double the allocation for no benefit (0x0A is unambiguous
          // in UTF-8).
          let lineCount = 0;
          for (let i = 0; i < buffer.length; i++) {
            if (buffer[i] === 0x0a) lineCount++;
          }
          if (buffer.length > 0 && buffer[buffer.length - 1] !== 0x0a) {
            lineCount++;
          }

          PER_FILE_DIFF_STAT_CACHE.set(cacheKey, { insertions: lineCount, deletions: 0 });

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
        worktreeId: realCwd,
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
