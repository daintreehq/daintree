import type { GraphQlQueryResponseData } from "@octokit/graphql";
import { GitHubAuth, GITHUB_API_TIMEOUT_MS } from "./GitHubAuth.js";
import { PROJECT_HEALTH_QUERY, MERGE_VELOCITY_QUERY } from "./GitHubQueries.js";
import { gitHubRateLimitService } from "./GitHubRateLimitService.js";
import { rateLimitMessage, parseGitHubError } from "./GitHubErrors.js";
import { getRepoContext, isRepoNotFoundError } from "./GitHubRepoContext.js";
import {
  repoContextCache,
  projectHealthCache,
  repoStatsCache,
  velocityCache,
} from "./GitHubCaches.js";
import { GitHubStatsCache } from "../../../../electron/services/GitHubStatsCache.js";
import type { CIStatus, ProjectHealth, ProjectHealthResult, RepoContext } from "./types.js";
import type { ProjectHealthData } from "../../../../electron/types/index.js";

type GraphQLClient = NonNullable<ReturnType<typeof GitHubAuth.createClient>>;

export function buildEmptyProjectHealthData(
  opts: { error?: string; hasRemote?: boolean } = {}
): ProjectHealthData {
  return {
    ciStatus: "none",
    issueCount: 0,
    prCount: 0,
    latestRelease: null,
    securityAlerts: { visible: false, count: 0 },
    mergeVelocity: { mergedCounts: { 60: 0, 120: 0, 180: 0 } },
    repoUrl: "",
    hasRemote: opts.hasRemote ?? false,
    loading: false,
    error: opts.error,
  };
}

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

/**
 * Velocity cache key — repo + UTC date. The 60/120/180-day search windows are
 * anchored to "now", so a cached value from a previous UTC day uses stale date
 * boundaries; folding the date into the key forces a recompute at midnight
 * even though the cache TTL (4h) has not elapsed.
 */
export function buildVelocityCacheKey(cacheKey: string, date: Date): string {
  return `${cacheKey}::velocity::${date.toISOString().slice(0, 10)}`;
}

/**
 * Open issue/PR counts for the repo, read from the caches already populated by
 * `getRepoStatsAndPage` — never a fresh network request. The stats poller runs
 * on the same cadence, so these are sub-second fresh in practice; a brief
 * zero on a cold start before the first stats fetch lands is acceptable.
 */
function readCachedCounts(cacheKey: string): { issueCount: number; prCount: number } {
  const memCached = repoStatsCache.get(cacheKey);
  if (memCached) {
    return { issueCount: memCached.issueCount, prCount: memCached.prCount };
  }
  const diskCached = GitHubStatsCache.getInstance().get(cacheKey);
  if (diskCached) {
    return { issueCount: diskCached.issueCount, prCount: diskCached.prCount };
  }
  return { issueCount: 0, prCount: 0 };
}

/**
 * Fetch the 60/120/180-day merged-PR counts via {@link MERGE_VELOCITY_QUERY}.
 * Returns `null` on failure — velocity is supplementary, so a failure must not
 * abort the rest of `getProjectHealth`; the caller falls back to zeros for the
 * current response without caching them.
 */
async function fetchMergeVelocity(
  client: GraphQLClient,
  owner: string,
  repo: string
): Promise<Record<60 | 120 | 180, number> | null> {
  try {
    const mergedSearchBase = `repo:${owner}/${repo} is:pr is:merged`;
    const now = Date.now();
    const mergedQueryVars = Object.fromEntries(
      ([60, 120, 180] as const).map((days) => {
        const since = new Date(now - days * 24 * 60 * 60 * 1000);
        const dateStr = since.toISOString().slice(0, 10);
        return [`merged${days}`, `${mergedSearchBase} merged:>=${dateStr}`];
      })
    );

    const result = (await client(MERGE_VELOCITY_QUERY, {
      ...mergedQueryVars,
      request: { signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS) },
    })) as GraphQlQueryResponseData;

    gitHubRateLimitService.updateFromGraphQL(result, "MERGE_VELOCITY_QUERY");
    return extractMergedCounts(result);
  } catch (error) {
    console.warn("[github] merged-PR velocity fetch failed:", error);
    return null;
  }
}

