import { performance } from "node:perf_hooks";
import type { PerfScenario } from "../types";
import { percentile } from "../lib/stats";
import {
  gitSpawnMark,
  gitSpawnsSince,
  installGitSpawnCounter,
  spawnObserverMisses,
} from "../lib/gitPipelineFixture";
import {
  addTrackedPath,
  getFileSearchFixture,
  getFileSearchRetentionRepos,
  GIT_ONLY_SENTINEL,
  loadFileSearchInvalidationModule,
  loadFileSearchModule,
  NO_MATCH_QUERY,
  removeTrackedPath,
  RETENTION_REPO_COUNT,
  TYPED_FILE_QUERIES,
  withClockOffsetAsync,
  type FileSearchRepo,
} from "../lib/fileSearchFixture";

// File picker — the `@`-mention completion and the file palette, both served by
// the real FileSearchService. Two costs the user feels, measured separately
// because they have different fixes:
//
//   * COLD (PERF-192): with no cached path list, the first keystroke pays for
//     `git ls-files` plus the directory-set build and sort. Nothing renders
//     until it resolves, so this IS the picker's open latency.
//   * WARM (PERF-190/191): every subsequent keystroke re-scans the whole cached
//     list through `scorePath` and re-heaps the top 50. This is the typing
//     latency, and it scales linearly with repo size.
//
// Which of the two a keystroke pays is a LIFECYCLE question, and PERF-197/198
// are about that half. The list used to be dropped by a 10s TTL alone, so a
// pause in the picker put the next keystroke back on the cold path and the
// dropped indexes were never actually freed. Freshness now comes from the
// worktree watcher (`FileSearchCacheInvalidator`) with a 5-minute fallback
// clock, and a sweep reclaims what expires: PERF-197 measures whether an
// unchanged worktree still reloads, PERF-198 whether an expired index is
// still held.
//
// `FileSearchService.search` swallows every error and returns `[]`, and
// `loadFileList` silently falls back to a filesystem walk when git fails — both
// of which are FASTER than the path being claimed. So every scenario here
// reports which path ran, not merely that something came back: `queryMisses`
// counts completed queries that matched nothing, and PERF-192's
// `gitPathListMisses` covers both halves of "this really was the git listing"
// — a git subprocess started, and the results contain a file only that listing
// can return. All of them are emitted on every iteration, 0 when healthy: a
// metric that only appears when the subject is broken cannot be read as a
// predicate, because a run where every query broke and a run that never
// happened produce the same absent column.

interface KeystrokeStreamResult {
  sessionMs: number;
  keystrokes: number;
  p99KeystrokeMs: number;
  totalMatches: number;
  /** Completed queries that matched nothing — see `runKeystrokeStream`. */
  queryMisses: number;
}

type SearchFn = (payload: { cwd: string; query: string; limit?: number }) => Promise<string[]>;

/**
 * Type every query one character at a time, timing each individual re-scan.
 * Each full query is expected to end with at least one match, counted
 * per-query rather than in aggregate: a single surviving query would otherwise
 * mask several broken scoring branches behind a healthy-looking total.
 */
async function runKeystrokeStream(search: SearchFn, cwd: string): Promise<KeystrokeStreamResult> {
  const perKeystroke: number[] = [];
  let totalMatches = 0;
  let queryMisses = 0;

  const sessionStart = performance.now();
  for (const query of TYPED_FILE_QUERIES) {
    let finalMatches = 0;
    for (let end = 1; end <= query.length; end += 1) {
      const start = performance.now();
      const matches = await search({ cwd, query: query.slice(0, end), limit: 50 });
      perKeystroke.push(performance.now() - start);
      totalMatches += matches.length;
      finalMatches = matches.length;
    }
    if (finalMatches === 0) queryMisses += 1;
  }
  const sessionMs = performance.now() - sessionStart;

  return {
    sessionMs,
    keystrokes: perKeystroke.length,
    p99KeystrokeMs: percentile(perKeystroke, 99),
    totalMatches,
    queryMisses,
  };
}

