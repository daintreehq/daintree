import type { SimpleGit } from "simple-git";
import { createStrictExitGit } from "../utils/hardenedGit.js";
import { existsSync } from "fs";
import { logDebug, logError, logLocalOnly } from "../utils/logger.js";
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

interface ComputedPulse {
  pulse: ProjectPulse;
  headSha: string | null;
  headBranch: string | undefined;
  historyLoadedAt: number;
  // False when a supplementary read failed and the pulse carries a fallback
  // for it: caching would pin that fallback until HEAD moves or the TTL ends.
  cacheable: boolean;
}

interface CacheEntry {
  pulse: ProjectPulse;
  timestamp: number;
  headSha: string | null;
  headBranch: string | undefined;
  day: string;
  timeZone: string;
}

// The local day and zone a compute answers for, read once so its heatmap, streak, age and
// cache tag all agree even when midnight or a zone change lands mid-compute.
interface LocalCalendar {
  todayMidnight: Date;
  day: string;
  timeZone: string;
}

// Range-independent facts about the history reachable from one HEAD: the project's start
// (earliest root) and every local day with a commit, which the streak is counted from at
// compute time so day rollover needs no new walk.
interface HistoryFacts {
  firstCommitDate: Date | null;
  // Null when the walk failed: the streak is then unknown, never zero.
  commitDays: ReadonlySet<string> | null;
}

interface HistoryEntry {
  headSha: string;
  timeZone: string;
  facts: HistoryFacts;
  // When the walks started: the age a Pulse built on these facts inherits.
  timestamp: number;
  // When its compute read HEAD, so a slower walk of an older HEAD can't evict a newer one.
  seq: number;
}

