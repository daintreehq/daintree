import { simpleGit, SimpleGit } from "simple-git";
import { existsSync } from "fs";
import { logDebug, logError } from "../utils/logger.js";
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
  headSha?: string;
  timestamp: number;
}

const CACHE_TTL_MS = 60_000;
const MAX_CACHE_SIZE = 100;
const MAX_COMMITS_FOR_HEATMAP = 20_000;

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
    const keysToDelete = Array.from(this.cache.keys()).filter((key) =>
      key.startsWith(`${worktreeId}:`)
    );
    keysToDelete.forEach((key) => this.cache.delete(key));
    logDebug("ProjectPulse cache invalidated", { worktreeId, keysDeleted: keysToDelete.length });
  }

  async getPulse(options: GetProjectPulseOptions): Promise<ProjectPulse> {
    const cacheKey = this.getCacheKey(options);
    const cached = this.cache.get(cacheKey);

    if (!options.forceRefresh && cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      logDebug("ProjectPulse cache hit", { cacheKey });
      return cached.pulse;
    }

    const existing = this.inFlight.get(cacheKey);
    if (existing) {
      return existing;
    }

    const promise = (async () => {
      const { pulse, headSha } = await this.computePulse(options);
      this.cache.set(cacheKey, { pulse, headSha, timestamp: Date.now() });
      this.pruneCache();
      return pulse;
    })();

    this.inFlight.set(cacheKey, promise);

    try {
      return await promise;
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  private async computePulse(
    options: GetProjectPulseOptions
  ): Promise<{ pulse: ProjectPulse; headSha?: string }> {
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

    const git = simpleGit(worktreePath);
    const startTime = Date.now();

    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
      throw new Error(`Not a git repository: ${worktreePath}`);
    }

    let headSha: string | undefined;
    try {
      headSha = (await git.raw(["rev-parse", "HEAD"])).trim() || undefined;
    } catch {
      headSha = undefined;
    }

    // Get current branch
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
    const [heatmapResult, recentCommitsResult, deltaResult, firstCommitResult] =
      await Promise.allSettled([
        this.computeHeatmap(git, rangeDays),
        includeRecentCommits ? this.getRecentCommits(git, 8) : Promise.resolve([]),
        includeDelta && branch
          ? this.getBranchDelta(git, mainBranch, branch)
          : Promise.resolve(null),
        this.getFirstCommitDate(git),
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
    const currentStreakDays = this.calculateStreak(heatmap);

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

    logDebug("ProjectPulse computed", {
      worktreeId,
      commitsInRange,
      activeDays,
      durationMs: Date.now() - startTime,
    });

    return { pulse, headSha };
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
        const diffOutput = await git.raw(["diff", "--shortstat", `${baseSha}...HEAD`]);

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
          const nameOnlyOutput = await git.raw(["diff", "--name-only", `${baseSha}...HEAD`]);
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

  private calculateStreak(cells: HeatCell[]): number {
    let streak = 0;
    // Start from the most recent day and count backwards
    for (let i = cells.length - 1; i >= 0; i--) {
      const cell = cells[i];
      // Skip today if it has no commits yet
      if (cell.isToday && cell.count === 0) {
        continue;
      }
      if (cell.count > 0) {
        streak++;
      } else {
        break;
      }
    }
    return streak;
  }

  private async getFirstCommitDate(git: SimpleGit): Promise<Date | null> {
    try {
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