function parseProjectHealthResponse(
  repository: Record<string, unknown>,
  issueCount: number,
  prCount: number,
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
    issueCount,
    prCount,
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

/**
 * Resolve the merged-PR velocity for the repo, preferring the per-day cache.
 * `bypassCache` deliberately does NOT bypass the velocity cache: the velocity
 * windows shift on a days timescale, so a manual "refresh" should re-fetch the
 * fast-changing health fields, not re-run three heavy `search` blocks.
 */
async function resolveMergeVelocity(
  client: GraphQLClient,
  owner: string,
  repo: string,
  velocityKey: string
): Promise<Record<60 | 120 | 180, number>> {
  const cached = velocityCache.get(velocityKey);
  if (cached) return cached;

  const fetched = await fetchMergeVelocity(client, owner, repo);
  if (fetched) {
    velocityCache.set(velocityKey, fetched);
    return fetched;
  }
  return { 60: 0, 120: 0, 180: 0 };
}

export interface ProjectHealthForContextOptions {
  bypassCache?: boolean;
  /**
   * Re-resolve the repo context after a repo-not-found error. Supplied by the
   * cwd wrapper to preserve its remote-changed retry; context-only callers
   * (the forge `projectHealth` capability) omit it and get no retry.
   */
  refreshContext?: () => Promise<RepoContext | null>;
}

export async function getProjectHealthForContext(
  context: RepoContext,
  options: ProjectHealthForContextOptions = {},
  _retried = false
): Promise<ProjectHealthResult> {
  const bypassCache = options.bypassCache === true;
  const cacheKey = `${context.owner}/${context.repo}`;
  const repoUrl = `https://github.com/${context.owner}/${context.repo}`;

  const client = GitHubAuth.createClient();
  if (!client) {
    return { health: null, error: "GitHub token not configured. Set it in Settings." };
  }

  const rateLimitBlock = gitHubRateLimitService.shouldBlockRequest("graphql");
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

  const counts = readCachedCounts(cacheKey);
  const velocityKey = buildVelocityCacheKey(cacheKey, new Date());

  try {
    const mergedCounts = await resolveMergeVelocity(
      client,
      context.owner,
      context.repo,
      velocityKey
    );

    const result = (await client(PROJECT_HEALTH_QUERY, {
      owner: context.owner,
      repo: context.repo,
      request: { signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS) },
    })) as GraphQlQueryResponseData;

    gitHubRateLimitService.updateFromGraphQL(result, "PROJECT_HEALTH_QUERY");

    const repository = result?.repository;
    if (!repository) {
      return { health: null, error: "Repository not found" };
    }

    const health = parseProjectHealthResponse(
      repository as Record<string, unknown>,
      counts.issueCount,
      counts.prCount,
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
        const mergedCounts = velocityCache.get(velocityKey) ?? { 60: 0, 120: 0, 180: 0 };
        const health = parseProjectHealthResponse(
          repository,
          counts.issueCount,
          counts.prCount,
          mergedCounts,
          repoUrl
        );
        projectHealthCache.set(cacheKey, health);
        return { health };
      }
    }

    if (!_retried && isRepoNotFoundError(error) && options.refreshContext) {
      const freshContext = await options.refreshContext();
      if (
        freshContext &&
        (freshContext.owner !== context.owner || freshContext.repo !== context.repo)
      ) {
        return getProjectHealthForContext(freshContext, options, true);
      }
    }

    return { health: null, error: parseGitHubError(error) };
  }
}

export async function getProjectHealth(
  cwd: string,
  bypassCache = false
): Promise<ProjectHealthResult> {
  const context = await getRepoContext(cwd);
  if (!context) {
    return { health: null, error: "Not a GitHub repository" };
  }

  return getProjectHealthForContext(context, {
    bypassCache,
    refreshContext: async () => {
      repoContextCache.invalidate(cwd);
      return getRepoContext(cwd);
    },
  });
}
