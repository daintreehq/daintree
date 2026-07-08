import { readFile, stat } from "fs/promises";
import { isAbsolute, join as pathJoin } from "path";
import { timeoutSignal, withTimeout } from "../utils/withTimeout.js";

const FS_OP_TIMEOUT_MS = 5_000;
// Ceiling on how long the stat pre-check may keep skipping full git-status
// passes while the working tree is NOT covered by a recursive watcher. The
// four statted files are all .git metadata, so pure working-tree edits (an
// agent editing sources without staging) never perturb the baseline — without
// this bound they would stay invisible indefinitely on git-only/unwatched
// worktrees. Recursive-watched worktrees are exempt: their watcher observes
// every working-tree write and forces a refresh itself.
const FULL_STATUS_MAX_AGE_MS = 120_000;
// Sentinel for "this git path doesn't exist". Used so the baseline can
// stably record absence (packed-refs, detached HEAD's branch ref) and still
// match on the next stat pass without forcing a real git check.
const STAT_ABSENT_SENTINEL = -1;

interface GitFileStatBaseline {
  index: number;
  head: number;
  refsHead: number;
  packedRefs: number;
}

export interface StatPrecheckHost {
  readonly abortSignal: AbortSignal;
  // Live getters, not values snapshotted by the caller: the original inline
  // implementation read `_branch`/`lastWatcherEventAt` fresh after each
  // await, so a branch switch or watcher event landing mid-precheck is still
  // observed. Capturing them once at the `shouldSkip()` call site would miss
  // events that fire during `resolveCommonDirAsync`/`buildStatBaseline`.
  readonly branch: string | undefined;
  readonly lastWatcherEventAt: number;
}

/**
 * Cheap stat-based pre-check that lets the poll loop skip a full git-status
 * fork-exec when the four files that would invalidate it (index, HEAD,
 * refs/heads/<branch>, packed-refs) are unchanged and no watcher event has
 * fired since the baseline was captured.
 */
export class StatPrecheck {
  private cachedCommonDir: string | null = null;
  private baseline: GitFileStatBaseline | null = null;
  private baselineAt: number = 0;
  private fullStatusAt: number = 0;

  constructor(private readonly host: StatPrecheckHost) {}

  /** Test-only: when the current baseline was captured. */
  get baselineCapturedAt(): number {
    return this.baselineAt;
  }

  /** Test-only: force the full-status budget to a specific timestamp. */
  set fullStatusCapturedAt(value: number) {
    this.fullStatusAt = value;
  }

  /**
   * Resolve the common git directory for a linked worktree (the `gitDir`
   * inside `<repo>/.git/worktrees/<name>/` points at `commondir`, which
   * holds packed-refs and the shared refs/heads tree). Returns `gitDir`
   * itself for the main worktree, or when the commondir file is missing.
   * Mirrors `GitFileWatcher.resolveCommonDir`.
   */
  async resolveCommonDirAsync(gitDir: string): Promise<string> {
    // The commondir pointer is immutable for the lifetime of a worktree, so
    // a successful resolve is cached for the monitor's lifetime. Fallback
    // paths (missing file, timeout) stay uncached so transient errors retry.
    if (this.cachedCommonDir !== null) return this.cachedCommonDir;
    const { signal, dispose } = timeoutSignal(FS_OP_TIMEOUT_MS, this.host.abortSignal);
    try {
      const commondirContent = await readFile(pathJoin(gitDir, "commondir"), {
        encoding: "utf-8",
        signal,
      });
      const trimmed = commondirContent.trim();
      if (!trimmed) return gitDir;
      this.cachedCommonDir = isAbsolute(trimmed) ? trimmed : pathJoin(gitDir, trimmed);
      return this.cachedCommonDir;
    } catch {
      // Missing file, timeout, or poll abort — fall back to gitDir. A timeout
      // here just degrades the next poll to a full git check rather than the
      // stat fast path; it never freezes the loop.
      return gitDir;
    } finally {
      dispose();
    }
  }

  /**
   * Stat one git path. Returns `STAT_ABSENT_SENTINEL` when the file is
   * missing (the most common case for packed-refs and unpushed branch
   * refs) so the baseline can still compare equal on the next pass without
   * forcing a full git check. Other errors propagate up so the caller
   * falls back to the full path — a permission flip or filesystem hiccup
   * should not silently freeze the cached baseline.
   */
  async statMtime(filePath: string): Promise<number> {
    try {
      // fs.stat has no AbortSignal option (unlike readFile), so it can't be
      // cancelled — bound the await with withTimeout instead. The timeout
      // surfaces as a TimeoutError (not ENOENT), so it propagates and
      // buildStatBaseline falls back to a full git check rather than trusting a
      // half-captured baseline.
      const result = await withTimeout(stat(filePath), FS_OP_TIMEOUT_MS, `stat: ${filePath}`);
      return result.mtimeMs;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") return STAT_ABSENT_SENTINEL;
      throw error;
    }
  }

