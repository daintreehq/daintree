import fs from "fs/promises";
import path from "path";
import type { GraphQlQueryResponseData } from "@octokit/graphql";
import { GitHubAuth, GITHUB_API_TIMEOUT_MS } from "./GitHubAuth.js";
import {
  REPO_STATS_QUERY,
  REPO_STATS_AND_PAGE_QUERY,
  REPO_ACTIVITY_PROBE_QUERY,
} from "./GitHubQueries.js";
import { gitHubRateLimitService } from "./GitHubRateLimitService.js";
import { rateLimitMessage } from "./GitHubErrors.js";
import { parseGitHubError } from "./GitHubErrors.js";
import { getRepoContext, isRepoNotFoundError } from "./GitHubRepoContext.js";
import {
  repoContextCache,
  repoStatsCache,
  issueListCache,
  prListCache,
  repoActivityProbeCache,
  repoStatsAndPageSnapshotCache,
} from "./GitHubCaches.js";
import { GitHubStatsCache } from "../../../../electron/services/GitHubStatsCache.js";
import { GitHubFirstPageCache } from "../../../../electron/services/GitHubFirstPageCache.js";
import type { RepoActivityProbe, RepoStats, RepoStatsResult } from "./types.js";
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

    gitHubRateLimitService.updateFromGraphQL(result);

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

type GraphQLClient = NonNullable<ReturnType<typeof GitHubAuth.createClient>>;

/**
 * Run the cheap {@link REPO_ACTIVITY_PROBE_QUERY} to capture the repo's three
 * activity timestamps. Returns `null` on any failure — the probe is purely an
 * optimization, so a failure must silently fall through to the full fetch.
 */
async function fetchActivityProbe(
  client: GraphQLClient,
  owner: string,
  repo: string
): Promise<RepoActivityProbe | null> {
  try {
    const result = (await client(REPO_ACTIVITY_PROBE_QUERY, {
      owner,
      repo,
      request: { signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS) },
    })) as GraphQlQueryResponseData;

    gitHubRateLimitService.updateFromGraphQL(result);

    const repository = result?.repository;
    if (!repository) return null;

    const issueNode = (
      repository.issues as { nodes?: Array<{ updatedAt?: string }> } | undefined
    )?.nodes?.[0];
    const prNode = (
      repository.pullRequests as { nodes?: Array<{ updatedAt?: string }> } | undefined
    )?.nodes?.[0];

    return {
      pushedAt: (repository.pushedAt as string | null | undefined) ?? null,
      issueUpdatedAt: issueNode?.updatedAt ?? null,
      prUpdatedAt: prNode?.updatedAt ?? null,
    };
  } catch {
    return null;
  }
}

function activityProbesEqual(a: RepoActivityProbe, b: RepoActivityProbe): boolean {
  return (
    a.pushedAt === b.pushedAt &&
    a.issueUpdatedAt === b.issueUpdatedAt &&
    a.prUpdatedAt === b.prUpdatedAt
  );
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
  // probe (~3 rate-limit points) decides whether the expensive stats query
  // (~6+ points) is needed at all. If the probe timestamps match the previous
  // run, nothing the stats query observes can have changed, so the cached
  // snapshot is re-warmed and returned without the heavy fetch.
  let probeResult: RepoActivityProbe | null = null;
  if (!bypassCache) {
    probeResult = await fetchActivityProbe(client, context.owner, context.repo);
    if (probeResult) {
      const lastProbe = repoActivityProbeCache.get(cacheKey);
      const snapshot = repoStatsAndPageSnapshotCache.get(cacheKey);
      if (lastProbe && snapshot && activityProbesEqual(lastProbe, probeResult)) {
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
        return {
          stats: freshStats,
          issues: { ...snapshot.issues },
          prs: { ...snapshot.prs },
          source: "network",
        };
      }
    }
  }

  try {
    const result = (await client(REPO_STATS_AND_PAGE_QUERY, {
      owner: context.owner,
      repo: context.repo,
      request: { signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS) },
    })) as GraphQlQueryResponseData;

    gitHubRateLimitService.updateFromGraphQL(result);

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

    // Record the snapshot + the probe that preceded this fetch so the next
    // poll can skip the heavy query if nothing changed. Both are only written
    // on a successful network fetch — a failed fetch must not advance them.
    if (probeResult) {
      repoActivityProbeCache.set(cacheKey, probeResult);
    }
    repoStatsAndPageSnapshotCache.set(cacheKey, {
      stats,
      issues: issuesPage,
      prs: prsPage,
    });

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
