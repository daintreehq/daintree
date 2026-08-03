import fs from "fs/promises";
import path from "path";
import type { GraphQlQueryResponseData } from "@octokit/graphql";
import { GitHubAuth, GITHUB_API_TIMEOUT_MS, rateLimitAwareFetch } from "./GitHubAuth.js";
import { REPO_STATS_AND_PAGE_QUERY } from "./GitHubQueries.js";
import { gitHubRateLimitService } from "./GitHubRateLimitService.js";
import { rateLimitMessage } from "./GitHubErrors.js";
import { parseGitHubError } from "./GitHubErrors.js";
import { getRepoContext, isRepoNotFoundError } from "./GitHubRepoContext.js";
import {
  repoContextCache,
  repoStatsCache,
  issueListCache,
  prListCache,
  repoStatsAndPageSnapshotCache,
  restCountsCache,
  repoEventsETagCache,
  repoEventsPollIntervalCache,
  repoEventsNoChangeCount,
  repoEventsLastProbeAt,
  getETagCacheVersion,
  getRepoListEpoch,
  invalidateRepoListCachesForCountChange,
} from "./GitHubCaches.js";
import { GitHubStatsCache } from "./GitHubStatsCache.js";
import { GitHubFirstPageCache } from "./GitHubFirstPageCache.js";
import type { RepoContext, RepoStats, RestCountsSnapshot } from "./types.js";
import type {
  GitHubIssue,
  GitHubPR,
  RepositoryStats,
  GitHubFirstPageCachePayload,
} from "../shared/types.js";
import { parseIssueNode } from "./GitHubIssues.js";
import { parsePRNode, buildListCacheKey, DEFAULT_LIST_PER_PAGE } from "./GitHubPRs.js";

export interface RepoStatsAndPageResult {
  stats: RepoStats | null;
  issues: {
    items: GitHubIssue[];
    endCursor: string | null;
    hasNextPage: boolean;
    totalCount: number;
  } | null;
  prs: {
    items: GitHubPR[];
    endCursor: string | null;
    hasNextPage: boolean;
    totalCount: number;
  } | null;
  source?: "network" | "memory-cache";
  /**
   * Adaptive delay (ms) until the next background poll, from
   * {@link eventsProbeDelayMs} — ~60s while changes land, growing toward ~5min
   * when idle (issue #9741). Set on every successful stats return so the
   * renderer's visible-poll scheduler can match the probe cadence; omitted on
   * error / disk-fallback paths where the renderer applies its own backoff.
   */
  nextPollIntervalMs?: number;
  error?: string;
}

/** Default `X-Poll-Interval` floor (ms) when the events feed hasn't advertised one. */
const DEFAULT_EVENTS_POLL_INTERVAL_MS = 60_000;

/**
 * Consecutive no-change (`304`) probes required before the adaptive backoff
 * engages. Below this the cadence stays pinned to the poll-interval floor; the
 * hysteresis prevents a single quiet poll from oscillating the interval. See
 * issue #4629 for the same engage-after-N pattern in `GitHubRateLimitService`.
 */
const EVENTS_BACKOFF_ENGAGE_THRESHOLD = 2;

/** Per-no-change growth factor and ceiling (×floor) for the probe cadence. */
const EVENTS_BACKOFF_GROWTH = 1.5;
const EVENTS_BACKOFF_MAX_FACTOR = 5;

/**
 * Adaptive cadence (ms) for the REST events probe. The floor is the
 * server-advertised `X-Poll-Interval` (default 60s, raised by GitHub under
 * load). Once at least {@link EVENTS_BACKOFF_ENGAGE_THRESHOLD} consecutive
 * no-change polls have accrued, the interval grows by
 * {@link EVENTS_BACKOFF_GROWTH}× per extra no-change poll, capped at
 * {@link EVENTS_BACKOFF_MAX_FACTOR}× the floor — so an idle repo is probed
 * progressively less often. A real event (`200`) or a manual refresh resets the
 * counter, snapping the cadence back to the floor.
 */
function eventsProbeDelayMs(cacheKey: string): number {
  const floor = repoEventsPollIntervalCache.get(cacheKey) ?? DEFAULT_EVENTS_POLL_INTERVAL_MS;
  const noChange = repoEventsNoChangeCount.get(cacheKey) ?? 0;
  if (noChange < EVENTS_BACKOFF_ENGAGE_THRESHOLD) return floor;
  const factor = Math.min(
    EVENTS_BACKOFF_GROWTH ** (noChange - EVENTS_BACKOFF_ENGAGE_THRESHOLD + 1),
    EVENTS_BACKOFF_MAX_FACTOR
  );
  return Math.round(floor * factor);
}