/**
 * Guarantee a full-TTL cache entry before a warm timing bracket. Priming with a
 * plain search is not enough: `Cache.get` refreshes `lastAccessed` but never
 * extends `expiresAt`, so a hit taken near expiry can lapse mid-stream and
 * silently fold a cold `git ls-files` rebuild into a "warm" sample. Invalidating
 * first forces a freshly-stamped entry.
 */
async function primeCache(
  search: SearchFn,
  invalidate: (cwd: string) => void,
  repo: FileSearchRepo
): Promise<void> {
  invalidate(repo.path);
  const primed = await search({ cwd: repo.path, query: "terminal", limit: 50 });
  if (primed.length === 0) {
    throw new Error(`file search returned no results for ${repo.path} — fixture or service broken`);
  }
}

/**
 * A pause longer than the TTL this change replaced. The point of the arm is
 * "the user came back after the old clock would have lapsed", so it is pinned
 * just past 10s rather than to the current TTL — retuning the fallback must not
 * quietly retune the question.
 */
const OLD_TTL_PAUSE_MS = 11_000;

/** Past the 5-minute fallback TTL, so a swept entry is genuinely expired. */
const PAST_TTL_OFFSET_MS = 360_000;

/**
 * Strictly increasing stand-in for `WorktreeMonitor._workingTreeChangedAt`,
 * which stamps `Math.max(Date.now(), prev + 1)` per flush. The invalidator
 * ignores a repeated value on purpose, so two iterations landing in the same
 * millisecond must not look like one flush.
 */
let filesChangedStamp = Date.now();

/**
 * Stand-ins for the routed event's `epoch` and the monitor's `generation`.
 * Constant across iterations on purpose: the invalidator treats a change in
 * either as "the host restarted, assume anything moved", which would invalidate
 * for a reason this scenario is not measuring.
 */
const PERF_HOST_EPOCH = "perf-197-host-epoch";
const PERF_MONITOR_GENERATION = 1;
function nextFilesChangedStamp(): number {
  filesChangedStamp += 1;
  return filesChangedStamp;
}

/**
 * The service clamps `limit` to 100, so a listing can never be counted in full
 * through the public API. What it CAN prove is that an index is not degenerate:
 * a worktree holding the fixture's ~3,200 paths always fills the cap, and one
 * holding a handful cannot.
 */
const FULL_LISTING_LIMIT = 100;

/**
 * Mirrors `scenarios/soak.ts`. The harness spawns benchmarks with
 * `--expose-gc`, so a missing hook means the measurement is not the one being
 * claimed — the scenarios below report that as a miss rather than quietly
 * comparing two un-collected heaps.
 */
function maybeRunGc(): void {
  const gcFn = (globalThis as { gc?: () => void }).gc;
  if (typeof gcFn === "function") gcFn();
}

function gcAvailable(): boolean {
  return typeof (globalThis as { gc?: () => void }).gc === "function";
}

/** Let pending microtasks and one macrotask drain before a heap reading. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Collect, twice, with a turn of the event loop between.
 *
 * One synchronous `gc()` is not a settled heap: V8 finishes some reclamation
 * lazily, and a backing store freed by the first pass is only accounted for by
 * the second. Every reading in the retention scenario uses this same protocol,
 * so the three are comparable to each other whatever any one of them missed.
 */
async function collectAndSettle(): Promise<void> {
  for (let pass = 0; pass < 2; pass += 1) {
    maybeRunGc();
    await settle();
  }
}

