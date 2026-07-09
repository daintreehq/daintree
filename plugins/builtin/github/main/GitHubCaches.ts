import type { GraphQlQueryResponseData } from "@octokit/graphql";
import { Cache } from "../../../../electron/utils/cache.js";
import { GitHubFirstPageCache } from "./GitHubFirstPageCache.js";
import { GitHubStatsCache } from "./GitHubStatsCache.js";
import type {
  GitHubIssue,
  GitHubPR,
  GitHubPRCIStatus,
  GitHubPRCISummary,
  GitHubListResponse,
} from "../shared/types.js";
import type {
  RepoContext,
  RepoStats,
  RepoStatsAndPageSnapshot,
  RestCountsSnapshot,
} from "./types.js";
import type {
  Issue,
  IssueTooltipData,
  PR,
  PRTooltipData,
  Page,
} from "../../../../shared/types/forge.js";

export const repoContextCache = new Cache<string, RepoContext>({ maxSize: 20, defaultTTL: 300000 });
export const repoStatsCache = new Cache<string, RepoStats>({ maxSize: 20, defaultTTL: 60000 });
export const issueListCache = new Cache<string, GitHubListResponse<GitHubIssue>>({
  maxSize: 50,
  defaultTTL: 60000,
});
export const prListCache = new Cache<string, GitHubListResponse<GitHubPR>>({
  maxSize: 50,
  defaultTTL: 60000,
});

/**
 * Forge-shaped list caches. The forge provider returns `Page<Issue>` /
 * `Page<PR>` (normalized), which is a different shape from the legacy
 * `GitHubListResponse` held by {@link issueListCache} / {@link prListCache} —
 * so the forge path needs its own 60s caches rather than sharing them. Cleared
 * alongside the legacy list caches in {@link clearGitHubCaches} /
 * {@link clearPRCaches}.
 */
export const forgeIssueListCache = new Cache<string, Page<Issue>>({
  maxSize: 50,
  defaultTTL: 60000,
});
export const forgePRListCache = new Cache<string, Page<PR>>({ maxSize: 50, defaultTTL: 60000 });

export const projectHealthCache = new Cache<string, unknown>({ maxSize: 20, defaultTTL: 60000 });
export const issueTooltipWrittenAt = new Map<string, number>();
export const issueTooltipCache = new Cache<string, IssueTooltipData>({
  maxSize: 200,
  defaultTTL: 300000,
  onEvict: (key) => {
    issueTooltipWrittenAt.delete(key as string);
  },
});

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;

/**
 * Merged-PR velocity counts (60/120/180-day windows). Keyed by repo + UTC date
 * so a new day forces a recompute even within the 4h TTL — the velocity
 * windows are anchored to "now", so yesterday's cache would use stale date
 * boundaries. See `buildVelocityCacheKey` in `GitHubHealth.ts`.
 */
export const velocityCache = new Cache<string, Record<60 | 120 | 180, number>>({
  maxSize: 20,
  defaultTTL: FOUR_HOURS_MS,
});

/**
 * Last full `getRepoStatsAndPage` network result per repo. Returned when the
 * activity probe confirms nothing changed. 10-minute TTL bounds worst-case
 * staleness if the probe ever fails to detect a change.
 */
export const repoStatsAndPageSnapshotCache = new Cache<string, RepoStatsAndPageSnapshot>({
  maxSize: 50,
  defaultTTL: TEN_MINUTES_MS,
});

export const prTooltipWrittenAt = new Map<string, number>();
export const prTooltipCache = new Cache<string, PRTooltipData>({
  maxSize: 200,
  defaultTTL: 300000,
  onEvict: (key) => {
    prTooltipWrittenAt.delete(key as string);
  },
});

const ETAG_CACHE_MAX_SIZE = 500;
const ETAG_CACHE_TTL = 3_600_000; // 1 hour