export interface ActivityProbeResult {
  status: "changed" | "unchanged" | "unknown";
  /**
   * The new events-feed ETag observed on a `200` (or `null` when GitHub omitted
   * it). Deliberately NOT written to {@link repoEventsETagCache} here — the
   * caller commits it only after the full stats query succeeds, so a failed
   * fetch can't advance the ETag ahead of the snapshot and mask a real change
   * behind a later `304`. `undefined` on `304`/`unknown` (no ETag to commit).
   */
  etag?: string | null;
  /** True iff the cache version changed mid-request (a concurrent clear). */
  staleVersion?: boolean;
}

/**
 * Conditional GET against the repo's REST `/events` feed to detect whether
 * anything has changed since the last poll. Mirrors the ETag pattern in
 * `GitHubPRDiscovery.ts`: an authenticated `304 Not Modified` costs zero
 * rate-limit quota, so an idle repo can be polled indefinitely without
 * spending the GraphQL budget the old `REPO_ACTIVITY_PROBE_QUERY` consumed.
 *
 * Returns `"unchanged"` on `304`, `"changed"` on `200` (carrying the new ETag
 * for the caller to commit on a successful fetch), and `"unknown"` on any
 * error, rate-limit block, or unexpected status — the probe is a pure
 * optimization, so an inconclusive result must fall through to the full stats
 * query rather than suppress it.
 *
 * Uses the REST `"core"` rate-limit bucket, not `"graphql"`: a depleted GraphQL
 * budget must not gate a REST request that draws from a separate quota.
 * `daintreeSkipRateLimitPreflight` bypasses the wrapper's own unscoped block
 * check (which would trip on `"graphql"` state) since the `"core"` check above
 * is the correct gate for this request.
 */
export async function fetchActivityProbe(
  token: string,
  owner: string,
  repo: string
): Promise<ActivityProbeResult> {
  const cacheKey = `${owner}/${repo}`;

  const block = gitHubRateLimitService.shouldBlockRequest("core");
  if (block.blocked) return { status: "unknown" };

  const cachedETag = repoEventsETagCache.get(cacheKey);
  const versionAtStart = getETagCacheVersion();
  const url = `https://api.github.com/repos/${owner}/${repo}/events?per_page=1`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (cachedETag) {
    headers["If-None-Match"] = cachedETag;
  }

  repoEventsLastProbeAt.set(cacheKey, Date.now());

  try {
    const response = await rateLimitAwareFetch(url, {
      headers,
      signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
      daintreeSkipRateLimitPreflight: true,
    });

    // A concurrent cache clear (token change / manual refresh) invalidates the
    // ETag baseline this request was built on — treat the result as unknown so
    // we don't act on a 304 against a now-cleared ETag.
    if (getETagCacheVersion() !== versionAtStart) {
      return { status: "unknown", staleVersion: true };
    }

    // GitHub advertises (and raises under load) the minimum poll interval on
    // both 200 and 304 responses. Honor it as the backoff floor whenever present.
    const pollIntervalSeconds = parseInt(response.headers.get("x-poll-interval") ?? "", 10);
    if (Number.isFinite(pollIntervalSeconds) && pollIntervalSeconds > 0) {
      repoEventsPollIntervalCache.set(cacheKey, pollIntervalSeconds * 1000);
    }

    if (response.status === 304) {
      repoEventsNoChangeCount.set(cacheKey, (repoEventsNoChangeCount.get(cacheKey) ?? 0) + 1);
      return { status: "unchanged" };
    }
    if (response.status === 200) {
      repoEventsNoChangeCount.set(cacheKey, 0);
      return { status: "changed", etag: response.headers.get("etag") };
    }
    return { status: "unknown" };
  } catch {
    return { status: "unknown" };
  }
}

/**
 * Total result count from a paginated REST response's `Link` header: with
 * `per_page=1`, the `rel="last"` page number IS the total count. Returns
 * `null` when the header is absent (GitHub omits it when everything fits on
 * one page, i.e. 0 or 1 results) or unparseable — callers fall back to the
 * body's array length.
 */
export function parseLinkLastPage(linkHeader: string | null): number | null {
  if (!linkHeader) return null;
  // Split into link-values first: RFC 8288 allows extra parameters between the
  // URL and `rel` (`<url>; type="…"; rel="last"`), so anchoring `rel="last"`
  // directly after `>` would silently miss a reordered header and undercount.
  for (const segment of linkHeader.split(",")) {
    if (!/rel="last"/.test(segment)) continue;
    const match = segment.match(/<[^>]*[?&]page=(\d+)[^>]*>/);
    if (!match) return null;
    const page = parseInt(match[1], 10);
    return Number.isFinite(page) && page >= 0 ? page : null;
  }
  return null;
}