export const fileSearchScenarios: PerfScenario[] = [
  {
    id: "PERF-190",
    name: "File Picker Typing - Warm List (representative repo)",
    description:
      "Real FileSearchService.search over a warm ~3,200-file git repo while typing 5 representative " +
      "queries one keystroke at a time — every prefix is a full re-scan of the path list, as in the " +
      "live `@` picker. durationMs is the whole typing session; p99KeystrokeMs is the single " +
      "re-scan the user feels and must stay well inside a frame.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 6, ci: 10, nightly: 14 },
    warmups: 2,
    correctness: ["queryMisses"],
    async run() {
      const fixture = getFileSearchFixture();
      const { fileSearchService } = await loadFileSearchModule();
      const search: SearchFn = (payload) => fileSearchService.search(payload);
      const invalidate = (cwd: string): void => fileSearchService.invalidate(cwd);

      await primeCache(search, invalidate, fixture.representative);

      const start = performance.now();
      const stream = await runKeystrokeStream(search, fixture.representative.path);
      const durationMs = performance.now() - start;

      return {
        durationMs,
        metrics: {
          keystrokes: stream.keystrokes,
          p99KeystrokeMs: stream.p99KeystrokeMs,
          avgKeystrokeMs: stream.sessionMs / Math.max(1, stream.keystrokes),
          totalMatches: stream.totalMatches,
          fileCount: fixture.representative.fileCount,
          queryMisses: stream.queryMisses,
        },
      };
    },
  },
  {
    id: "PERF-191",
    name: "File Picker Typing - Repo Scaling",
    description:
      "The same warm typing session run against a ~3,200-file repo and a ~12,000-file monorepo, plus " +
      "a query matching nothing (which skips top-N heap maintenance and the final sort, so it is the " +
      "cheap end, not the worst case). msPerKFile is the large repo's per-keystroke cost normalised " +
      "by file count — a fixed-scale regression signal for scorePath/pickTopMatches.",
    tier: "heavy",
    modes: ["ci", "nightly"],
    iterations: { ci: 8, nightly: 12 },
    warmups: 1,
    correctness: ["queryMisses"],
    async run() {
      const fixture = getFileSearchFixture();
      const { fileSearchService } = await loadFileSearchModule();
      const search: SearchFn = (payload) => fileSearchService.search(payload);
      const invalidate = (cwd: string): void => fileSearchService.invalidate(cwd);

      await primeCache(search, invalidate, fixture.representative);
      await primeCache(search, invalidate, fixture.monorepo);

      const start = performance.now();
      const small = await runKeystrokeStream(search, fixture.representative.path);
      const large = await runKeystrokeStream(search, fixture.monorepo.path);

      const missStart = performance.now();
      const missResults = await search({
        cwd: fixture.monorepo.path,
        query: NO_MATCH_QUERY,
        limit: 50,
      });
      const missMs = performance.now() - missStart;
      const durationMs = performance.now() - start;

      const largeAvg = large.sessionMs / Math.max(1, large.keystrokes);
      const msPerKFile = largeAvg / (fixture.monorepo.fileCount / 1000);

      return {
        durationMs,
        metrics: {
          smallP99KeystrokeMs: small.p99KeystrokeMs,
          largeP99KeystrokeMs: large.p99KeystrokeMs,
          msPerKFile,
          noMatchScanMs: missMs,
          monorepoFileCount: fixture.monorepo.fileCount,
          // Both directions: queries that should match and did not, plus the
          // query that should match nothing and did. Scoring that stopped
          // matching and scoring that stopped filtering are both cheaper than
          // scoring that works.
          queryMisses: small.queryMisses + large.queryMisses + (missResults.length === 0 ? 0 : 1),
        },
      };
    },
  },
  {
    id: "PERF-192",
    name: "File Picker Cold Open - Git Path List Build",
    description:
      "Drops the cached path list and times the first search: real `git ls-files --cached --others " +
      "--exclude-standard`, NUL parse, ancestor-directory set build and length sort, at both repo " +
      "scales. This is the wait between pressing `@` and the picker showing anything. Asserts a git " +
      "subprocess actually spawned and that the results contain a file only the git listing can " +
      "return (gitPathListMisses) — without both, a broken git path degrades to the filesystem " +
      "walker and this would report walker time under a git label.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 4, ci: 8, nightly: 12 },
    warmups: 1,
    correctness: ["gitPathListMisses", "spawnObserverMisses"],
    async run() {
      const fixture = getFileSearchFixture();
      const { fileSearchService } = await loadFileSearchModule();
      // Counts async git spawns from the product path. Fixture setup uses
      // spawnSync, which does not route through ChildProcess.prototype.spawn.
      installGitSpawnCounter();
      // Before the mark: the probe starts a child of its own to prove the
      // counter below can still see one.
      const observerMisses = spawnObserverMisses();

      fileSearchService.invalidate(fixture.representative.path);
      fileSearchService.invalidate(fixture.monorepo.path);

      const spawnMark = gitSpawnMark();
      const start = performance.now();

      const smallStart = performance.now();
      const smallResults = await fileSearchService.search({
        cwd: fixture.representative.path,
        query: GIT_ONLY_SENTINEL,
        limit: 50,
      });
      const smallColdMs = performance.now() - smallStart;

      const largeStart = performance.now();
      const largeResults = await fileSearchService.search({
        cwd: fixture.monorepo.path,
        query: GIT_ONLY_SENTINEL,
        limit: 50,
      });
      const largeColdMs = performance.now() - largeStart;

      const durationMs = performance.now() - start;
      const spawns = gitSpawnsSince(spawnMark);

      // Both halves must be genuinely cold AND genuinely git-backed. A warm
      // cache and a filesystem-walk fallback are both faster than the path this
      // scenario claims to time, and the sentinel is a file only `git ls-files`
      // can return — so the two together are the whole predicate.
      const gitPathListMisses =
        (spawns.count > 0 ? 0 : 1) +
        (smallResults.includes(GIT_ONLY_SENTINEL) ? 0 : 1) +
        (largeResults.includes(GIT_ONLY_SENTINEL) ? 0 : 1);

      return {
        durationMs,
        metrics: {
          smallColdMs,
          largeColdMs,
          coldMsPerKFile: largeColdMs / (fixture.monorepo.fileCount / 1000),
          gitSpawns: spawns.count,
          lsFilesSpawns: spawns.bySubcommand["ls-files"] ?? 0,
          gitPathListMisses,
          spawnObserverMisses: observerMisses,
        },
        notes:
          gitPathListMisses > 0
            ? "the cold open was served warm or by the filesystem walker — these are not git ls-files timings"
            : undefined,
      };
    },
  },
  {
    id: "PERF-197",
    name: "File Picker Return After Pause - Cache Lifecycle",
    description:
      "Does an idle picker session pay a second cold load? Primes the real FileSearchService, moves " +
      "the cache's clock past the 10s TTL this replaced with no filesystem change, and searches " +
      "again: coldReloads counts `git ls-files` spawns across that keystroke and must be 0. The " +
      "second arm is the oracle in the other direction — a tracked path is added and the real " +
      "FileSearchCacheInvalidator is driven with an advanced workingTreeChangedAt, after which the " +
      "reload MUST happen and MUST surface the new path. Idle time is simulated by offsetting " +
      "Date.now(), which is what the cache reads; every reported duration is real performance.now() " +
      "elapsed. NOT in the bracket, and not claimable from it: the filesystem watch itself, its " +
      "250-800ms debounce, and the utility-process hop that carries the snapshot to main.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 4, ci: 8, nightly: 12 },
    warmups: 1,
    correctness: ["pauseMisses", "changeMisses", "spawnObserverMisses"],
    async run() {
      const fixture = getFileSearchFixture();
      const { fileSearchService } = await loadFileSearchModule();
      const { fileSearchCacheInvalidator } = await loadFileSearchInvalidationModule();
      const search: SearchFn = (payload) => fileSearchService.search(payload);
      const invalidate = (cwd: string): void => fileSearchService.invalidate(cwd);
      const repo = fixture.representative;

      installGitSpawnCounter();
      const observerMisses = spawnObserverMisses();

      const start = performance.now();

      // Arm 1 — unchanged worktree, returned to after a pause.
      await primeCache(search, invalidate, repo);
      const pauseMark = gitSpawnMark();
      const pauseStart = performance.now();
      const pauseResults = await withClockOffsetAsync(OLD_TTL_PAUSE_MS, () =>
        search({ cwd: repo.path, query: GIT_ONLY_SENTINEL, limit: 50 })
      );
      const returnKeystrokeMs = performance.now() - pauseStart;
      const coldReloads = gitSpawnsSince(pauseMark).bySubcommand["ls-files"] ?? 0;

      // Arm 2 — the same pause, but the worktree actually changed. A unique
      // path per iteration, so "found it" cannot be satisfied by a leftover,
      // and removed again so the shared fixture's corpus stays fixed.
      const addedPath = `src/services/PerfReturnProbe${nextFilesChangedStamp()}.ts`;
      let changedResults: string[] = [];
      let changedKeystrokeMs = 0;
      let changedColdReloads = 0;
      await primeCache(search, invalidate, repo);
      addTrackedPath(repo, addedPath);
      try {
        fileSearchCacheInvalidator.handleWorktreeUpdate(
          {
            path: repo.path,
            workingTreeChangedAt: nextFilesChangedStamp(),
            isCurrent: true,
            generation: PERF_MONITOR_GENERATION,
          },
          { projectPath: repo.path, hostEpoch: PERF_HOST_EPOCH }
        );
        const changedMark = gitSpawnMark();
        const changedStart = performance.now();
        changedResults = await search({ cwd: repo.path, query: addedPath, limit: 50 });
        changedKeystrokeMs = performance.now() - changedStart;
        changedColdReloads = gitSpawnsSince(changedMark).bySubcommand["ls-files"] ?? 0;
      } finally {
        removeTrackedPath(repo, addedPath);
        fileSearchService.invalidate(repo.path);
      }

      const durationMs = performance.now() - start;

      // Correctness here is "did the subject do its work", NOT "was it fast".
      // `coldReloads` is the performance claim and lives in budgets.json — a
      // build that reloads is slower, not broken, and grading it here would make
      // the unit-suite liveness guard reject a valid measurement.
      //
      // What IS graded: the paused search answered, and answered from the git
      // listing. The sentinel is a path only `git ls-files` can return, so a
      // silent fall back to the filesystem walker — which is cheaper than the
      // path this scenario claims to time — cannot pass.
      const pauseMisses = pauseResults.includes(GIT_ONLY_SENTINEL) ? 0 : 1;
      // The oracle in the other direction: a cache that never invalidates gets
      // a perfect `coldReloads` of 0, and this is what stops that from reading
      // as success.
      const changeMisses =
        (changedColdReloads === 1 ? 0 : 1) + (changedResults.includes(addedPath) ? 0 : 1);

      return {
        durationMs,
        metrics: {
          coldReloads,
          returnKeystrokeMs,
          changedColdReloads,
          changedKeystrokeMs,
          pausedMs: OLD_TTL_PAUSE_MS,
          fileCount: repo.fileCount,
          pauseMisses,
          changeMisses,
          spawnObserverMisses: observerMisses,
        },
        notes:
          changeMisses > 0
            ? "the changed worktree did not reload or did not surface the new path — the unchanged arm's 0 proves nothing"
            : undefined,
      };
    },
  },
  {
    id: "PERF-198",
    name: "File Search Expired Index Retention",
    description:
      "Holds a full cache — 30 distinct worktrees, ~3,200 tracked paths each — then expires it and " +
      "sweeps, reporting the heap the indexes were still holding. `Cache.get` only drops the key it " +
      "was asked for and `set` only evicts past maxSize, so before the sweep existed an expired " +
      "entry's files, normalizedFiles, basenameStarts and sorted copy stayed resident until " +
      "something happened to read that exact cwd again. Expiry is simulated by offsetting Date.now() " +
      "past the TTL; the sweep is the shipped timer body, not a copy. Heap readings are " +
      "machine-dependent and taken after a forced GC — a signal about what the cache releases, never " +
      "a claim about the app's total footprint.",
    tier: "heavy",
    modes: ["ci", "nightly"],
    iterations: { ci: 3, nightly: 5 },
    warmups: 0,
    correctness: ["retentionMisses"],
    async run() {
      const repos = getFileSearchRetentionRepos();
      const { fileSearchService } = await loadFileSearchModule();

      // Warm the service's own one-off state — the lazily built Intl.Collator,
      // the hardened-git client, the fallback-walker module graph — BEFORE the
      // control reading, then throw the index away. Those allocations happen
      // once per process, so leaving them until after the control would charge
      // the first iteration's retained delta for them and make it incomparable
      // with every later one.
      await fileSearchService.search({ cwd: repos[0]!.path, query: "", limit: 50 });
      fileSearchService.dispose();

      const start = performance.now();

      await collectAndSettle();
      const controlUsage = process.memoryUsage();
      const controlHeapBytes = controlUsage.heapUsed;
      const controlArrayBufferBytes = controlUsage.arrayBuffers;

      // Thirty entries each holding a handful of paths would satisfy every count
      // check below while measuring almost no memory and still reporting a
      // perfectly healthy predicate, so each index has to prove it is carrying a
      // real corpus rather than merely existing.
      let degenerateIndexCount = 0;
      let smallestListing = Number.POSITIVE_INFINITY;
      for (const repo of repos) {
        // Two shapes per worktree so the optional allocations an entry can grow
        // — the sorted copy behind an empty query, the candidate index list —
        // are represented in what is being held.
        const listed = await fileSearchService.search({
          cwd: repo.path,
          query: "",
          limit: FULL_LISTING_LIMIT,
        });
        const matched = await fileSearchService.search({
          cwd: repo.path,
          query: "terminal",
          limit: 50,
        });
        smallestListing = Math.min(smallestListing, listed.length);
        if (listed.length < FULL_LISTING_LIMIT || matched.length === 0) degenerateIndexCount += 1;
      }

      const cachedIndexCountBeforeSweep = fileSearchService.getCacheStats().size;

      await collectAndSettle();
      const primedUsage = process.memoryUsage();
      const primedHeapBytes = primedUsage.heapUsed - controlHeapBytes;
      const primedArrayBufferBytes = primedUsage.arrayBuffers - controlArrayBufferBytes;

      // Past the TTL, then the shipped sweep body. Both inside the offset: the
      // sweep's own expiry test reads the same clock.
      await withClockOffsetAsync(PAST_TTL_OFFSET_MS, async () => {
        fileSearchService.sweep();
        await settle();
      });

      const cachedIndexCountAfterSweep = fileSearchService.getCacheStats().size;

      await collectAndSettle();
      const retainedUsage = process.memoryUsage();
      const retainedHeapBytes = retainedUsage.heapUsed - controlHeapBytes;
      const retainedArrayBufferBytes = retainedUsage.arrayBuffers - controlArrayBufferBytes;

      const durationMs = performance.now() - start;

      // Every way this measurement can be vacuous, counted: a fleet that never
      // filled, a listing that came back empty, a corpus far smaller than the
      // one the scenario claims to hold, a sweep that left entries behind, and a
      // run with no GC hook (where two uncollected heaps would difference to a
      // flattering number).
      const retentionMisses =
        (cachedIndexCountBeforeSweep === RETENTION_REPO_COUNT ? 0 : 1) +
        (cachedIndexCountAfterSweep === 0 ? 0 : 1) +
        degenerateIndexCount +
        (gcAvailable() ? 0 : 1);

      return {
        durationMs,
        metrics: {
          primedWorktreeCount: repos.length,
          smallestListingPaths: smallestListing,
          cachedIndexCountBeforeSweep,
          cachedIndexCountAfterSweep,
          primedHeapMb: primedHeapBytes / (1024 * 1024),
          retainedHeapMb: retainedHeapBytes / (1024 * 1024),
          freedHeapMb: (primedHeapBytes - retainedHeapBytes) / (1024 * 1024),
          // basenameStarts is an Int32Array, so its backing store lives outside
          // heapUsed. Reported separately rather than folded in, because a
          // reader comparing only heapUsed would under-count what an entry
          // actually holds.
          primedArrayBufferMb: primedArrayBufferBytes / (1024 * 1024),
          retainedArrayBufferMb: retainedArrayBufferBytes / (1024 * 1024),
          retentionMisses,
        },
        notes:
          retentionMisses > 0
            ? "the fleet never filled, an index held no real corpus, the sweep left entries, or no GC hook was available — these heap deltas are not a retention reading"
            : undefined,
      };
    },
  },
];