  /**
   * Capture mtimeMs for the four git files whose changes would invalidate
   * the previous status snapshot: index, HEAD, refs/heads/<branch>, and
   * packed-refs. Returns `null` if any unexpected error occurs (caller
   * falls back to a full git check). ENOENT is normal for packed-refs and
   * the branch ref (detached HEAD, or branch not pushed yet) — those paths
   * return STAT_ABSENT_SENTINEL and the baseline comparison still works.
   */
  private async buildStatBaseline(
    gitDir: string,
    commonDir: string,
    branch: string | undefined
  ): Promise<GitFileStatBaseline | null> {
    try {
      const [indexStat, headStat, refsHeadStat, packedRefsStat] = await Promise.all([
        this.statMtime(pathJoin(gitDir, "index")),
        this.statMtime(pathJoin(gitDir, "HEAD")),
        branch
          ? this.statMtime(pathJoin(commonDir, "refs", "heads", branch))
          : Promise.resolve(STAT_ABSENT_SENTINEL),
        this.statMtime(pathJoin(commonDir, "packed-refs")),
      ]);
      return {
        index: indexStat,
        head: headStat,
        refsHead: refsHeadStat,
        packedRefs: packedRefsStat,
      };
    } catch {
      return null;
    }
  }

  private baselinesMatch(a: GitFileStatBaseline, b: GitFileStatBaseline): boolean {
    return (
      a.index === b.index &&
      a.head === b.head &&
      a.refsHead === b.refsHead &&
      a.packedRefs === b.packedRefs
    );
  }

  private isFullStatusRecent(): boolean {
    return Date.now() - this.fullStatusAt < FULL_STATUS_MAX_AGE_MS;
  }

  /**
   * Whether the caller may skip a full git-status pass. Only trustworthy
   * while a recursive watcher covers the working tree (its events force
   * refreshes) or the baseline is still within FULL_STATUS_MAX_AGE_MS of the
   * last full pass — past that, pure working-tree edits on an
   * unwatched/git-only worktree would stay invisible indefinitely.
   */
  async shouldSkip(gitDir: string, recursivelyWatched: boolean): Promise<boolean> {
    const skipTrustworthy = recursivelyWatched || this.isFullStatusRecent();
    if (this.baseline === null || !skipTrustworthy) return false;

    const baselineAt = this.baselineAt;
    const checkStartedAt = Date.now();
    try {
      const commonDir = await this.resolveCommonDirAsync(gitDir);
      // `branch`/`lastWatcherEventAt` read live from the host — see the
      // interface comment. A branch switch or watcher event landing during
      // the awaits above/below must still be observed here, exactly as the
      // pre-split inline code re-read `this._branch`/`this.lastWatcherEventAt`
      // fresh at each point rather than snapshotting them once.
      const fresh = await this.buildStatBaseline(gitDir, commonDir, this.host.branch);
      if (
        fresh !== null &&
        this.host.lastWatcherEventAt <= baselineAt &&
        this.baselinesMatch(this.baseline, fresh)
      ) {
        this.baselineAt = checkStartedAt;
        return true;
      }
    } catch {
      // Unexpected stat error — fall through to the full git check.
      // Don't poison the baseline; the post-check rebuild will refresh it.
    }
    return false;
  }

  /**
   * Rebuild the stat baseline after a full pass lands cleanly, resetting the
   * stat-skip staleness budget alongside it. Drops the baseline on any
   * failure so the next non-forced poll falls through to a full check
   * rather than skipping against a snapshot that predates the failure.
   * Callers must only invoke this when the full pass actually succeeded —
   * see `dropBaseline()` for the failure path.
   */
  async recordFullPass(gitDir: string): Promise<void> {
    this.fullStatusAt = Date.now();
    try {
      const commonDir = await this.resolveCommonDirAsync(gitDir);
      const fresh = await this.buildStatBaseline(gitDir, commonDir, this.host.branch);
      if (fresh !== null) {
        this.baseline = fresh;
        this.baselineAt = Date.now();
      } else {
        this.baseline = null;
      }
    } catch {
      this.baseline = null;
    }
  }

  /** Drop the cached baseline — called when a git-status pass didn't land cleanly. */
  dropBaseline(): void {
    this.baseline = null;
  }
}