export const prETagCache = new Cache<string, string>({
  maxSize: ETAG_CACHE_MAX_SIZE,
  defaultTTL: ETAG_CACHE_TTL,
});
export const branchListETagCache = new Cache<string, string>({
  maxSize: ETAG_CACHE_MAX_SIZE,
  defaultTTL: ETAG_CACHE_TTL,
});

/**
 * Repo-level ETag for `GET /repos/{owner}/{repo}/pulls?per_page=1&state=all&...`.
 * `batchCheckLinkedPRs` sends it as a conditional request before any per-PR or
 * per-branch probing — a `304` means no PR in the repo changed, so the whole
 * batch (including GraphQL) is skipped at zero rate-limit cost. Keyed by
 * `${owner}/${repo}`; 1-hour TTL matches the other ETag caches.
 */
export const repoPRListETagCache = new Cache<string, string>({
  maxSize: ETAG_CACHE_MAX_SIZE,
  defaultTTL: ETAG_CACHE_TTL,
});

/**
 * Repo-level ETag for `GET /repos/{owner}/{repo}/pulls?state=open&per_page=100`,
 * keyed `${owner}/${repo}`. The steady-state PR revalidation probe
 * (`probeOpenPRList` in `GitHubPRDiscovery.ts`) sends it as `If-None-Match`; an
 * authenticated `304` means no open PR on page 1 changed, so the GraphQL
 * revalidation fan-out is skipped at zero rate-limit cost. Distinct from
 * {@link repoPRListETagCache} (which probes `per_page=1&state=all` for the
 * detection path) — the URL, and therefore the ETag, differs, so sharing one
 * cache would cross-contaminate the two probes' baselines. 1-hour TTL matches
 * the other ETag caches.
 */
export const openPRListETagCache = new Cache<string, string>({
  maxSize: ETAG_CACHE_MAX_SIZE,
  defaultTTL: ETAG_CACHE_TTL,
});

/**
 * Counts + ETags from the last successful `fetchRestCounts` (the cheap REST
 * count poll behind the toolbar pill, issue #10122), keyed by `owner/repo`.
 * One atomic entry rather than separate ETag caches: a `304` on either REST
 * leg is only servable when the count that ETag validated is still on hand,
 * and a mixed `304`/`200` pair must read both fallback values from the same
 * baseline. Written only after both legs produce valid counts (#9440 commit
 * discipline) — a failed fetch never advances the ETags. 1-hour TTL matches
 * the other ETag caches; on expiry both legs simply refetch unconditionally.
 */
export const restCountsCache = new Cache<string, RestCountsSnapshot>({
  maxSize: ETAG_CACHE_MAX_SIZE,
  defaultTTL: ETAG_CACHE_TTL,
});

/**
 * ETag for the repo's REST `/events` feed, keyed by `owner/repo`. The activity
 * probe sends it back as `If-None-Match`; an authenticated `304 Not Modified`
 * costs zero rate-limit quota, which is the whole point of polling here instead
 * of the GraphQL stats query. A cleared ETag forces a fresh `200` that
 * re-establishes the baseline, so this is correctness state and drops with the
 * other PR caches on a manual refresh.
 */
export const repoEventsETagCache = new Cache<string, string>({
  maxSize: ETAG_CACHE_MAX_SIZE,
  defaultTTL: ETAG_CACHE_TTL,
});

/**
 * Server-advertised `X-Poll-Interval` (ms) for the events feed, keyed by
 * `owner/repo`. GitHub raises this under load and it is the floor for the
 * adaptive probe cadence. Rate-shaping state, not correctness — it is not a
 * plain TTL cache because a stale interval is harmless (it just defaults back
 * to 60s) and we never want it evicted mid-backoff.
 */
export const repoEventsPollIntervalCache = new Map<string, number>();

/**
 * Count of consecutive no-change (`304`) probes, keyed by `owner/repo`. Drives
 * the adaptive backoff multiplier; reset to 0 on any real event (`200`) or a
 * manual refresh so the cadence snaps back to the poll-interval floor.
 */
