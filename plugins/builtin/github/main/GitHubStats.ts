import fs from "fs/promises";
import path from "path";
import type { GraphQlQueryResponseData } from "@octokit/graphql";
import { GitHubAuth, GITHUB_API_TIMEOUT_MS, rateLimitAwareFetch } from "./GitHubAuth.js";
import { REPO_STATS_QUERY, REPO_STATS_AND_PAGE_QUERY } from "./GitHubQueries.js";
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
  repoEventsETagCache,
  repoEventsPollIntervalCache,
  repoEventsNoChangeCount,
  repoEventsLastProbeAt,
  getETagCacheVersion,
} from "./GitHubCaches.js";
import { GitHubStatsCache } from "../../../../electron/services/GitHubStatsCache.js";
import { GitHubFirstPageCache } from "../../../../electron/services/GitHubFirstPageCache.js";
import type { RepoStats, RepoStatsResult } from "./types.js";
import type { GitHubIssue, GitHubPR } from "../../../../shared/types/github.js";
import { parseIssueNode } from "./GitHubIssues.js";
import { parsePRNode, buildListCacheKey } from "./GitHubPRs.js";
import type {
  RepositoryStats,
  GitHubFirstPageCachePayload,
} from "../../../../electron/types/index.js";

export async function getRepoStats(
  cwd: string,
  bypassCache = false,
  _retried = false
): Promise<RepoStatsResult> {
  const context = await getRepoContext(cwd);
  if (!context) {
    return { stats: null, error: "Not a GitHub repository" };
  }

  const cacheKey = `${context.owner}/${context.repo}`;
  const persistentCache = GitHubStatsCache.getInstance();

  const client = GitHubAuth.createClient();
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
        error: "GitHub token not configured. Set it in Settings.",
      };
    }
    return { stats: null, error: "GitHub token not configured. Set it in Settings." };
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
        error: message,
      };
    }
    return { stats: null, error: message };
  }

  if (!bypassCache) {
    const cached = repoStatsCache.get(cacheKey);
    if (cached) {
      return { stats: cached };
    }
  }

  try {
    const result = (await client(REPO_STATS_QUERY, {
      owner: context.owner,
      repo: context.repo,
      request: { signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS) },
    })) as GraphQlQueryResponseData;

    gitHubRateLimitService.updateFromGraphQL(result, "REPO_STATS_QUERY");

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
          error: "Repository not found (showing cached data)",
        };
      }
      return { stats: null, error: "Repository not found" };
    }

    const stats: RepoStats = {
      issueCount: repository.issues?.totalCount ?? 0,
      prCount: repository.pullRequests?.totalCount ?? 0,
      lastUpdated: Date.now(),
    };

    repoStatsCache.set(cacheKey, stats);
    persistentCache.set(cacheKey, stats, cwd);

    return { stats };
  } catch (error) {
    if (!_retried && isRepoNotFoundError(error)) {
      repoContextCache.invalidate(cwd);
      const freshContext = await getRepoContext(cwd);
      if (
        freshContext &&
        (freshContext.owner !== context.owner || freshContext.repo !== context.repo)
      ) {
        return getRepoStats(cwd, bypassCache, true);
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
        error: parseGitHubError(error),
      };
    }
    return { stats: null, error: parseGitHubError(error) };
  }
}

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

