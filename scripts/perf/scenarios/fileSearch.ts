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
  getFileSearchFixture,
  GIT_ONLY_SENTINEL,
  loadFileSearchModule,
  NO_MATCH_QUERY,
  TYPED_FILE_QUERIES,
  type FileSearchRepo,
} from "../lib/fileSearchFixture";

// File picker — the `@`-mention completion and the file palette, both served by
// the real FileSearchService. Two costs the user feels, measured separately
// because they have different fixes:
//
//   * COLD (PERF-192): with no cached path list, the first keystroke pays for
//     `git ls-files` plus the directory-set build and sort. Nothing renders
//     until it resolves, so this IS the picker's open latency. The list is
//     rebuilt whenever its 10s TTL lapses, and dropped outright when a worktree
//     is created or deleted, so a working session pays it repeatedly.
//   * WARM (PERF-190/191): every subsequent keystroke re-scans the whole cached
//     list through `scorePath` and re-heaps the top 50. This is the typing
//     latency, and it scales linearly with repo size.
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
];