/**
 * Cheap REST replacement for the count half of `REPO_STATS_AND_PAGE_QUERY`
 * (issue #10122): the background toolbar poll needs two scalars, not a full
 * first page with labels, assignees, timeline items, and check rollups.
 *
 * Two parallel conditional GETs, both on the REST `"core"` bucket (separate
 * from the GraphQL budget, zero quota on `304` — same economics as
 * {@link fetchActivityProbe}):
 *
 * - `GET /repos/{owner}/{repo}` → `open_issues_count`, which GitHub defines as
 *   open issues + open PRs combined.
 * - `GET /repos/{owner}/{repo}/pulls?state=open&per_page=1` → total open PR
 *   count from the `Link: rel="last"` page number (or body length when the
 *   header is omitted at 0–1 results).
 *
 * `issueCount` is derived as `combined − prCount`, so both legs must resolve
 * against the same baseline: on success the counts and their ETags are
 * committed as one {@link restCountsCache} entry, and a `304` leg replays the
 * stored value from that entry. Any failure — non-200/304 status, malformed
 * body, a `304` with no stored baseline, a negative derived count from a
 * cross-endpoint race — returns `null` without advancing any ETag (#9440), so
 * the next poll re-detects the change instead of masking it.
 */
export async function fetchRestCounts(
  token: string,
  owner: string,
  repo: string
): Promise<RepoStats | null> {
  // Per-repo singleflight: concurrent polls (multi-window — each
  // `WebContentsView` runs its own poll loop) must not interleave. Two
  // overlapping fetches read the same `prior` baseline, so the slower one can
  // commit a stale `304` replay over the faster one's fresh counts and
  // double-fire the count-buster (the second epoch bump would discard a list
  // fetch that started after the first, forcing a redundant GraphQL refetch).
  const cacheKey = `${owner}/${repo}`;
  const pending = restCountsInflight.get(cacheKey);
  if (pending) return pending;
  const promise = fetchRestCountsImpl(token, owner, repo, cacheKey);
  restCountsInflight.set(cacheKey, promise);
  const cleanup = () => {
    if (restCountsInflight.get(cacheKey) === promise) restCountsInflight.delete(cacheKey);
  };
  promise.then(cleanup, cleanup);
  return promise;
}

const restCountsInflight = new Map<string, Promise<RepoStats | null>>();