export async function getRepoStatsAndPage(
  cwd: string,
  bypassCache = false,
  _retried = false
): Promise<RepoStatsAndPageResult> {
  const context = await getRepoContext(cwd);
  if (!context) {
    return { stats: null, issues: null, prs: null, error: "Not a GitHub repository" };
  }

  const cacheKey = `${context.owner}/${context.repo}`;
  const persistentCache = GitHubStatsCache.getInstance();
  const client = GitHubAuth.createClient();

  const issuesListCacheKey = buildListCacheKey(
    "issue",
    context.owner,
    context.repo,
    "open",
    "",
    "created",
    ""
  );
  const prsListCacheKey = buildListCacheKey(
    "pr",
    context.owner,
    context.repo,
    "open",
    "",
    "created",
    ""
  );

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
      };
    }
  }

  // Activity-probe gate: when the short-lived memory cache has expired, a cheap
  // conditional GET to the REST `/events` feed decides whether the expensive
  // stats query (~6+ GraphQL points) is needed at all. An authenticated `304`
  // costs zero rate-limit quota, so an idle repo polls indefinitely for free.
  // When the probe reports "unchanged", nothing the stats query observes can
  // have changed, so the cached snapshot is re-warmed and returned without the
  // heavy fetch. This runs BEFORE the GraphQL rate-limit gate below: the probe
  // and the snapshot it validates draw from the REST `"core"` bucket, so a
  // depleted GraphQL budget must not suppress a zero-cost `304` cache hit.
  //
  // `pendingEventsEtag` carries a changed-probe's new ETag so it can be written
  // only after the full query succeeds — committing it eagerly would let a
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
      const snapshot = repoStatsAndPageSnapshotCache.get(cacheKey);
      // Skip the network probe entirely while inside the adaptive window: never
      // poll `/events` faster than the server-advertised `X-Poll-Interval`, and
      // back off further on an idle repo. The cached snapshot stands in for the
      // "unchanged" result we'd otherwise pay a request to confirm.
      const withinBackoff =
        snapshot !== undefined &&
        Date.now() - (repoEventsLastProbeAt.get(cacheKey) ?? 0) < eventsProbeDelayMs(cacheKey);
      const probe: ActivityProbeResult = withinBackoff
        ? { status: "unchanged" }
        : await fetchActivityProbe(token, context.owner, context.repo);

      if (probe.status === "changed") {
        pendingEventsEtag = probe.etag;
      }

      if (probe.status === "unchanged" && snapshot) {
        const freshStats: RepoStats = { ...snapshot.stats, lastUpdated: Date.now() };
        repoStatsCache.set(cacheKey, freshStats);
        issueListCache.set(issuesListCacheKey, {
          items: snapshot.issues.items,
          pageInfo: {
            hasNextPage: snapshot.issues.hasNextPage,
            endCursor: snapshot.issues.endCursor,
          },
        });
        prListCache.set(prsListCacheKey, {
          items: snapshot.prs.items,
          pageInfo: {
            hasNextPage: snapshot.prs.hasNextPage,
            endCursor: snapshot.prs.endCursor,
          },
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
        persistentCache.set(cacheKey, freshStats, cwd);
        return {
          stats: freshStats,
          issues: { ...snapshot.issues },
          prs: { ...snapshot.prs },
          source: "network",
        };
      }
    }
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
    const stats: RepoStats = {
      issueCount,
      prCount,
      lastUpdated: Date.now(),
    };

    repoStatsCache.set(cacheKey, stats);
    persistentCache.set(cacheKey, stats, cwd);

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
      cwd
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
    issueListCache.set(issuesListCacheKey, {
      items: issuesPage.items,
      pageInfo: { hasNextPage: issuesPage.hasNextPage, endCursor: issuesPage.endCursor },
    });
    prListCache.set(prsListCacheKey, {
      items: prsPage.items,
      pageInfo: { hasNextPage: prsPage.hasNextPage, endCursor: prsPage.endCursor },
    });

    // Record the snapshot so the next poll can skip the heavy query when the
    // activity probe reports no change. Written only on a successful network
    // fetch — a failed fetch must not advance it.
    repoStatsAndPageSnapshotCache.set(cacheKey, {
      stats,
      issues: issuesPage,
      prs: prsPage,
    });
    // Commit the changed-probe's events ETag now, in lockstep with the snapshot
    // it describes. Deferring it to here (rather than writing it in
    // `fetchActivityProbe`) guarantees the ETag never advances ahead of the
    // snapshot: if this query had failed, the old ETag would survive and the
    // next probe would re-detect the change instead of masking it behind a 304.
    if (pendingEventsEtag !== undefined) {
      if (pendingEventsEtag) {
        repoEventsETagCache.set(cacheKey, pendingEventsEtag);
      } else {
        repoEventsETagCache.invalidate(cacheKey);
      }
    }

    return { stats, issues: issuesPage, prs: prsPage, source: "network" };
  } catch (error) {
    if (!_retried && isRepoNotFoundError(error)) {
      repoContextCache.invalidate(cwd);
      const freshContext = await getRepoContext(cwd);
      if (
        freshContext &&
        (freshContext.owner !== context.owner || freshContext.repo !== context.repo)
      ) {
        return getRepoStatsAndPage(cwd, bypassCache, true);
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

export async function getFirstPageCache(cwd: string): Promise<GitHubFirstPageCachePayload | null> {
  if (!path.isAbsolute(cwd)) return null;

  try {
    const resolved = path.resolve(cwd);
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) return null;

    const context = await getRepoContext(resolved);
    if (!context) return null;

    const repoKey = `${context.owner}/${context.repo}`;
    const entry = GitHubFirstPageCache.getInstance().get(repoKey);
    const cachedStats = GitHubStatsCache.getInstance().getForBootstrap(repoKey);

    if (!entry && !cachedStats) return null;

    if (entry) {
      const payload: GitHubFirstPageCachePayload = {
        projectPath: resolved,
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
      projectPath: resolved,
      issues: { items: [], endCursor: null, hasNextPage: false },
      prs: { items: [], endCursor: null, hasNextPage: false },
      lastUpdated: cachedStats.lastUpdated,
      stats: {
        issueCount: cachedStats.issueCount,
        prCount: cachedStats.prCount,
        lastUpdated: cachedStats.lastUpdated,
      },
    };
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
      rateLimitResetAt:
        rateLimitState.blocked && rateLimitState.resetAt ? rateLimitState.resetAt : undefined,
      rateLimitKind: rateLimitState.blocked ? (rateLimitState.kind ?? undefined) : undefined,
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