export const repoEventsNoChangeCount = new Map<string, number>();

/**
 * Wall-clock ms of the last `/events` probe HTTP request, keyed by `owner/repo`.
 * The gate skips probing (and reuses the snapshot) while inside the adaptive
 * window so we never poll the events feed faster than `X-Poll-Interval`.
 */
export const repoEventsLastProbeAt = new Map<string, number>();

let etagCacheVersion = 0;

export function getETagCacheVersion(): number {
  return etagCacheVersion;
}

/**
 * Invalidate the ETag baselines of any in-flight conditional fetch. Bumped by
 * the cache-clear paths below and by `updateRepoStatsCount` when a list
 * query's observed total disagrees with a stored count baseline — without the
 * bump, a `fetchRestCounts` already past its cache read could 304-recommit
 * the just-invalidated counts and resurrect the stale value.
 */
export function bumpETagCacheVersion(): void {
  etagCacheVersion++;
}

/**
 * Per-repo, per-type list-cache epochs for the count-as-cache-buster
 * (#10122 family). Bumped by {@link invalidateRepoListCachesForCountChange}
 * when the cheap REST count poll observes a changed open count. List fetchers
 * capture the epoch before their network call and skip the shared-cache write
 * when it moved — without this, a list query already in flight when the count
 * delta lands would repopulate the just-busted cache with a page fetched
 * before the change, pinning it for the full 60s TTL.
 *
 * Deliberately separate from `etagCacheVersion`: that guards REST/event ETag
 * commit baselines in `fetchRestCounts`, and bumping it here would discard
 * unrelated in-flight count commits.
 *
 * Keyed `${type}:${owner}/${repo}`. A plain Map (not a TTL cache): entries are
 * one integer per repo the session has polled, and an epoch must never be
 * evicted mid-flight or the guard would compare against a fresh zero.
 */
const repoListCacheEpochs = new Map<string, number>();

export function getRepoListEpoch(type: "issue" | "pr", owner: string, repo: string): number {
  return repoListCacheEpochs.get(`${type}:${owner}/${repo}`) ?? 0;
}

function bumpRepoListEpoch(type: "issue" | "pr", owner: string, repo: string): void {
  const key = `${type}:${owner}/${repo}`;
  repoListCacheEpochs.set(key, (repoListCacheEpochs.get(key) ?? 0) + 1);
}

/** Drop every entry whose key starts with `prefix`. `Cache.forEach` snapshots
 *  entries up front, so invalidating inside the walk is safe. */
function invalidateByPrefix(cache: Cache<string, unknown>, prefix: string): void {
  const keys: string[] = [];
  cache.forEach((_value, key) => {
    if (key.startsWith(prefix)) keys.push(key);
  });
  for (const key of keys) cache.invalidate(key);
}

/**
 * Count-as-cache-buster: the cheap REST count poll observed a different open
 * count, so every cached list page for the changed type is provably stale —
 * drop it (zero network; the next read refetches) and bump the type's epoch so
 * in-flight list queries can't write a pre-change page back.
 *
 * Per-type on purpose: issue churn must not evict PR pages (and vice versa) —
 * busting both on any delta would double the refetch volume on active repos.
 * The combined stats-and-page snapshot embeds BOTH first pages, so any delta
 * drops it; same for the legacy-shaped list caches that `GitHubIssues.listIssues`
 * / `GitHubPRs.listPullRequests` still read alongside the forge caches.
 *
 * List keys are `${type}:${owner}/${repo}:${state}:${search}:${sort}:${cursor}`
 * (see `buildListCacheKey`), so the repo prefix sweeps every state/sort/cursor
 * variant — a close/merge/reopen changes the closed and all views too.
 */