async function fetchRestCountsImpl(
  token: string,
  owner: string,
  repo: string,
  cacheKey: string
): Promise<RepoStats | null> {
  const block = gitHubRateLimitService.shouldBlockRequest("core");
  if (block.blocked) return null;

  const prior = restCountsCache.get(cacheKey);
  const versionAtStart = getETagCacheVersion();
  const baseHeaders: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const repoHeaders = { ...baseHeaders };
  if (prior?.repoEtag) repoHeaders["If-None-Match"] = prior.repoEtag;
  const prHeaders = { ...baseHeaders };
  if (prior?.prEtag) prHeaders["If-None-Match"] = prior.prEtag;

  try {
    const [repoRes, prRes] = await Promise.all([
      rateLimitAwareFetch(`https://api.github.com/repos/${owner}/${repo}`, {
        headers: repoHeaders,
        signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
        daintreeSkipRateLimitPreflight: true,
      }),
      rateLimitAwareFetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=1`,
        {
          headers: prHeaders,
          signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
          daintreeSkipRateLimitPreflight: true,
        }
      ),
    ]);

    // A concurrent cache clear invalidated the ETag baseline these requests
    // were built on — discard rather than committing counts against it.
    if (getETagCacheVersion() !== versionAtStart) return null;

    let combinedCount: number;
    let repoEtag: string | null;
    if (repoRes.status === 304 && prior) {
      combinedCount = prior.combinedCount;
      repoEtag = prior.repoEtag;
    } else if (repoRes.status === 200) {
      const body = (await repoRes.json()) as { open_issues_count?: unknown } | null;
      const count = body?.open_issues_count;
      if (typeof count !== "number" || !Number.isFinite(count) || count < 0) return null;
      combinedCount = count;
      repoEtag = repoRes.headers.get("etag");
    } else {
      return null;
    }

    let prCount: number;
    let prEtag: string | null;
    if (prRes.status === 304 && prior) {
      prCount = prior.prCount;
      prEtag = prior.prEtag;
    } else if (prRes.status === 200) {
      const lastPage = parseLinkLastPage(prRes.headers.get("link"));
      if (lastPage !== null) {
        prCount = lastPage;
      } else {
        const body = (await prRes.json()) as unknown;
        if (!Array.isArray(body)) return null;
        prCount = body.length;
      }
      prEtag = prRes.headers.get("etag");
    } else {
      return null;
    }

    // The two endpoints are not transactional — a PR opening between the two
    // reads can make the derived issue count negative. Treat it as a failed
    // fetch (no commit) so the next poll reads a consistent pair.
    const issueCount = combinedCount - prCount;
    if (issueCount < 0) return null;

    // Re-check right before the commit: the `json()` awaits above are further
    // suspension points where a concurrent clear (token change / manual
    // refresh) can land — committing past it would re-seed the just-cleared
    // cache with a pre-clear baseline that then serves for up to the 1h TTL.
    if (getETagCacheVersion() !== versionAtStart) return null;

    const lastUpdated = Date.now();
    const snapshot: RestCountsSnapshot = { combinedCount, prCount, repoEtag, prEtag, lastUpdated };
    restCountsCache.set(cacheKey, snapshot);

    // Count-as-cache-buster: a committed count that differs from the prior
    // committed pair means cached list pages for the changed type are provably
    // stale — drop them (zero network) so no path can serve a pre-change page
    // for the rest of its 60s TTL. Per-type comparison: the derived issue
    // count and the PR count move independently, and busting the unchanged
    // type would just multiply refetch volume. First-ever commit (`!prior`)
    // busts nothing — there is no baseline to have diverged from. Note the
    // inverse does NOT hold: equal counts don't prove the pages are fresh
    // (close-one-open-one), which is why the dropdown's own revalidation
    // stays the correctness backstop.
    if (prior) {
      const priorIssueCount = prior.combinedCount - prior.prCount;
      invalidateRepoListCachesForCountChange(owner, repo, {
        issues: priorIssueCount !== issueCount,
        prs: prior.prCount !== prCount,
      });
    }

    // The refreshed-at stamps match `lastUpdated` here even on a 304 replay:
    // a 304 is a direct GitHub confirmation that the count endpoint's content
    // is unchanged, so the counts were genuinely re-verified now.
    return {
      issueCount,
      prCount,
      lastUpdated,
      issueCountRefreshedAt: lastUpdated,
      prCountRefreshedAt: lastUpdated,
    };
  } catch {
    return null;
  }
}

export interface RepoStatsForContextOptions {
  bypassCache?: boolean;
  /**
   * Absolute project path recorded as metadata in the disk caches
   * (`GitHubStatsCache` / `GitHubFirstPageCache`); empty when the caller has
   * no local checkout (the forge `repoStats` capability).
   */
  projectPath?: string;
  /**
   * Re-resolve the repo context after a repo-not-found error. Supplied by the
   * cwd wrapper to preserve its remote-changed retry; context-only callers
   * omit it and get no retry.
   */
  refreshContext?: () => Promise<RepoContext | null>;
}

export async function getRepoStatsAndPageForContext(
  context: RepoContext,
  options: RepoStatsForContextOptions = {},
  _retried = false
): Promise<RepoStatsAndPageResult> {
  const bypassCache = options.bypassCache === true;
  const projectPath = options.projectPath ?? "";
  const cacheKey = `${context.owner}/${context.repo}`;
  const persistentCache = GitHubStatsCache.getInstance();
  const client = GitHubAuth.createClient();

  // Seeds the legacy first page, so these must match exactly what
  // `GitHubIssues.listIssues`/`GitHubPRs.listPullRequests` build for an
  // unfiltered, uncursored, default-ordered first page — otherwise the seed
  // lands under a key nothing ever reads.
  const firstPageKeyDefaults = {
    owner: context.owner,
    repo: context.repo,
    state: "open",
    search: "",
    sortOrder: "created",
    direction: "desc",
    perPage: DEFAULT_LIST_PER_PAGE,
    cursor: "",
  } as const;
  const issuesListCacheKey = buildListCacheKey({ type: "issue", ...firstPageKeyDefaults });
  const prsListCacheKey = buildListCacheKey({ type: "pr", ...firstPageKeyDefaults });

  if (!client) {
    const diskCached = persistentCache.get(cacheKey);
    if (diskCached) {
      return {
        stats: {
          issueCount: diskCached.issueCount,
          prCount: diskCached.prCount,
          stale: true,
          lastUpdated: diskCached.lastUpdated,
        },
        issues: null,
        prs: null,
        error: "GitHub token not configured. Set it in Settings.",
      };
    }
    return {
      stats: null,
      issues: null,
      prs: null,
      error: "GitHub token not configured. Set it in Settings.",
    };
  }

  if (!bypassCache) {
    const cachedStats = repoStatsCache.get(cacheKey);
    const cachedIssues = issueListCache.get(issuesListCacheKey);
    const cachedPRs = prListCache.get(prsListCacheKey);
    if (cachedStats && cachedIssues && cachedPRs) {
      return {
        stats: cachedStats,
        issues: {
          items: cachedIssues.items,
          endCursor: cachedIssues.pageInfo.endCursor,
          hasNextPage: cachedIssues.pageInfo.hasNextPage,
          totalCount: cachedStats.issueCount,
        },
        prs: {
          items: cachedPRs.items,
          endCursor: cachedPRs.pageInfo.endCursor,
          hasNextPage: cachedPRs.pageInfo.hasNextPage,
          totalCount: cachedStats.prCount,
        },
        source: "memory-cache",
        nextPollIntervalMs: eventsProbeDelayMs(cacheKey),
      };
    }
  }

  // Activity-probe gate: when the short-lived memory cache has expired, a cheap
  // conditional GET to the REST `/events` feed decides whether any count fetch
  // is needed at all. An authenticated `304` costs zero rate-limit quota, so an
  // idle repo polls indefinitely for free. When the probe reports "unchanged",
  // nothing the count fetch observes can have changed, so the cached snapshot
  // is re-warmed and returned without any further request.
  //
  // `pendingEventsEtag` carries a changed-probe's new ETag so it can be written
  // only after the count fetch succeeds — committing it eagerly would let a
  // failed fetch advance the ETag ahead of the snapshot and mask the change.
  let pendingEventsEtag: string | null | undefined;
  if (bypassCache) {
    // A manual refresh / window focus is the explicit "something might have
    // changed, check now" signal — snap the adaptive backoff back to its floor
    // so the next probe runs without delay.
    repoEventsNoChangeCount.delete(cacheKey);
    repoEventsLastProbeAt.delete(cacheKey);
  } else {
    const token = GitHubAuth.getToken();
    if (token) {
      const hadCountBaseline =
        repoStatsAndPageSnapshotCache.get(cacheKey) !== undefined ||
        restCountsCache.get(cacheKey) !== undefined;
      // Skip the network probe entirely while inside the adaptive window: never
      // poll `/events` faster than the server-advertised `X-Poll-Interval`, and
      // back off further on an idle repo. The cached snapshot (or, on the
      // background-only path, the last REST counts) stands in for the
      // "unchanged" result we'd otherwise pay a request to confirm.
      const withinBackoff =
        hadCountBaseline &&
        Date.now() - (repoEventsLastProbeAt.get(cacheKey) ?? 0) < eventsProbeDelayMs(cacheKey);
      const probe: ActivityProbeResult = withinBackoff
        ? { status: "unchanged" }
        : await fetchActivityProbe(token, context.owner, context.repo);

      // Read the count baselines only AFTER the probe await — two independent
      // concurrent mutations can land during it: (1) a list query's write-back
      // (`updateRepoStatsCount`) may have reconciled a stale snapshot/REST
      // entry away, and (2) a concurrent poll's count-buster can drop the
      // snapshot mid-probe. Serving a pre-await capture would resurrect the
      // just-invalidated counts or re-warm the list caches from pages the bust
      // already removed.
      const snapshot = repoStatsAndPageSnapshotCache.get(cacheKey);
      const restCounts = restCountsCache.get(cacheKey);

      if (probe.status === "changed") {
        pendingEventsEtag = probe.etag;
      }

      if (probe.status === "unchanged" && snapshot) {
        // The cheap REST poll may have observed fresher counts after this
        // snapshot was written (it deliberately leaves the page snapshot
        // untouched) — serve whichever count pair was committed most recently
        // so an unchanged probe can't roll the pill back to pre-REST counts.
        const restCountsFresher =
          restCounts !== undefined && restCounts.lastUpdated >= (snapshot.stats.lastUpdated ?? 0);
        // `lastUpdated` is re-stamped to now — the probe just confirmed the
        // data is still current, and the freshness pill keys off it. The
        // per-count refreshed-at stamps are NOT: the counts themselves were
        // last read at the source's commit time, and claiming otherwise lets
        // a stale cached count outrank a fresher dropdown-observed total in
        // the renderer's recency arbitration (and permanently suppress the
        // dropdown-open force refresh).
        const freshStats: RepoStats = restCountsFresher
          ? {
              issueCount: restCounts.combinedCount - restCounts.prCount,
              prCount: restCounts.prCount,
              lastUpdated: Date.now(),
              issueCountRefreshedAt: restCounts.lastUpdated,
              prCountRefreshedAt: restCounts.lastUpdated,
            }
          : {
              ...snapshot.stats,
              lastUpdated: Date.now(),
              issueCountRefreshedAt:
                snapshot.stats.issueCountRefreshedAt ?? snapshot.stats.lastUpdated,
              prCountRefreshedAt: snapshot.stats.prCountRefreshedAt ?? snapshot.stats.lastUpdated,
            };
        repoStatsCache.set(cacheKey, freshStats);
        issueListCache.set(issuesListCacheKey, {
          items: snapshot.issues.items,
          pageInfo: {
            hasNextPage: snapshot.issues.hasNextPage,
            endCursor: snapshot.issues.endCursor,
          },
          totalCount: snapshot.issues.totalCount,
        });
        prListCache.set(prsListCacheKey, {
          items: snapshot.prs.items,
          pageInfo: {
            hasNextPage: snapshot.prs.hasNextPage,
            endCursor: snapshot.prs.endCursor,
          },
          totalCount: snapshot.prs.totalCount,
        });
        // Re-stamp the durable disk cache too. The 60s in-memory caches above
        // keep hot polls fast, but the disk cache is the failure-mode fallback:
        // the error paths below read `persistentCache.get` to serve last-known
        // counts when a full fetch fails. Without this, a run of probe-match
        // hits lets the disk cache age out behind the in-memory caches, so the
        // eventual probe-miss + failed fetch has no fallback and the badge goes
        // `—`. The snapshot cache is intentionally NOT re-stamped — it keeps its
        // 10-min TTL so list content can't go stale indefinitely behind a
        // continuously-matching probe; aging out just forces a full refresh,
        // which the disk re-stamp keeps safe.
        persistentCache.set(cacheKey, freshStats, projectPath);
        return {
          stats: freshStats,
          issues: { ...snapshot.issues },
          prs: { ...snapshot.prs },
          source: "network",
          nextPollIntervalMs: eventsProbeDelayMs(cacheKey),
        };
      }

      // Background-only steady state: the page snapshot is written solely by
      // the explicit-refresh GraphQL path now, so once its 10-min TTL lapses
      // an unchanged probe lands here. The last committed REST counts are the
      // "reuse cached count" half of the probe contract (issue #10122) — an
      // idle repo costs one conditional `/events` GET per cadence window, not
      // a probe plus two count requests.
      if (probe.status === "unchanged" && !snapshot && restCounts) {
        const freshStats: RepoStats = {
          issueCount: restCounts.combinedCount - restCounts.prCount,
          prCount: restCounts.prCount,
          lastUpdated: Date.now(),
          issueCountRefreshedAt: restCounts.lastUpdated,
          prCountRefreshedAt: restCounts.lastUpdated,
        };
        repoStatsCache.set(cacheKey, freshStats);
        persistentCache.set(cacheKey, freshStats, projectPath);
        return {
          stats: freshStats,
          issues: null,
          prs: null,
          source: "network",
          nextPollIntervalMs: eventsProbeDelayMs(cacheKey),
        };
      }
    }
  }

  // Background polls (the only `bypassCache: false` callers reaching this
  // point) need just the two toolbar count scalars — fetch them via the cheap
  // conditional REST pair instead of the ~6-point GraphQL page query (issue
  // #10122). The full page now ships only on the explicit-refresh path below
  // or via the dropdown's own list queries; the dropdown's fresh `totalCount`
  // corrects the pill through `resolveGitHubDisplayCount`. On REST failure,
  // serve the last-known disk counts rather than falling through to GraphQL —
  // a silent fallback would quietly reinstate the heavy query on every
  // transient REST error.
  if (!bypassCache) {
    const token = GitHubAuth.getToken();
    const restStats = token ? await fetchRestCounts(token, context.owner, context.repo) : null;
    if (restStats) {
      repoStatsCache.set(cacheKey, restStats);
      persistentCache.set(cacheKey, restStats, projectPath);
      // Commit the changed-probe's events ETag in lockstep with the counts it
      // describes — same deferred-commit discipline as the GraphQL path: a
      // failed count fetch leaves the old ETag so the next probe re-detects
      // the change instead of masking it behind a 304.
      if (pendingEventsEtag !== undefined) {
        if (pendingEventsEtag) {
          repoEventsETagCache.set(cacheKey, pendingEventsEtag);
        } else {
          repoEventsETagCache.invalidate(cacheKey);
        }
      }
      return {
        stats: restStats,
        issues: null,
        prs: null,
        source: "network",
        nextPollIntervalMs: eventsProbeDelayMs(cacheKey),
      };
    }

    const coreBlock = gitHubRateLimitService.shouldBlockRequest("core");
    const message =
      coreBlock.blocked && coreBlock.reason && coreBlock.resumeAt
        ? rateLimitMessage(coreBlock.reason, coreBlock.resumeAt)
        : "Couldn't fetch repository counts";
    const diskCached = persistentCache.get(cacheKey);
    if (diskCached) {
      return {
        stats: {
          issueCount: diskCached.issueCount,
          prCount: diskCached.prCount,
          stale: true,
          lastUpdated: diskCached.lastUpdated,
        },
        issues: null,
        prs: null,
        error: message,
      };
    }
    return { stats: null, issues: null, prs: null, error: message };
  }

  const rateLimitBlock = gitHubRateLimitService.shouldBlockRequest("graphql");
  if (rateLimitBlock.blocked && rateLimitBlock.reason && rateLimitBlock.resumeAt) {
    const diskCached = persistentCache.get(cacheKey);
    const message = rateLimitMessage(rateLimitBlock.reason, rateLimitBlock.resumeAt);
    if (diskCached) {
      return {
        stats: {
          issueCount: diskCached.issueCount,
          prCount: diskCached.prCount,
          stale: true,
          lastUpdated: diskCached.lastUpdated,
        },
        issues: null,
        prs: null,
        error: message,
      };
    }
    return { stats: null, issues: null, prs: null, error: message };
  }

  // Mid-flight count-buster guard for the page-cache writes below — same
  // discipline as the list fetchers: a concurrent background poll can commit
  // a count change (and bust the list caches) while the heavy query is in
  // flight, and server-side ordering between the two reads is unknowable.
  // On an epoch move the page/snapshot writes are skipped (the next read
  // refetches); the response is still returned and broadcast for display.
  const issueEpochAtStart = getRepoListEpoch("issue", context.owner, context.repo);
  const prEpochAtStart = getRepoListEpoch("pr", context.owner, context.repo);

  try {
    const result = (await client(REPO_STATS_AND_PAGE_QUERY, {
      owner: context.owner,
      repo: context.repo,
      request: { signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS) },
    })) as GraphQlQueryResponseData;

    gitHubRateLimitService.updateFromGraphQL(result, "REPO_STATS_AND_PAGE_QUERY");

    const repository = result?.repository;
    if (!repository) {
      const diskCached = persistentCache.get(cacheKey);
      if (diskCached) {
        return {
          stats: {
            issueCount: diskCached.issueCount,
            prCount: diskCached.prCount,
            stale: true,
            lastUpdated: diskCached.lastUpdated,
          },
          issues: null,
          prs: null,
          error: "Repository not found (showing cached data)",
        };
      }
      return { stats: null, issues: null, prs: null, error: "Repository not found" };
    }

    const issuesData = repository.issues as
      | {
          totalCount?: number;
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          nodes?: Array<Record<string, unknown>>;
        }
      | undefined;
    const prsData = repository.pullRequests as
      | {
          totalCount?: number;
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          nodes?: Array<Record<string, unknown>>;
        }
      | undefined;

    const issueCount = issuesData?.totalCount ?? 0;
    const prCount = prsData?.totalCount ?? 0;
    const fetchedAt = Date.now();
    const stats: RepoStats = {
      issueCount,
      prCount,
      lastUpdated: fetchedAt,
      issueCountRefreshedAt: fetchedAt,
      prCountRefreshedAt: fetchedAt,
    };

    repoStatsCache.set(cacheKey, stats);
    persistentCache.set(cacheKey, stats, projectPath);

    const parsedIssues = (issuesData?.nodes ?? []).filter(Boolean).map(parseIssueNode);
    const parsedPRs = (prsData?.nodes ?? []).filter(Boolean).map(parsePRNode);

    GitHubFirstPageCache.getInstance().set(
      cacheKey,
      {
        issues: {
          items: parsedIssues,
          endCursor: issuesData?.pageInfo?.endCursor ?? null,
          hasNextPage: issuesData?.pageInfo?.hasNextPage ?? false,
        },
        prs: {
          items: parsedPRs,
          endCursor: prsData?.pageInfo?.endCursor ?? null,
          hasNextPage: prsData?.pageInfo?.hasNextPage ?? false,
        },
      },
      projectPath
    );

    const issuesPage = {
      items: parsedIssues,
      endCursor: issuesData?.pageInfo?.endCursor ?? null,
      hasNextPage: issuesData?.pageInfo?.hasNextPage ?? false,
      totalCount: issueCount,
    };
    const prsPage = {
      items: parsedPRs,
      endCursor: prsData?.pageInfo?.endCursor ?? null,
      hasNextPage: prsData?.pageInfo?.hasNextPage ?? false,
      totalCount: prCount,
    };
    const issueEpochUnchanged =
      getRepoListEpoch("issue", context.owner, context.repo) === issueEpochAtStart;
    const prEpochUnchanged = getRepoListEpoch("pr", context.owner, context.repo) === prEpochAtStart;
    if (issueEpochUnchanged) {
      issueListCache.set(issuesListCacheKey, {
        items: issuesPage.items,
        pageInfo: { hasNextPage: issuesPage.hasNextPage, endCursor: issuesPage.endCursor },
        totalCount: issuesPage.totalCount,
      });
    }
    if (prEpochUnchanged) {
      prListCache.set(prsListCacheKey, {
        items: prsPage.items,
        pageInfo: { hasNextPage: prsPage.hasNextPage, endCursor: prsPage.endCursor },
        totalCount: prsPage.totalCount,
      });
    }

    // Record the snapshot so the next poll can skip the heavy query when the
    // activity probe reports no change. Written only on a successful network
    // fetch — a failed fetch must not advance it — and only when neither
    // type's epoch moved mid-query (the snapshot embeds both first pages).
    if (issueEpochUnchanged && prEpochUnchanged) {
      repoStatsAndPageSnapshotCache.set(cacheKey, {
        stats,
        issues: issuesPage,
        prs: prsPage,
      });
    }

    return {
      stats,
      issues: issuesPage,
      prs: prsPage,
      source: "network",
      nextPollIntervalMs: eventsProbeDelayMs(cacheKey),
    };
  } catch (error) {
    if (!_retried && isRepoNotFoundError(error) && options.refreshContext) {
      const freshContext = await options.refreshContext();
      if (
        freshContext &&
        (freshContext.owner !== context.owner || freshContext.repo !== context.repo)
      ) {
        return getRepoStatsAndPageForContext(freshContext, options, true);
      }
    }
    const diskCached = persistentCache.get(cacheKey);
    if (diskCached) {
      return {
        stats: {
          issueCount: diskCached.issueCount,
          prCount: diskCached.prCount,
          stale: true,
          lastUpdated: diskCached.lastUpdated,
        },
        issues: null,
        prs: null,
        error: parseGitHubError(error),
      };
    }
    return { stats: null, issues: null, prs: null, error: parseGitHubError(error) };
  }
}

export async function getRepoStatsAndPage(
  cwd: string,
  bypassCache = false
): Promise<RepoStatsAndPageResult> {
  const context = await getRepoContext(cwd);
  if (!context) {
    return { stats: null, issues: null, prs: null, error: "Not a GitHub repository" };
  }

  return getRepoStatsAndPageForContext(context, {
    bypassCache,
    projectPath: cwd,
    refreshContext: async () => {
      repoContextCache.invalidate(cwd);
      return getRepoContext(cwd);
    },
  });
}

/**
 * Context-variant core of {@link getFirstPageCache} — pure disk-cache reads.
 * `projectPath` is echoed into the payload for cwd callers; context-only
 * callers (the forge `repoStats` capability) leave it empty.
 */
export async function getFirstPageCacheForContext(
  context: RepoContext,
  projectPath = ""
): Promise<GitHubFirstPageCachePayload | null> {
  const repoKey = `${context.owner}/${context.repo}`;
  const entry = GitHubFirstPageCache.getInstance().get(repoKey);
  const cachedStats = GitHubStatsCache.getInstance().getForBootstrap(repoKey);

  if (!entry && !cachedStats) return null;

  if (entry) {
    const payload: GitHubFirstPageCachePayload = {
      projectPath,
      issues: entry.issues,
      prs: entry.prs,
      lastUpdated: entry.lastUpdated,
    };
    if (cachedStats) {
      payload.stats = {
        issueCount: cachedStats.issueCount,
        prCount: cachedStats.prCount,
        lastUpdated: cachedStats.lastUpdated,
      };
    }
    return payload;
  }

  if (!cachedStats) return null;
  return {
    projectPath,
    issues: { items: [], endCursor: null, hasNextPage: false },
    prs: { items: [], endCursor: null, hasNextPage: false },
    lastUpdated: cachedStats.lastUpdated,
    stats: {
      issueCount: cachedStats.issueCount,
      prCount: cachedStats.prCount,
      lastUpdated: cachedStats.lastUpdated,
    },
  };
}

export async function getFirstPageCache(cwd: string): Promise<GitHubFirstPageCachePayload | null> {
  if (!path.isAbsolute(cwd)) return null;

  try {
    const resolved = path.resolve(cwd);
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) return null;

    const context = await getRepoContext(resolved);
    if (!context) return null;

    return await getFirstPageCacheForContext(context, resolved);
  } catch {
    return null;
  }
}

export interface RepoStatsCompleteResult {
  stats: RepositoryStats;
  source?: "network" | "memory-cache";
  issues?: RepoStatsAndPageResult["issues"];
  prs?: RepoStatsAndPageResult["prs"];
  stale?: boolean;
}

export async function getRepoStatsComplete(
  cwd: string,
  bypassCache = false
): Promise<RepoStatsCompleteResult> {
  const { getCommitCount } = await import("../../../../electron/utils/git.js");

  try {
    const resolved = path.resolve(cwd);
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      return {
        stats: {
          commitCount: 0,
          issueCount: null,
          prCount: null,
          loading: false,
          ghError: "Path is not a directory",
        },
      };
    }

    const statsResult = await getRepoStatsAndPage(resolved, bypassCache);
    const commitCount = await getCommitCount(resolved).catch(() => 0);
    const rateLimitState = gitHubRateLimitService.getState();

    const repositoryStats: RepositoryStats = {
      commitCount,
      issueCount: statsResult.stats?.issueCount ?? null,
      prCount: statsResult.stats?.prCount ?? null,
      loading: false,
      ghError: statsResult.error,
      stale: statsResult.stats?.stale,
      lastUpdated: statsResult.stats?.lastUpdated,
      issueCountRefreshedAt: statsResult.stats?.issueCountRefreshedAt,
      prCountRefreshedAt: statsResult.stats?.prCountRefreshedAt,
      rateLimitResetAt:
        rateLimitState.blocked && rateLimitState.resetAt ? rateLimitState.resetAt : undefined,
      rateLimitKind: rateLimitState.blocked ? (rateLimitState.kind ?? undefined) : undefined,
      nextPollIntervalMs: statsResult.nextPollIntervalMs,
    };

    return {
      stats: repositoryStats,
      source: statsResult.source,
      issues: statsResult.issues,
      prs: statsResult.prs,
      stale: statsResult.stats?.stale,
    };
  } catch (err) {
    const { formatErrorMessage } = await import("../../../../shared/utils/errorMessage.js");
    const message = formatErrorMessage(err, "Failed to fetch GitHub repo stats");
    return {
      stats: {
        commitCount: 0,
        issueCount: null,
        prCount: null,
        loading: false,
        ghError: message,
      },
    };
  }
}
