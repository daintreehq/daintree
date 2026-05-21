import type { SimpleGit } from "simple-git";
import { createHardenedGit } from "../utils/hardenedGit.js";
import { existsSync } from "fs";
import { logDebug, logError } from "../utils/logger.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import type {
  ProjectPulse,
  HeatCell,
  HeatLevel,
  CommitItem,
  BranchDeltaToMain,
  PulseRangeDays,
  GetProjectPulseOptions,
} from "../../shared/types/pulse.js";

interface CacheEntry {
  pulse: ProjectPulse;
  timestamp: number;
  headSha: string | null;
  headBranch: string | undefined;
}

interface HeadProbeResult {
  sha: string | null;
  branch: string | undefined;
}

// Sentinel returned by probeHeadSha when the worktree path was deleted —
// distinct from `null` (which means "valid repo with no commits"). Keeps the
// equality check honest so a missing path doesn't silently match a cached
// empty pulse.
const PROBE_MISSING_PATH_SENTINEL = "__missing__";
// Sentinel for unexpected probe errors. Never matches a cached SHA so the
// caller always falls through to a real recompute (fail open to freshness).
const PROBE_ERROR_SENTINEL = "__probe-error__";

const CACHE_TTL_MS = 60_000;
const MAX_CACHE_SIZE = 100;
const MAX_COMMITS_FOR_HEATMAP = 20_000;
const VERBOSE_PROJECT_PULSE_LOGGING = process.env.DAINTREE_VERBOSE === "1";

const NO_COMMITS_PATTERNS = [
  "fatal: ambiguous argument 'head'",
  "unknown revision",
  "needed a single revision",
  "does not have any commits yet",
  "not a valid object name",
  "bad default revision 'head'",
];

function isNoCommitsError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase();
  return NO_COMMITS_PATTERNS.some((p) => lower.includes(p));
}