export function invalidateRepoListCachesForCountChange(
  owner: string,
  repo: string,
  changed: { issues: boolean; prs: boolean }
): void {
  if (!changed.issues && !changed.prs) return;
  if (changed.issues) {
    const prefix = `issue:${owner}/${repo}:`;
    invalidateByPrefix(forgeIssueListCache as Cache<string, unknown>, prefix);
    invalidateByPrefix(issueListCache as Cache<string, unknown>, prefix);
    bumpRepoListEpoch("issue", owner, repo);
  }
  if (changed.prs) {
    const prefix = `pr:${owner}/${repo}:`;
    invalidateByPrefix(forgePRListCache as Cache<string, unknown>, prefix);
    invalidateByPrefix(prListCache as Cache<string, unknown>, prefix);
    bumpRepoListEpoch("pr", owner, repo);
  }
  repoStatsAndPageSnapshotCache.invalidate(`${owner}/${repo}`);
}

export interface PRRequiredStatusEntry {
  ciStatus: GitHubPRCIStatus | undefined;
  ciSummary: GitHubPRCISummary | undefined;
}
export const MAX_REVIEW_THREAD_PAGES = 5;
export const REVIEW_THREADS_PER_PAGE = 100;

export const REVIEW_THREADS_TTL_MS = 300000;

export const reviewThreadsCache = new Cache<string, Record<string, number>>({
  maxSize: 200,
  defaultTTL: REVIEW_THREADS_TTL_MS,
});

export const prRequiredStatusCache = new Cache<string, PRRequiredStatusEntry>({
  maxSize: 200,
  defaultTTL: 60000,
});

/**
 * Response cache for raw forge GraphQL queries, keyed by query + serialized
 * variables. Restores the 60s TTL the legacy GitHub service layer had before
 * the CodeForge migration moved all queries through `forgeProvider.runQuery`.
 * Lives here (not in `forgeProvider.ts`) so `clearGitHubCaches()` drops it
 * atomically with the other caches on a token or settings change.
 */
export const forgeQueryCache = new Cache<string, GraphQlQueryResponseData>({
  maxSize: 200,
  defaultTTL: 60000,
});

/**
 * In-flight singleflight map for forge GraphQL queries. Concurrent callers with
 * an identical key join the same pending promise instead of issuing duplicate
 * network requests. Entries are evicted on settlement by `runQuery`.
 */
export const forgeQueryInflight = new Map<string, Promise<GraphQlQueryResponseData>>();

/**
 * Write a PR tooltip entry behind the ownership-token guard. A later write only
 * wins if its `requestedAt` is at least as recent as the last recorded write,
 * so a slow in-flight response can't clobber a fresher one. Shared by every
 * path that pre-warms the tooltip cache (`getPRTooltip`, the branch-PR batch in
 * `GitHubPRDiscovery`, and the forge provider's `findPRsByBranches`).
 */
export function writePRTooltip(
  owner: string,
  repo: string,
  prNumber: number,
  tooltipData: PRTooltipData,
  requestedAt: number
): void {
  const cacheKey = `${owner}/${repo}:${prNumber}`;
  const existing = prTooltipWrittenAt.get(cacheKey);
  if (existing === undefined || requestedAt >= existing) {
    prTooltipCache.set(cacheKey, tooltipData);
    prTooltipWrittenAt.set(cacheKey, requestedAt);
  }
}

const CACHE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * The data caches evict expired entries lazily (on `get()`) and by LRU at
 * `maxSize`, so a cache that stops being read can pin expired entries
 * indefinitely. This sweep proactively drops them. Owned by the plugin's
 * `activate()` lifecycle: started on activation, cleared by `stopCacheSweep`
 * in the returned disposer. `.unref()` so it never keeps the process alive.
 */
let cacheSweepTimer: ReturnType<typeof setInterval> | null = null;

export function startCacheSweep(): void {
  if (cacheSweepTimer !== null) return;
  cacheSweepTimer = setInterval(() => {
    forgeIssueListCache.cleanup();
    forgePRListCache.cleanup();
    repoStatsAndPageSnapshotCache.cleanup();
    issueTooltipCache.cleanup();
    prTooltipCache.cleanup();
    forgeQueryCache.cleanup();
    prRequiredStatusCache.cleanup();
  }, CACHE_SWEEP_INTERVAL_MS);
  cacheSweepTimer.unref?.();
}

