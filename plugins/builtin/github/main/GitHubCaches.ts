import type { GraphQlQueryResponseData } from "@octokit/graphql";
import { Cache } from "../../../../electron/utils/cache.js";
import { GitHubFirstPageCache } from "../../../../electron/services/GitHubFirstPageCache.js";
import { GitHubStatsCache } from "../../../../electron/services/GitHubStatsCache.js";
import type {
  GitHubIssue,
  GitHubPR,
  GitHubPRCIStatus,
  GitHubPRCISummary,
  GitHubListResponse,
  IssueTooltipData,
  PRTooltipData,
} from "../../../../shared/types/github.js";
import type { RepoContext, RepoStats, RepoStatsAndPageSnapshot } from "./types.js";

export const repoContextCache = new Cache<string, RepoContext>({ defaultTTL: 300000 });
export const repoStatsCache = new Cache<string, RepoStats>({ defaultTTL: 60000 });
export const issueListCache = new Cache<string, GitHubListResponse<GitHubIssue>>({
  defaultTTL: 60000,
});
export const prListCache = new Cache<string, GitHubListResponse<GitHubPR>>({ defaultTTL: 60000 });
export const projectHealthCache = new Cache<string, unknown>({ defaultTTL: 60000 });
export const issueTooltipWrittenAt = new Map<string, number>();
export const issueTooltipCache = new Cache<string, IssueTooltipData>({
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
  defaultTTL: FOUR_HOURS_MS,
});

/**
 * Last full `getRepoStatsAndPage` network result per repo. Returned when the
 * activity probe confirms nothing changed. 10-minute TTL bounds worst-case
 * staleness if the probe ever fails to detect a change.
 */
export const repoStatsAndPageSnapshotCache = new Cache<string, RepoStatsAndPageSnapshot>({
  defaultTTL: TEN_MINUTES_MS,
});

export const prTooltipWrittenAt = new Map<string, number>();
export const prTooltipCache = new Cache<string, PRTooltipData>({
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

export interface PRRequiredStatusEntry {
  ciStatus: GitHubPRCIStatus | undefined;
  ciSummary: GitHubPRCISummary | undefined;
}
export const MAX_REVIEW_THREAD_PAGES = 5;
export const REVIEW_THREADS_PER_PAGE = 100;

export const reviewThreadsCache = new Cache<string, Record<string, number>>({
  defaultTTL: 300000,
});

export const prRequiredStatusCache = new Cache<string, PRRequiredStatusEntry>({
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
  defaultTTL: 60000,
});

/**
 * In-flight singleflight map for forge GraphQL queries. Concurrent callers with
 * an identical key join the same pending promise instead of issuing duplicate
 * network requests. Entries are evicted on settlement by `runQuery`.
 */
export const forgeQueryInflight = new Map<string, Promise<GraphQlQueryResponseData>>();

export function clearGitHubCaches(): void {
  etagCacheVersion++;
  repoContextCache.clear();
  repoStatsCache.clear();
  projectHealthCache.clear();
  velocityCache.clear();
  repoStatsAndPageSnapshotCache.clear();
  repoEventsETagCache.clear();
  repoEventsPollIntervalCache.clear();
  repoEventsNoChangeCount.clear();
  repoEventsLastProbeAt.clear();
  issueListCache.clear();
  prListCache.clear();
  issueTooltipCache.clear();
  issueTooltipWrittenAt.clear();
  prTooltipCache.clear();
  prTooltipWrittenAt.clear();
  prETagCache.clear();
  branchListETagCache.clear();
  repoPRListETagCache.clear();
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

export function truncateBody(body: string | null | undefined, maxLength = 150): string {
  if (!body) return "";
  const cleaned = body.replace(/\r?\n/g, " ").trim();
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.slice(0, maxLength).trim() + "…";
}

export function clearPRCaches(): void {
  etagCacheVersion++;
  prListCache.clear();
  // The snapshot embeds the first-page PR list and the probe gates whether it
  // is served — both can resurface a stale PR list after a refresh, so they
  // must drop with the PR caches. `velocityCache` is repo-level metadata on a
  // days timescale, not PR-list state, so it deliberately survives here.
  repoStatsAndPageSnapshotCache.clear();
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
  reviewThreadsCache.clear();
  prRequiredStatusCache.clear();
  // PR queries (GET_PR, LIST_PRS, PR CI status, batch-branch) all flow through
  // forgeProvider.runQuery, so a manual PR refresh must drop their forge cache
  // entries too or it would serve stale state for up to the 60s TTL.
  forgeQueryCache.clear();
  forgeQueryInflight.clear();
}
