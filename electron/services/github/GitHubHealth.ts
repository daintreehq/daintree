import type { GraphQlQueryResponseData } from "@octokit/graphql";
import { GitHubAuth, GITHUB_API_TIMEOUT_MS } from "./GitHubAuth.js";
import { PROJECT_HEALTH_QUERY } from "./GitHubQueries.js";
import { gitHubRateLimitService } from "./GitHubRateLimitService.js";
import { rateLimitMessage, parseGitHubError } from "./GitHubErrors.js";
import { getRepoContext, isRepoNotFoundError } from "./GitHubRepoContext.js";
import { repoContextCache, projectHealthCache } from "./GitHubCaches.js";
import type { CIStatus, ProjectHealth, ProjectHealthResult } from "./types.js";

function parseCIStatus(statusCheckRollup: { state?: string } | null | undefined): CIStatus {
  if (!statusCheckRollup) return "none";
  const state = statusCheckRollup.state?.toUpperCase();
  switch (state) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
      return "failure";
    case "ERROR":
      return "error";
    case "PENDING":
      return "pending";
    case "EXPECTED":
      return "expected";
    default:
      return "none";
  }
}

function extractMergedCounts(data: Record<string, unknown>): Record<60 | 120 | 180, number> {
  const getCount = (key: string): number => {
    const entry = data[key] as { issueCount?: number } | undefined;
    return entry?.issueCount ?? 0;
  };
  return {
    60: getCount("mergedPRs60"),
    120: getCount("mergedPRs120"),
    180: getCount("mergedPRs180"),
  };
}

function parseProjectHealthResponse(
  repository: Record<string, unknown>,
  mergedCounts: Record<60 | 120 | 180, number>,
  repoUrl: string
): ProjectHealth {
  const defaultBranchRef = repository.defaultBranchRef as {
    target?: { statusCheckRollup?: { state?: string } | null };
  } | null;
  const statusCheckRollup = defaultBranchRef?.target?.statusCheckRollup ?? null;

  const latestRelease = repository.latestRelease as {
    tagName: string;
    publishedAt: string | null;
    url: string;
  } | null;

  const vulnerabilityAlerts = repository.vulnerabilityAlerts as {
    totalCount: number;
  } | null;

  return {
    ciStatus: parseCIStatus(statusCheckRollup),
    issueCount: (repository.issues as { totalCount?: number })?.totalCount ?? 0,
    prCount: (repository.pullRequests as { totalCount?: number })?.totalCount ?? 0,
    latestRelease: latestRelease
      ? {
          tagName: latestRelease.tagName,
          publishedAt: latestRelease.publishedAt,
          url: latestRelease.url,
        }
      : null,
    securityAlerts: {
      visible: vulnerabilityAlerts != null,
      count: vulnerabilityAlerts?.totalCount ?? 0,
    },
    mergeVelocity: {
      mergedCounts,
    },
    repoUrl,
    lastUpdated: Date.now(),
  };
}

export async function getProjectHealth(
  cwd: string,
  bypassCache = false,
  _retried = false
): Promise<ProjectHealthResult> {
  const context = await getRepoContext(cwd);
  if (!context) {
    return { health: null, error: "Not a GitHub repository" };
  }

  const cacheKey = `${context.owner}/${context.repo}`;
  const repoUrl = `https://github.com/${context.owner}/${context.repo}`;

  const client = GitHubAuth.createClient();
  if (!client) {
    return { health: null, error: "GitHub token not configured. Set it in Settings." };
  }

  const rateLimitBlock = gitHubRateLimitService.shouldBlockRequest();
  if (rateLimitBlock.blocked && rateLimitBlock.reason && rateLimitBlock.resumeAt) {
    return {
      health: null,
      error: rateLimitMessage(rateLimitBlock.reason, rateLimitBlock.resumeAt),
    };
  }

  if (!bypassCache) {
    const cached = projectHealthCache.get(cacheKey) as ProjectHealth | undefined;
    if (cached) {
      return { health: cached };
    }
  }

  try {
    const repoQualifier = `repo:${context.owner}/${context.repo}`;
    const mergedSearchBase = `${repoQualifier} is:pr is:merged`;
    const now = new Date();
    const mergedQueryVars = Object.fromEntries(
      ([60, 120, 180] as const).map((days) => {
        const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
        const dateStr = since.toISOString().slice(0, 10);
        return [`merged${days}`, `${mergedSearchBase} merged:>=${dateStr}`];
      })
    );

    const result = (await client(PROJECT_HEALTH_QUERY, {
      owner: context.owner,
      repo: context.repo,
      ...mergedQueryVars,
      request: { signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS) },
    })) as GraphQlQueryResponseData;

    const repository = result?.repository;
    if (!repository) {
      return { health: null, error: "Repository not found" };
    }

    const mergedCounts = extractMergedCounts(result);
    const health = parseProjectHealthResponse(
      repository as Record<string, unknown>,
      mergedCounts,
      repoUrl
    );
    projectHealthCache.set(cacheKey, health);
    return { health };
  } catch (error: unknown) {
    if (error instanceof Error && "data" in error && (error as { data?: unknown }).data) {
      const partialData = (error as { data: Record<string, unknown> }).data;
      const repository = partialData?.repository as Record<string, unknown> | undefined;
      if (repository) {
        const mergedCounts = extractMergedCounts(partialData);
        const health = parseProjectHealthResponse(repository, mergedCounts, repoUrl);
        projectHealthCache.set(cacheKey, health);
        return { health };
      }
    }

    if (!_retried && isRepoNotFoundError(error)) {
      repoContextCache.invalidate(cwd);
      const freshContext = await getRepoContext(cwd);
      if (
        freshContext &&
        (freshContext.owner !== context.owner || freshContext.repo !== context.repo)
      ) {
        return getProjectHealth(cwd, bypassCache, true);
      }
    }

    return { health: null, error: parseGitHubError(error) };
  }
}