export function stopCacheSweep(): void {
  if (cacheSweepTimer !== null) {
    clearInterval(cacheSweepTimer);
    cacheSweepTimer = null;
  }
}

export function clearGitHubCaches(): void {
  etagCacheVersion++;
  repoContextCache.clear();
  repoStatsCache.clear();
  projectHealthCache.clear();
  velocityCache.clear();
  repoStatsAndPageSnapshotCache.clear();
  restCountsCache.clear();
  repoEventsETagCache.clear();
  repoEventsPollIntervalCache.clear();
  repoEventsNoChangeCount.clear();
  repoEventsLastProbeAt.clear();
  issueListCache.clear();
  prListCache.clear();
  forgeIssueListCache.clear();
  forgePRListCache.clear();
  issueTooltipCache.clear();
  issueTooltipWrittenAt.clear();
  prTooltipCache.clear();
  prTooltipWrittenAt.clear();
  prETagCache.clear();
  branchListETagCache.clear();
  repoPRListETagCache.clear();
  openPRListETagCache.clear();
  reviewThreadsCache.clear();
  prRequiredStatusCache.clear();
  forgeQueryCache.clear();
  forgeQueryInflight.clear();
  GitHubFirstPageCache.getInstance().clear();
  GitHubStatsCache.getInstance().clear();
}

/** Test-only reset for the forge query cache + in-flight map. */
export function _resetForgeQueryCachesForTests(): void {
  forgeQueryCache.clear();
  forgeQueryInflight.clear();
}

/**
 * ISO timestamp → epoch milliseconds for the forge tooltip shapes. `0` for
 * missing/unparseable values — mirrors `isoToMs` in `forgeProvider.ts`.
 */
export function isoToEpochMs(value: unknown): number {
  if (typeof value !== "string") return 0;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

export function truncateBody(body: string | null | undefined, maxLength = 150): string {
  if (!body) return "";
  const cleaned = body.replace(/\r?\n/g, " ").trim();
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.slice(0, maxLength).trim() + "…";
}

export function clearPRCaches(): void {
  etagCacheVersion++;
  prListCache.clear();
  forgePRListCache.clear();
  // The snapshot embeds the first-page PR list and the probe gates whether it
  // is served — both can resurface a stale PR list after a refresh, so they
  // must drop with the PR caches. `velocityCache` is repo-level metadata on a
  // days timescale, not PR-list state, so it deliberately survives here.
  repoStatsAndPageSnapshotCache.clear();
  // The REST count snapshot embeds the open-PR count and the ETag baselines it
  // was observed under — a manual refresh must force the next count poll to a
  // fresh `200` rather than serving the pre-refresh counts on a `304`.
  restCountsCache.clear();
  // The events ETag is correctness state: a cleared ETag forces a fresh `200`
  // so the next probe re-checks from scratch. The no-change counter and last
  // probe time are reset too — a manual refresh is exactly the "window focus"
  // signal that should snap the adaptive backoff cadence back to its floor.
  // The poll-interval hint survives; it is a server-advertised value, not
  // PR-list state.
  repoEventsETagCache.clear();
  repoEventsNoChangeCount.clear();
  repoEventsLastProbeAt.clear();
  prTooltipCache.clear();
  prTooltipWrittenAt.clear();
  prETagCache.clear();
  branchListETagCache.clear();
  repoPRListETagCache.clear();
  openPRListETagCache.clear();
  reviewThreadsCache.clear();
  prRequiredStatusCache.clear();
  // PR queries (GET_PR, LIST_PRS, PR CI status, batch-branch) all flow through
  // forgeProvider.runQuery, so a manual PR refresh must drop their forge cache
  // entries too or it would serve stale state for up to the 60s TTL.
  forgeQueryCache.clear();
  forgeQueryInflight.clear();
}