function logProjectPulseDebug(message: string, context?: Record<string, unknown>): void {
  if (!VERBOSE_PROJECT_PULSE_LOGGING) return;
  logDebug(message, context);
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

function formatLocalDay(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function getLocalMidnight(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function getDateCells(rangeDays: PulseRangeDays): Array<{ date: string; isToday: boolean }> {
  const todayMidnight = getLocalMidnight(new Date());
  const todayString = formatLocalDay(todayMidnight);

  const cells: Array<{ date: string; isToday: boolean }> = [];
  for (let i = rangeDays - 1; i >= 0; i--) {
    const cellDate = new Date(todayMidnight);
    cellDate.setDate(todayMidnight.getDate() - i);
    const dateString = formatLocalDay(cellDate);
    cells.push({ date: dateString, isToday: dateString === todayString });
  }

  return cells;
}

export class ProjectPulseService {
  private cache = new Map<string, CacheEntry>();
  private inFlight = new Map<string, Promise<ProjectPulse>>();
  private abortControllers = new Map<string, AbortController>();

  private getCacheKey(options: GetProjectPulseOptions): string {
    const includeDelta = options.includeDelta ?? true;
    const includeRecentCommits = options.includeRecentCommits ?? false;
    return `${options.worktreeId}:${options.worktreePath}:${options.mainBranch}:${options.rangeDays}:${includeDelta}:${includeRecentCommits}`;
  }

  private pruneCache(): void {
    if (this.cache.size > MAX_CACHE_SIZE) {
      const entries = Array.from(this.cache.entries());
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toDelete = entries.slice(0, entries.length - MAX_CACHE_SIZE);
      toDelete.forEach(([key]) => this.cache.delete(key));
    }
  }

  invalidate(worktreeId: string): void {
    const controller = this.abortControllers.get(worktreeId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(worktreeId);
    }

    const keysToDelete = Array.from(this.cache.keys()).filter((key) =>
      key.startsWith(`${worktreeId}:`)
    );
    keysToDelete.forEach((key) => this.cache.delete(key));

    const inFlightToDelete = Array.from(this.inFlight.keys()).filter((key) =>
      key.startsWith(`${worktreeId}:`)
    );
    inFlightToDelete.forEach((key) => this.inFlight.delete(key));

    logProjectPulseDebug("ProjectPulse cache invalidated", {
      worktreeId,
      keysDeleted: keysToDelete.length,
    });
  }

  async getPulse(options: GetProjectPulseOptions): Promise<ProjectPulse> {
    const cacheKey = this.getCacheKey(options);
    const cached = this.cache.get(cacheKey);

    if (!options.forceRefresh && cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      // Lightweight probe: if HEAD and the current branch both still match
      // the cached entry, serve the cache. Falls through to recompute when
      // either changes so commits, rebases, AND branch switches (e.g.
      // checkout to a new branch at the same SHA) surface inside the TTL.
      const probe = await this.probeHead(options.worktreePath);
      // Re-check the cache entry: invalidate() may have fired during the
      // await above, deleting the entry. Use the freshly-fetched entry so
      // we don't serve data that was just invalidated.
      const fresh = this.cache.get(cacheKey);
      if (fresh === cached && probe.sha === cached.headSha && probe.branch === cached.headBranch) {
        logProjectPulseDebug("ProjectPulse cache hit", { cacheKey });
        return cached.pulse;
      }
      logProjectPulseDebug("ProjectPulse cache invalidated by probe", {
        cacheKey,
        cachedSha: cached.headSha,
        currentSha: probe.sha,
        cachedBranch: cached.headBranch,
        currentBranch: probe.branch,
        entryStillPresent: fresh === cached,
      });
    }

    const existing = this.inFlight.get(cacheKey);
    if (existing) {
      return existing;
    }

    const { worktreeId } = options;
    let controller = this.abortControllers.get(worktreeId);
    if (!controller) {
      controller = new AbortController();
      this.abortControllers.set(worktreeId, controller);
    }

    const promise = (async () => {
      try {
        const { pulse, headSha, headBranch } = await this.computePulse(options, controller!.signal);
        if (!controller!.signal.aborted) {
          this.cache.set(cacheKey, {
            pulse,
            timestamp: Date.now(),
            headSha,
            headBranch,
          });
          this.pruneCache();
        }
        return pulse;
      } catch (error) {
        logError("ProjectPulse computation failed", {
          error: formatErrorMessage(error, "Failed to compute project pulse"),
          stack: error instanceof Error ? error.stack : undefined,
          worktreeId: options.worktreeId,
          worktreePath: options.worktreePath,
          mainBranch: options.mainBranch,
          rangeDays: options.rangeDays,
          pathExists: existsSync(options.worktreePath),
        });
        throw error;
      } finally {
        if (this.abortControllers.get(worktreeId) === controller) {
          this.abortControllers.delete(worktreeId);
        }
      }
    })();

    this.inFlight.set(cacheKey, promise);

    try {
      return await promise;
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  // Reads HEAD + current branch with the shared no-commits taxonomy. Used by
  // the cheap probe in getPulse — no signal so a pending invalidate can't
  // abort the validity check and trick the caller into a needless recompute.
  private async probeHead(worktreePath: string): Promise<HeadProbeResult> {
    if (!existsSync(worktreePath)) {
      // Distinct from no-commits null so a deleted worktree falls through to
      // computePulse (which throws "Worktree path does not exist") instead of
      // serving a stale empty-repo cache.
      return { sha: PROBE_MISSING_PATH_SENTINEL, branch: undefined };
    }
    try {
      const git = createHardenedGit(worktreePath);
      const shaOut = await git.raw(["rev-parse", "--verify", "HEAD"]);
      const sha = shaOut.trim() || null;
      let branch: string | undefined;
      try {
        const branchOut = await git.raw(["rev-parse", "--abbrev-ref", "HEAD"]);
        const trimmed = branchOut.trim();
        branch = trimmed === "HEAD" ? undefined : trimmed;
      } catch {
        branch = undefined;
      }
      return { sha, branch };
    } catch (error) {
      const message = formatErrorMessage(error, "Failed to probe git HEAD");
      if (isNoCommitsError(message)) {
        return { sha: null, branch: undefined };
      }
      // Unexpected error: fall through to recompute rather than silently
      // serving stale data.
      logProjectPulseDebug("ProjectPulse HEAD probe failed", { worktreePath, error: message });
      return { sha: PROBE_ERROR_SENTINEL, branch: undefined };
    }
  }

  private async computePulse(
    options: GetProjectPulseOptions,
    signal?: AbortSignal
  ): Promise<{ pulse: ProjectPulse; headSha: string | null; headBranch: string | undefined }> {
    const {
      worktreePath,
      worktreeId,
      mainBranch,
      rangeDays,
      includeDelta = true,
      includeRecentCommits = false,
    } = options;

    if (!existsSync(worktreePath)) {
      throw new Error(`Worktree path does not exist: ${worktreePath}`);
    }

    const git = createHardenedGit(worktreePath, signal);
    const startTime = Date.now();

    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
      throw new Error(`Not a git repository: ${worktreePath}`);
    }

    let headSha: string | null;
    try {
      const headOut = await git.raw(["rev-parse", "--verify", "HEAD"]);
      headSha = headOut.trim() || null;
    } catch (error) {
      const errorMessage = formatErrorMessage(error, "Failed to read git HEAD");
      if (isNoCommitsError(errorMessage)) {
        logProjectPulseDebug("Repository has no commits, returning empty pulse", { worktreeId });
        return { pulse: this.createEmptyPulse(options), headSha: null, headBranch: undefined };
      }
      logError("Failed to get HEAD revision", {
        error: errorMessage,
        worktreeId,
        worktreePath,
      });
      throw new Error(`Failed to read git HEAD: ${errorMessage}`, { cause: error });
    }

    let branch: string | undefined;
    try {
      const branchOutput = await git.raw(["rev-parse", "--abbrev-ref", "HEAD"]);
      branch = branchOutput.trim();
      if (branch === "HEAD") {
        branch = undefined; // Detached HEAD
      }
    } catch {
      branch = undefined;
    }

    // Run operations in parallel for performance
    const [heatmapResult, recentCommitsResult, deltaResult, firstCommitResult, fullStreakResult] =
      await Promise.allSettled([
        this.computeHeatmap(git, rangeDays),
        includeRecentCommits ? this.getRecentCommits(git, 8) : Promise.resolve([]),
        includeDelta && branch
          ? this.getBranchDelta(git, mainBranch, branch)
          : Promise.resolve(null),
        this.getFirstCommitDate(git),
        this.calculateFullStreak(git),
      ]);

    const heatmap =
      heatmapResult.status === "fulfilled"
        ? heatmapResult.value
        : this.createEmptyHeatmap(rangeDays);
    const recentCommits =
      recentCommitsResult.status === "fulfilled" ? recentCommitsResult.value : [];
    const deltaToMain = deltaResult.status === "fulfilled" ? deltaResult.value : undefined;
    const firstCommitDate =
      firstCommitResult.status === "fulfilled" ? firstCommitResult.value : null;
    const fullStreak = fullStreakResult.status === "fulfilled" ? fullStreakResult.value : 0;

    // Mark cells before project start and calculate project age
    let projectAgeDays: number = rangeDays;
    if (firstCommitDate) {
      const firstCommitDay = formatLocalDay(firstCommitDate);
      const todayMidnight = getLocalMidnight(new Date());

      // Calculate days since first commit (inclusive of first commit day)
      const daysSinceFirst =
        Math.floor(
          (todayMidnight.getTime() - getLocalMidnight(firstCommitDate).getTime()) /
            (1000 * 60 * 60 * 24)
        ) + 1;
      projectAgeDays = Math.min(daysSinceFirst, rangeDays);

      // Mark cells before project started
      for (const cell of heatmap) {
        if (cell.date < firstCommitDay) {
          cell.isBeforeProject = true;
        }
      }
    }

    // Calculate summary stats
    const commitsInRange = heatmap.reduce((sum, cell) => sum + cell.count, 0);
    const activeDays = heatmap.filter((cell) => cell.count > 0).length;
    const currentStreakDays = fullStreak;

    const pulse: ProjectPulse = {
      worktreeId,
      worktreePath,
      branch,
      mainBranch,
      rangeDays,
      generatedAt: Date.now(),
      heatmap,
      commitsInRange,
      activeDays,
      projectAgeDays,
      currentStreakDays,
      recentCommits,
      deltaToMain: deltaToMain ?? undefined,
    };

    logProjectPulseDebug("ProjectPulse computed", {
      worktreeId,
      commitsInRange,
      activeDays,
      durationMs: Date.now() - startTime,
    });

    return { pulse, headSha, headBranch: branch };
  }

  private async computeHeatmap(git: SimpleGit, rangeDays: PulseRangeDays): Promise<HeatCell[]> {
    const dateCells = getDateCells(rangeDays);
    const since = dateCells[0]?.date;
    if (!since) {
      return [];
    }

    let output: string;
    try {
      output = await git.raw([
        "log",
        `--since=${since}`,
        `--max-count=${MAX_COMMITS_FOR_HEATMAP}`,
        "--pretty=format:%ct",
      ]);
    } catch (error) {
      logError("Failed to get commit timestamps for heatmap", { error: (error as Error).message });
      return this.createEmptyHeatmap(rangeDays);
    }

    // Group commits by local day
    const dailyCounts = new Map<string, number>();
    const lines = output.split("\n").filter(Boolean);

    for (const line of lines) {
      const timestamp = parseInt(line, 10) * 1000;
      if (isNaN(timestamp)) continue;
      const date = formatLocalDay(new Date(timestamp));
      dailyCounts.set(date, (dailyCounts.get(date) || 0) + 1);
    }

    // Create cells for all days in range
    const cells: HeatCell[] = [];

    for (const { date, isToday } of dateCells) {
      const count = dailyCounts.get(date) || 0;
      cells.push({
        date,
        count,
        level: 0 as HeatLevel,
        isToday,
      });
    }

    // Compute intensity levels using p90 scaling
    const nonZeroCounts = cells.filter((c) => c.count > 0).map((c) => c.count);
    if (nonZeroCounts.length > 0) {
      nonZeroCounts.sort((a, b) => a - b);
      const p90Index = Math.floor(nonZeroCounts.length * 0.9);
      const scale = Math.max(1, nonZeroCounts[p90Index] || nonZeroCounts[nonZeroCounts.length - 1]);

      cells.forEach((cell) => {
        if (cell.count === 0) {
          cell.level = 0;
        } else {
          const ratio = cell.count / scale;
          cell.level = Math.min(4, Math.max(1, Math.ceil(ratio * 4))) as HeatLevel;
        }
      });
    }

    // Mark most recent active cell
    for (let i = cells.length - 1; i >= 0; i--) {
      if (cells[i].count > 0) {
        cells[i].isMostRecentActive = true;
        break;
      }
    }

    return cells;
  }

  private createEmptyHeatmap(rangeDays: PulseRangeDays): HeatCell[] {
    const dateCells = getDateCells(rangeDays);
    const cells: HeatCell[] = [];

    for (const { date, isToday } of dateCells) {
      cells.push({
        date,
        count: 0,
        level: 0,
        isToday,
      });
    }

    return cells;
  }

  private createEmptyPulse(options: GetProjectPulseOptions): ProjectPulse {
    return {
      worktreeId: options.worktreeId,
      worktreePath: options.worktreePath,
      branch: undefined,
      mainBranch: options.mainBranch,
      rangeDays: options.rangeDays,
      generatedAt: Date.now(),
      heatmap: this.createEmptyHeatmap(options.rangeDays),
      commitsInRange: 0,
      activeDays: 0,
      projectAgeDays: 0,
      currentStreakDays: 0,
      recentCommits: [],
    };
  }

  private async getRecentCommits(git: SimpleGit, count: number): Promise<CommitItem[]> {
    try {
      const output = await git.raw([
        "log",
        `-n`,
        `${count}`,
        "--pretty=format:%H\x1f%ct\x1f%an\x1f%s\x1e",
      ]);

      if (!output.trim()) {
        return [];
      }

      const commits: CommitItem[] = [];
      const records = output.split("\x1e").filter(Boolean);

      for (const record of records) {
        const parts = record.split("\x1f");
        if (parts.length < 4) continue;
        const [sha, timestamp, authorName, subject] = parts;
        commits.push({
          sha: sha.trim(),
          subject: subject.trim(),
          authorName: authorName.trim() || undefined,
          timestamp: parseInt(timestamp, 10) * 1000,
        });
      }

      return commits;
    } catch (error) {
      logError("Failed to get recent commits", { error: (error as Error).message });
      return [];
    }
  }

  private async getBranchDelta(
    git: SimpleGit,
    mainBranch: string,
    headBranch: string
  ): Promise<BranchDeltaToMain | null> {
    const resolveRef = async (ref: string): Promise<string | null> => {
      try {
        const sha = (await git.raw(["rev-parse", "--verify", "--", ref])).trim();
        return sha || null;
      } catch {
        return null;
      }
    };

    let baseRef = mainBranch;
    let baseSha = await resolveRef(baseRef);
    if (!baseSha) {
      baseRef = `origin/${mainBranch}`;
      baseSha = await resolveRef(baseRef);
      if (!baseSha) {
        return null;
      }
    }

    // Skip if we're on the main branch
    if (headBranch === baseRef || headBranch === baseRef.replace("origin/", "")) {
      return null;
    }

    try {
      // Get ahead/behind counts
      const revListOutput = await git.raw([
        "rev-list",
        "--left-right",
        "--count",
        `${baseSha}...HEAD`,
      ]);

      const [behindStr, aheadStr] = revListOutput.trim().split(/\s+/);
      const behind = parseInt(behindStr, 10) || 0;
      const ahead = parseInt(aheadStr, 10) || 0;

      let filesChanged = 0;
      let insertions = 0;
      let deletions = 0;

      try {
        const diffOutput = await git.raw([
          "diff",
          "--no-ext-diff",
          "--shortstat",
          `${baseSha}...HEAD`,
        ]);

        // Parse: "3 files changed, 45 insertions(+), 12 deletions(-)"
        const filesMatch = diffOutput.match(/(\d+)\s+files?\s+changed/);
        const insertMatch = diffOutput.match(/(\d+)\s+insertions?\(\+\)/);
        const deleteMatch = diffOutput.match(/(\d+)\s+deletions?\(-\)/);

        filesChanged = filesMatch ? parseInt(filesMatch[1], 10) : 0;
        insertions = insertMatch ? parseInt(insertMatch[1], 10) : 0;
        deletions = deleteMatch ? parseInt(deleteMatch[1], 10) : 0;
      } catch {
        // Fallback: just count files
        try {
          const nameOnlyOutput = await git.raw([
            "diff",
            "--no-ext-diff",
            "--name-only",
            `${baseSha}...HEAD`,
          ]);
          filesChanged = nameOnlyOutput.split("\n").filter(Boolean).length;
        } catch {
          // Ignore
        }
      }

      return {
        baseBranch: baseRef,
        headBranch,
        ahead,
        behind,
        filesChanged,
        insertions,
        deletions,
      };
    } catch (error) {
      logError("Failed to get branch delta", {
        error: (error as Error).message,
        mainBranch: baseRef,
      });
      return null;
    }
  }

  private async calculateFullStreak(git: SimpleGit): Promise<number> {
    const MAX_COMMITS_FOR_STREAK = 50_000;

    let output: string;
    try {
      output = await git.raw([
        "log",
        `--max-count=${MAX_COMMITS_FOR_STREAK}`,
        "--pretty=format:%ct",
      ]);
    } catch (error) {
      logError("Failed to get commit timestamps for full streak", {
        error: (error as Error).message,
      });
      return 0;
    }

    if (!output.trim()) {
      return 0;
    }

    // Group commits by local calendar day
    const commitsByDay = new Map<string, number>();
    const lines = output.split("\n").filter(Boolean);

    // Detect if we hit the commit limit (may truncate streak for high-volume repos)
    const hitCommitLimit = lines.length === MAX_COMMITS_FOR_STREAK;
    if (hitCommitLimit) {
      logProjectPulseDebug("Full streak calculation hit commit limit", {
        commitCount: MAX_COMMITS_FOR_STREAK,
        note: "Streak may be undercounted for high-volume repositories",
      });
    }

    for (const line of lines) {
      const timestamp = parseInt(line, 10) * 1000;
      if (isNaN(timestamp)) continue;
      const date = formatLocalDay(new Date(timestamp));
      commitsByDay.set(date, (commitsByDay.get(date) || 0) + 1);
    }

    // Count consecutive days backward from today (using local midnight for consistency)
    let streak = 0;
    const currentDate = getLocalMidnight(new Date());
    const todayStr = formatLocalDay(currentDate);

    // Check if today has commits - if not, start from yesterday
    const todayCount = commitsByDay.get(todayStr) || 0;
    if (todayCount === 0) {
      currentDate.setDate(currentDate.getDate() - 1);
    }

    // Count the streak
    while (true) {
      const dateKey = formatLocalDay(currentDate);
      const commitCount = commitsByDay.get(dateKey) || 0;

      if (commitCount > 0) {
        streak++;
        currentDate.setDate(currentDate.getDate() - 1);
      } else {
        break;
      }
    }

    return streak;
  }

  private async getFirstCommitDate(git: SimpleGit): Promise<Date | null> {
    try {
      // Shallow clones graft the boundary commit as a parent-less root, which would
      // make rev-list --max-parents=0 return the boundary SHA (often only days old)
      // instead of the historical root. Bail so the caller skips isBeforeProject culling.
      const shallowOut = await git.raw(["rev-parse", "--is-shallow-repository"]);
      if (shallowOut.trim() === "true") {
        return null;
      }

      // Get the root commit(s) - commits with no parents
      const rootSha = await git.raw(["rev-list", "--max-parents=0", "HEAD"]);
      const firstRootSha = rootSha.trim().split("\n")[0];

      if (!firstRootSha) {
        return null;
      }

      // Get the timestamp of the first root commit
      const output = await git.raw(["log", "-1", "--format=%ct", firstRootSha]);
      const timestamp = parseInt(output.trim(), 10);

      if (isNaN(timestamp)) {
        return null;
      }

      return new Date(timestamp * 1000);
    } catch (error) {
      logError("Failed to get first commit date", { error: (error as Error).message });
      return null;
    }
  }
}

export const projectPulseService = new ProjectPulseService();