interface HistoryResult {
  facts: HistoryFacts;
  loadedAt: number;
  // False when a walk failed and its fallback stands in.
  complete: boolean;
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
const MAX_COMMITS_FOR_STREAK = 50_000;
// The history walks depend only on HEAD, but fetch --deepen/--unshallow, replace refs and
// grafts can change what HEAD reaches without moving it, so reuse keeps the Pulse's own
// freshness window rather than living as long as the SHA.
const HISTORY_TTL_MS = CACHE_TTL_MS;
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

// simple-git folds whatever git printed before failing into the error, and a
// log's output carries commit subjects and author names: git's own text stays
// in this machine's log, and only the fixed message travels.
function logReadFailure(message: string, reason: unknown, worktreeId: string): void {
  logError(message, undefined, { worktreeId });
  logLocalOnly(
    "error",
    `[ProjectPulse] ${message} (${worktreeId}): ${formatErrorMessage(reason, "git failed")}`
  );
}

// The public message is fixed for the same reason, and because the renderer
// reads "no commits yet" in an error as an unborn repository and stops
// retrying. The reason stays in the cause.
function historyReadError(
  what: string,
  reason: unknown,
  signal: AbortSignal | undefined,
  worktreeId: string
): Error {
  if (signal?.aborted) {
    return new Error("Project pulse read was cancelled", { cause: reason });
  }
  logReadFailure(`Failed to read ${what}`, reason, worktreeId);
  return new Error(`Failed to read ${what}`, { cause: reason });
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

// Counts calendar dates, not elapsed time: local midnights are 23 or 25 hours
// apart across a DST change, so dividing milliseconds by 24h undercounts after
// the spring transition and disagrees with the heatmap's per-date cells.
function countInclusiveLocalDays(first: Date, last: Date): number {
  const firstUtc = Date.UTC(first.getFullYear(), first.getMonth(), first.getDate());
  const lastUtc = Date.UTC(last.getFullYear(), last.getMonth(), last.getDate());
  return Math.round((lastUtc - firstUtc) / (1000 * 60 * 60 * 24)) + 1;
}

function getLocalTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function readLocalCalendar(): LocalCalendar {
  const todayMidnight = getLocalMidnight(new Date());
  return { todayMidnight, day: formatLocalDay(todayMidnight), timeZone: getLocalTimeZone() };
}

function countStreakDays(commitDays: ReadonlySet<string>, todayMidnight: Date): number {
  // Count back from today, or from yesterday when today has no commits yet.
  const cursor = new Date(todayMidnight);
  if (!commitDays.has(formatLocalDay(cursor))) {
    cursor.setDate(cursor.getDate() - 1);
  }

  let streak = 0;
  while (commitDays.has(formatLocalDay(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function getDateCells(
  rangeDays: PulseRangeDays,
  todayMidnight: Date = getLocalMidnight(new Date())
): Array<{ date: string; isToday: boolean }> {
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
  // Concurrent computes for one worktree share its controller, which leaves abortControllers only
  // when the last of them settles, so invalidate() can still abort one that outlives a sibling.
  private controllerUsers = new WeakMap<AbortController, number>();
  private historyCache = new Map<string, HistoryEntry>();
  private historyInFlight = new Map<string, Promise<HistoryResult>>();
  private historyLoadSeq = 0;
  // By worktree ID, then path, so invalidate() drops exactly one worktree's probes.
  private probeInFlight = new Map<string, Map<string, Promise<HeadProbeResult>>>();

  private getHistoryKey(worktreeId: string, worktreePath: string): string {
    return `${worktreeId}:${worktreePath}`;
  }

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

    for (const key of Array.from(this.historyCache.keys())) {
      if (key.startsWith(`${worktreeId}:`)) this.historyCache.delete(key);
    }
    for (const key of Array.from(this.historyInFlight.keys())) {
      if (key.startsWith(`${worktreeId}:`)) this.historyInFlight.delete(key);
    }
    this.probeInFlight.delete(worktreeId);

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
      const probe = await this.probeHeadShared(options.worktreeId, options.worktreePath);
      // Re-check the cache entry: invalidate() may have fired during the
      // await above, deleting the entry. Use the freshly-fetched entry so
      // we don't serve data that was just invalidated.
      const fresh = this.cache.get(cacheKey);
      const calendar = readLocalCalendar();
      if (
        fresh === cached &&
        probe.sha === cached.headSha &&
        probe.branch === cached.headBranch &&
        cached.day === calendar.day &&
        cached.timeZone === calendar.timeZone &&
        Date.now() - cached.timestamp < CACHE_TTL_MS
      ) {
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

    // A request after midnight or a zone change must not join a compute answering for the old one,
    // and a forced refresh must not join one that may be serving reused history.
    const calendar = readLocalCalendar();
    const flightKey = `${cacheKey}:${calendar.day}:${calendar.timeZone}`;
    const existing = this.inFlight.get(flightKey);
    if (existing && !options.forceRefresh) {
      return existing;
    }

    const { worktreeId } = options;
    const controller = this.abortControllers.get(worktreeId) ?? new AbortController();
    this.abortControllers.set(worktreeId, controller);
    this.controllerUsers.set(controller, (this.controllerUsers.get(controller) ?? 0) + 1);

    const run = async (): Promise<ProjectPulse> => {
      try {
        const { pulse, headSha, headBranch, historyLoadedAt, cacheable } = await this.computePulse(
          options,
          calendar,
          controller.signal
        );
        // Only the current flight publishes, and only while its day and zone still hold: an
        // aborted, invalidated or overtaken compute, or one answering for a day already over,
        // would otherwise replace a fresher entry. A Pulse standing on a failed walk's fallback is
        // served once and retried, like the history it lacks.
        const now = readLocalCalendar();
        if (
          cacheable &&
          !controller.signal.aborted &&
          this.inFlight.get(flightKey) === promise &&
          now.day === calendar.day &&
          now.timeZone === calendar.timeZone
        ) {
          this.cache.set(cacheKey, {
            pulse,
            // A Pulse built on reused history expires with that history, so switching ranges
            // can't stretch how long a walk's result is served.
            timestamp: Math.min(Date.now(), historyLoadedAt),
            headSha,
            headBranch,
            day: calendar.day,
            timeZone: calendar.timeZone,
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
        const users = (this.controllerUsers.get(controller) ?? 1) - 1;
        if (users > 0) {
          this.controllerUsers.set(controller, users);
        } else {
          this.controllerUsers.delete(controller);
          if (this.abortControllers.get(worktreeId) === controller) {
            this.abortControllers.delete(worktreeId);
          }
        }
      }
    };
    const promise = run();

    this.inFlight.set(flightKey, promise);

    try {
      return await promise;
    } finally {
      // An overtaken compute settling late must not drop the flight that replaced it.
      if (this.inFlight.get(flightKey) === promise) {
        this.inFlight.delete(flightKey);
      }
    }
  }

  // Callers validating caches of one worktree at once share its probe. Each still re-checks its
  // entry after the await, and invalidate() drops the probe so later callers don't join a read
  // that may predate the change behind it.
  private probeHeadShared(worktreeId: string, worktreePath: string): Promise<HeadProbeResult> {
    let byPath = this.probeInFlight.get(worktreeId);
    const existing = byPath?.get(worktreePath);
    if (existing) return existing;
    if (!byPath) {
      byPath = new Map();
      this.probeInFlight.set(worktreeId, byPath);
    }
    const owner = byPath;
    const probe = this.probeHead(worktreePath).finally(() => {
      if (owner.get(worktreePath) !== probe) return;
      owner.delete(worktreePath);
      if (owner.size === 0 && this.probeInFlight.get(worktreeId) === owner) {
        this.probeInFlight.delete(worktreeId);
      }
    });
    owner.set(worktreePath, probe);
    return probe;
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
      const git = await createStrictExitGit(worktreePath);
      // One process prints the SHA, then the branch (`HEAD` when detached); an
      // unborn branch fails the whole read with the no-commits error.
      const lines = (await git.raw(["rev-parse", "HEAD", "--abbrev-ref", "HEAD"]))
        .trim()
        .split(/\r?\n/)
        .map((line) => line.trim());
      if (lines.length !== 2) {
        // `undefined` is a detached HEAD; an answer that can't establish both
        // values must not match a cached detached snapshot, so recompute.
        return { sha: PROBE_ERROR_SENTINEL, branch: undefined };
      }
      const [sha, branch] = lines;
      return { sha, branch: branch === "HEAD" ? undefined : branch };
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
    calendar: LocalCalendar,
    signal?: AbortSignal
  ): Promise<ComputedPulse> {
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

    // Strict: a git killed before it wrote anything exits non-zero with no
    // stderr, which the lenient profile resolves as an empty, zero-commit log.
    const git = await createStrictExitGit(worktreePath, signal);
    const startTime = Date.now();
    const { todayMidnight } = calendar;

    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
      throw new Error(`Not a git repository: ${worktreePath}`);
    }

    let headSha: string | null;
    let historySeq: number;
    try {
      const headOut = await git.raw(["rev-parse", "--verify", "HEAD"]);
      headSha = headOut.trim() || null;
      // Ordered by when HEAD was read, so a compute that read an older HEAD can't evict the
      // history of one that read a newer HEAD, whichever walk finishes last.
      historySeq = ++this.historyLoadSeq;
    } catch (error) {
      const errorMessage = formatErrorMessage(error, "Failed to read git HEAD");
      if (isNoCommitsError(errorMessage)) {
        logProjectPulseDebug("Repository has no commits, returning empty pulse", { worktreeId });
        return {
          pulse: this.createEmptyPulse(options, todayMidnight),
          headSha: null,
          headBranch: undefined,
          historyLoadedAt: startTime,
          cacheable: true,
        };
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

    // Walks start from the SHA resolved above, so a checkout mid-compute can't mix two heads'
    // commits into one Pulse or file another head's history under this SHA.
    const rev = headSha ?? "HEAD";

    // Run operations in parallel for performance
    const [heatmapResult, recentCommitsResult, deltaResult, historyResult] =
      await Promise.allSettled([
        this.computeHeatmap(git, rangeDays, todayMidnight, rev),
        includeRecentCommits ? this.getRecentCommits(git, 8, rev) : Promise.resolve([]),
        includeDelta && branch
          ? this.getBranchDelta(git, mainBranch, branch, rev)
          : Promise.resolve(null),
        this.getHistoryFacts(git, options, headSha, historySeq, calendar.timeZone, signal),
      ]);

    // HEAD resolved, so this repository has history: a failed read of it is a
    // failure, never zero activity. The heatmap backs the commit total, the
    // active days and the coach line, so without it there is no pulse to show.
    if (heatmapResult.status === "rejected") {
      throw historyReadError("commit history", heatmapResult.reason, signal, worktreeId);
    }
    // Only asked for by callers that read the list; an empty one would claim
    // there are no commits.
    if (recentCommitsResult.status === "rejected") {
      throw historyReadError("recent commits", recentCommitsResult.reason, signal, worktreeId);
    }
    const heatmap = heatmapResult.value;
    const recentCommits = recentCommitsResult.value;
    const deltaToMain = deltaResult.status === "fulfilled" ? deltaResult.value : undefined;

    const history = historyResult.status === "fulfilled" ? historyResult.value : null;
    const cacheable = history?.complete ?? false;
    // A failed root read keeps the full-window denominator and skips the
    // before-project marking, as a shallow clone does, but isn't cached.
    const firstCommitDate = history?.facts.firstCommitDate ?? null;
    // Unknown, not zero: the streak is optional, so consumers leave it out.
    const commitDays = history?.facts.commitDays;
    const currentStreakDays = commitDays ? countStreakDays(commitDays, todayMidnight) : undefined;

    // Mark cells before project start and calculate project age
    let projectAgeDays: number = rangeDays;
    if (firstCommitDate) {
      const firstCommitDay = formatLocalDay(firstCommitDate);

      const daysSinceFirst = countInclusiveLocalDays(firstCommitDate, todayMidnight);
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

    return {
      pulse,
      headSha,
      headBranch: branch,
      historyLoadedAt: history?.loadedAt ?? startTime,
      cacheable,
    };
  }

  private async computeHeatmap(
    git: SimpleGit,
    rangeDays: PulseRangeDays,
    todayMidnight: Date,
    rev: string
  ): Promise<HeatCell[]> {
    const dateCells = getDateCells(rangeDays, todayMidnight);
    const since = dateCells[0]?.date;
    if (!since) {
      return [];
    }

    // A bare `YYYY-MM-DD` makes git borrow the current time of day, so an afternoon refresh would
    // drop the morning commits of the oldest cell. An epoch pins the cutoff to local midnight.
    const [sinceYear, sinceMonth, sinceDay] = since.split("-").map(Number);
    const sinceEpochSeconds = Math.floor(
      new Date(sinceYear, sinceMonth - 1, sinceDay).getTime() / 1000
    );

    // No --max-count: the window already bounds this read, and any ceiling below
    // the window's real volume cut the oldest days out of the grid and the totals
    // while they still read as exact (#17455). One %ct line is 11 bytes, so a
    // window of 100,000 commits prints about 1MB.
    const output = await git.raw([
      "log",
      `--since=${sinceEpochSeconds}`,
      "--pretty=format:%ct",
      rev,
      "--",
    ]);

    // Walked in place rather than split, so a busy window never holds an array of
    // every timestamp string at once.
    const dailyCounts = new Map<string, number>();
    for (let start = 0; start < output.length;) {
      const newline = output.indexOf("\n", start);
      const end = newline === -1 ? output.length : newline;
      const timestamp = parseInt(output.slice(start, end), 10) * 1000;
      start = end + 1;
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

  private createEmptyHeatmap(rangeDays: PulseRangeDays, todayMidnight?: Date): HeatCell[] {
    const dateCells = getDateCells(rangeDays, todayMidnight);
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

  private createEmptyPulse(options: GetProjectPulseOptions, todayMidnight: Date): ProjectPulse {
    return {
      worktreeId: options.worktreeId,
      worktreePath: options.worktreePath,
      branch: undefined,
      mainBranch: options.mainBranch,
      rangeDays: options.rangeDays,
      generatedAt: Date.now(),
      heatmap: this.createEmptyHeatmap(options.rangeDays, todayMidnight),
      commitsInRange: 0,
      activeDays: 0,
      projectAgeDays: 0,
      currentStreakDays: 0,
      recentCommits: [],
    };
  }

  private async getRecentCommits(
    git: SimpleGit,
    count: number,
    rev: string
  ): Promise<CommitItem[]> {
    const output = await git.raw([
      "log",
      `-n`,
      `${count}`,
      "--pretty=format:%H\x1f%ct\x1f%an\x1f%s\x1e",
      rev,
      "--",
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
  }

  private async getBranchDelta(
    git: SimpleGit,
    mainBranch: string,
    headBranch: string,
    rev: string
  ): Promise<BranchDeltaToMain | null> {
    const resolveRef = async (ref: string): Promise<string | null> => {
      // `--` after --verify turns the ref into a path and always fails, so the ref
      // is pinned to a commit with ^{commit} instead; a leading dash can't be an option.
      if (ref.startsWith("-")) return null;
      try {
        const sha = (await git.raw(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).trim();
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
        `${baseSha}...${rev}`,
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
          `${baseSha}...${rev}`,
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
            `${baseSha}...${rev}`,
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

  // Shared by every range on the same HEAD: a range switch only re-reads the heatmap window.
  private async getHistoryFacts(
    git: SimpleGit,
    options: GetProjectPulseOptions,
    headSha: string | null,
    seq: number,
    timeZone: string,
    signal?: AbortSignal
  ): Promise<HistoryResult> {
    // A compute invalidate() already aborted must not open a flight a replacement could join: its
    // walks fail and would hand the replacement empty facts.
    signal?.throwIfAborted();

    if (!headSha) {
      const loadedAt = Date.now();
      return { ...(await this.loadHistoryFacts(git, "HEAD", options.worktreeId)), loadedAt };
    }

    const key = this.getHistoryKey(options.worktreeId, options.worktreePath);
    const cached = this.historyCache.get(key);
    if (
      !options.forceRefresh &&
      cached &&
      cached.headSha === headSha &&
      cached.timeZone === timeZone &&
      Date.now() - cached.timestamp < HISTORY_TTL_MS
    ) {
      return { facts: cached.facts, loadedAt: cached.timestamp, complete: true };
    }

    // A forced refresh walks afresh rather than joining a walk that began before it; the identity
    // checks below keep the superseded flight from publishing over it or evicting it.
    const inFlightKey = `${key}:${headSha}:${timeZone}`;
    const existing = this.historyInFlight.get(inFlightKey);
    if (existing && !options.forceRefresh) {
      return existing;
    }

    const loadedAt = Date.now();
    const load = async (): Promise<HistoryResult> => {
      const { facts, complete } = await this.loadHistoryFacts(git, headSha, options.worktreeId);
      // invalidate() aborts the signal and drops this flight, so an aborted or superseded load
      // never lands in the cache, nor do days formatted after a zone change; a partial load is
      // served once and walked again next time.
      const latest = this.historyCache.get(key);
      if (
        complete &&
        !signal?.aborted &&
        this.historyInFlight.get(inFlightKey) === promise &&
        getLocalTimeZone() === timeZone &&
        (!latest || latest.seq < seq || latest.headSha === headSha)
      ) {
        const order = Math.max(seq, latest?.seq ?? 0);
        this.historyCache.set(key, { headSha, timeZone, facts, timestamp: loadedAt, seq: order });
        this.pruneHistoryCache();
      }
      return { facts, loadedAt, complete };
    };
    const promise = load();

    this.historyInFlight.set(inFlightKey, promise);
    try {
      return await promise;
    } finally {
      if (this.historyInFlight.get(inFlightKey) === promise) {
        this.historyInFlight.delete(inFlightKey);
      }
    }
  }

  private pruneHistoryCache(): void {
    const now = Date.now();
    for (const [key, entry] of Array.from(this.historyCache.entries())) {
      if (now - entry.timestamp >= HISTORY_TTL_MS) this.historyCache.delete(key);
    }
    if (this.historyCache.size <= MAX_CACHE_SIZE) return;
    const entries = Array.from(this.historyCache.entries());
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
    for (const [key] of entries.slice(0, entries.length - MAX_CACHE_SIZE)) {
      this.historyCache.delete(key);
    }
  }

  // Both walks start from the SHA the compute resolved, so a checkout between commands can't
  // file another commit's history under it.
  private async loadHistoryFacts(
    git: SimpleGit,
    rev: string,
    worktreeId: string
  ): Promise<{ facts: HistoryFacts; complete: boolean }> {
    const [firstCommitResult, commitDaysResult] = await Promise.allSettled([
      this.loadFirstCommitDate(git, rev),
      this.loadCommitDays(git, rev),
    ]);

    if (firstCommitResult.status === "rejected") {
      logReadFailure("Failed to get first commit date", firstCommitResult.reason, worktreeId);
    }
    if (commitDaysResult.status === "rejected") {
      logReadFailure(
        "Failed to get commit timestamps for full streak",
        commitDaysResult.reason,
        worktreeId
      );
    }

    return {
      facts: {
        firstCommitDate: firstCommitResult.status === "fulfilled" ? firstCommitResult.value : null,
        commitDays: commitDaysResult.status === "fulfilled" ? commitDaysResult.value : null,
      },
      complete: firstCommitResult.status === "fulfilled" && commitDaysResult.status === "fulfilled",
    };
  }

  private async loadCommitDays(git: SimpleGit, rev: string): Promise<Set<string>> {
    const output = await git.raw([
      "log",
      `--max-count=${MAX_COMMITS_FOR_STREAK}`,
      "--pretty=format:%ct",
      rev,
      "--",
    ]);

    const commitDays = new Set<string>();
    const lines = output.split("\n").filter(Boolean);

    if (lines.length === MAX_COMMITS_FOR_STREAK) {
      logProjectPulseDebug("Full streak calculation hit commit limit", {
        commitCount: MAX_COMMITS_FOR_STREAK,
        note: "Streak may be undercounted for high-volume repositories",
      });
    }

    for (const line of lines) {
      const timestamp = parseInt(line, 10) * 1000;
      if (isNaN(timestamp)) continue;
      commitDays.add(formatLocalDay(new Date(timestamp)));
    }

    return commitDays;
  }

  private async loadFirstCommitDate(git: SimpleGit, rev: string): Promise<Date | null> {
    // Shallow clones graft the boundary commit as a parent-less root, which would
    // make rev-list --max-parents=0 return the boundary SHA (often only days old)
    // instead of the historical root. Bail so the caller skips isBeforeProject culling.
    const shallowOut = await git.raw(["rev-parse", "--is-shallow-repository"]);
    if (shallowOut.trim() === "true") {
      return null;
    }

    // Merging unrelated histories leaves several reachable roots, and rev-list prints
    // them newest first, so the project's start is the earliest root timestamp rather
    // than whichever line comes first. Each line is "<committer timestamp> <sha>".
    const rootsOut = await git.raw(["rev-list", "--max-parents=0", "--timestamp", rev, "--"]);

    let earliest: number | null = null;
    for (const line of rootsOut.split("\n")) {
      const timestamp = parseInt(line.trim().split(/\s+/)[0] ?? "", 10);
      if (isNaN(timestamp)) continue;
      if (earliest === null || timestamp < earliest) {
        earliest = timestamp;
      }
    }

    return earliest === null ? null : new Date(earliest * 1000);
  }
}

export const projectPulseService = new ProjectPulseService();
