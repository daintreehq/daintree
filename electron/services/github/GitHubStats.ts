import type { GraphQlQueryResponseData } from "@octokit/graphql";
import { GitHubAuth, GITHUB_API_TIMEOUT_MS } from "./GitHubAuth.js";
import { REPO_STATS_QUERY, REPO_STATS_AND_PAGE_QUERY } from "./GitHubQueries.js";
import { gitHubRateLimitService } from "./GitHubRateLimitService.js";
import { rateLimitMessage } from "./GitHubErrors.js";
import { parseGitHubError } from "./GitHubErrors.js";
import { getRepoContext, isRepoNotFoundError } from "./GitHubRepoContext.js";
import { repoContextCache, repoStatsCache, issueListCache, prListCache } from "./GitHubCaches.js";
import { GitHubStatsCache } from "../GitHubStatsCache.js";
import { GitHubFirstPageCache } from "../GitHubFirstPageCache.js";
import type { RepoStats, RepoStatsResult } from "./types.js";
import type { GitHubIssue, GitHubPR } from "../../../shared/types/github.js";
import { parseIssueNode } from "./GitHubIssues.js";
import { parsePRNode, buildListCacheKey } from "./GitHubPRs.js";

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

  const rateLimitBlock = gitHubRateLimitService.shouldBlockRequest();
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

  const rateLimitBlock = gitHubRateLimitService.shouldBlockRequest();
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
    const issuesCacheKey = buildListCacheKey(
      "issue",
      context.owner,
      context.repo,
      "open",
      "",
      "created",
      ""
    );
    const prsCacheKey = buildListCacheKey(
      "pr",
      context.owner,
      context.repo,
      "open",
      "",
      "created",
      ""
    );
    const cachedIssues = issueListCache.get(issuesCacheKey);
    const cachedPRs = prListCache.get(prsCacheKey);
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

  try {
    const result = (await client(REPO_STATS_AND_PAGE_QUERY, {
      owner: context.owner,
      repo: context.repo,
      request: { signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS) },
    })) as GraphQlQueryResponseData;

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
