import type { GraphQlQueryResponseData } from "@octokit/graphql";
import { GitHubAuth, GITHUB_API_TIMEOUT_MS } from "./GitHubAuth.js";
import {
  LIST_PRS_QUERY,
  SEARCH_QUERY,
  GET_PR_QUERY,
  buildBatchRequiredChecksQuery,
} from "./GitHubQueries.js";
import { parseGitHubError } from "./GitHubErrors.js";
import { withRepoContextRetry } from "./GitHubRepoContext.js";
import {
  repoStatsCache,
  prListCache,
  prTooltipCache,
  prTooltipWrittenAt,
  prRequiredStatusCache,
  truncateBody,
  type PRRequiredStatusEntry,
} from "./GitHubCaches.js";
import { GitHubStatsCache } from "../GitHubStatsCache.js";
import { deriveRequiredCIStatus } from "./prRequiredCIStatus.js";
import type { RollupContextNode } from "./prRequiredCIStatus.js";
import type {
  GitHubPR,
  GitHubListOptions,
  GitHubListResponse,
  PRTooltipData,
} from "../../../shared/types/github.js";
import type { RepoContext, RepoStats } from "./types.js";

export function buildListCacheKey(
  type: "issue" | "pr",
  owner: string,
  repo: string,
  state: string,
  search: string,
  sortOrder: string,
  cursor: string
): string {
  return `${type}:${owner}/${repo}:${state}:${search}:${sortOrder}:${cursor}`;
}

export function updateRepoStatsCount(cacheKey: string, type: "issue" | "pr", count: number): void {
  const cached = repoStatsCache.get(cacheKey);
  if (cached) {
    const updated: RepoStats = {
      ...cached,
      lastUpdated: Date.now(),
    };
    if (type === "issue") {
      updated.issueCount = count;
    } else {
      updated.prCount = count;
    }
    repoStatsCache.set(cacheKey, updated);
  } else {
    const persistentCache = GitHubStatsCache.getInstance();
    const diskCached = persistentCache.get(cacheKey);

    const newStats: RepoStats = {
      issueCount: type === "issue" ? count : (diskCached?.issueCount ?? 0),
      prCount: type === "pr" ? count : (diskCached?.prCount ?? 0),
      lastUpdated: Date.now(),
    };
    repoStatsCache.set(cacheKey, newStats);
  }
}

export function parsePRNode(node: Record<string, unknown>): GitHubPR {
  const author = node.author as { login?: string; avatarUrl?: string } | null;
  const reviewsData = node.reviews as { totalCount?: number };
  const commentsData = node.comments as { totalCount?: number };
  const merged = node.merged as boolean;
  const rawState = node.state as string;
  const headRepo = node.headRepository as { nameWithOwner?: string } | null;
  const baseRepo = node.baseRepository as { nameWithOwner?: string } | null;

  let state: "OPEN" | "CLOSED" | "MERGED" = rawState as "OPEN" | "CLOSED" | "MERGED";
  if (merged) {
    state = "MERGED";
  }

  const headName = headRepo?.nameWithOwner;
  const baseName = baseRepo?.nameWithOwner;
  const isFork = headName && baseName ? headName !== baseName : undefined;

  const commitsData = node.commits as
    | { nodes?: Array<{ commit?: { statusCheckRollup?: { state?: string } | null } | null }> }
    | undefined;
  const ciStatus = commitsData?.nodes?.[0]?.commit?.statusCheckRollup?.state as
    | GitHubPRCIStatus
    | undefined;

  return {
    number: node.number as number,
    title: node.title as string,
    url: node.url as string,
    state,
    isDraft: (node.isDraft as boolean) ?? false,
    updatedAt: node.updatedAt as string,
    author: {
      login: author?.login ?? "unknown",
      avatarUrl: author?.avatarUrl ?? "",
    },
    reviewCount: reviewsData?.totalCount,
    commentCount: commentsData?.totalCount,
    headRefName: (node.headRefName as string) || undefined,
    isFork: isFork ?? undefined,
    ciStatus,
  };
}

export function mapPRStates(state?: string): string[] {
  if (!state || state === "open") return ["OPEN"];
  if (state === "closed") return ["CLOSED"];
  if (state === "merged") return ["MERGED"];
  if (state === "all") return ["OPEN", "CLOSED", "MERGED"];
  return ["OPEN"];
}

export async function getPRTooltip(cwd: string, prNumber: number): Promise<PRTooltipData | null> {
  const client = GitHubAuth.createClient();
  if (!client) {
    return null;
  }

  try {
    return await withRepoContextRetry(cwd, async (context) => {
      const cacheKey = `${context.owner}/${context.repo}:${prNumber}`;
      const cached = prTooltipCache.get(cacheKey);
      if (cached) {
        return cached;
      }

      const requestedAt = Date.now();
      const response = (await client(GET_PR_QUERY, {
        owner: context.owner,
        repo: context.repo,
        number: prNumber,
        request: { signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS) },
      })) as GraphQlQueryResponseData;

      const pr = response?.repository?.pullRequest;
      if (!pr) {
        return null;
      }

      const author = pr.author as { login?: string; avatarUrl?: string } | null;
      const assigneesData = pr.assignees as {
        nodes?: Array<{ login?: string; avatarUrl?: string }>;
      };
      const labelsData = pr.labels as { nodes?: Array<{ name?: string; color?: string }> };
      const merged = pr.merged as boolean;
      const rawState = pr.state as string;

      let state: "OPEN" | "CLOSED" | "MERGED" = rawState as "OPEN" | "CLOSED" | "MERGED";
      if (merged) {
        state = "MERGED";
      }

      const tooltipData: PRTooltipData = {
        number: pr.number as number,
        title: pr.title as string,
        bodyExcerpt: truncateBody(pr.bodyText as string | null),
        state,
        isDraft: (pr.isDraft as boolean) ?? false,
        createdAt: pr.createdAt as string,
        author: {
          login: author?.login ?? "unknown",
          avatarUrl: author?.avatarUrl ?? "",
        },
        assignees: (assigneesData?.nodes ?? []).filter(Boolean).map((a) => ({
          login: a.login ?? "unknown",
          avatarUrl: a.avatarUrl ?? "",
        })),
        labels: (labelsData?.nodes ?? []).filter(Boolean).map((l) => ({
          name: l.name ?? "",
          color: l.color ?? "",
        })),
      };

      const existing = prTooltipWrittenAt.get(cacheKey);
      if (existing === undefined || requestedAt >= existing) {
        prTooltipCache.set(cacheKey, tooltipData);
        prTooltipWrittenAt.set(cacheKey, requestedAt);
      }
      return tooltipData;
    });
  } catch {
    return null;
  }
}

async function enrichPRsWithRequiredStatus(
  context: RepoContext,
  prs: GitHubPR[],
  client: NonNullable<ReturnType<typeof GitHubAuth.createClient>>,
  bypassCache = false
): Promise<GitHubPR[]> {
  const candidates = prs.filter(
    (pr) => pr.state === "OPEN" && pr.ciStatus !== undefined && pr.ciSummary === undefined
  );
  if (candidates.length === 0) return prs;

  const cacheKeyFor = (n: number) => `${context.owner}/${context.repo}:${n}`;
  const numbersToFetch: number[] = [];
  const cached = new Map<number, PRRequiredStatusEntry>();

  for (const pr of candidates) {
    const hit = bypassCache ? undefined : prRequiredStatusCache.get(cacheKeyFor(pr.number));
    if (hit) {
      cached.set(pr.number, hit);
    } else {
      numbersToFetch.push(pr.number);
    }
  }

  let fetched = new Map<number, PRRequiredStatusEntry>();
  if (numbersToFetch.length > 0) {
    try {
      const query = buildBatchRequiredChecksQuery(context.owner, context.repo, numbersToFetch);
      if (query) {
        const response = (await client(query, {
          request: { signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS) },
        })) as Record<string, unknown>;
        fetched = parseBatchRequiredChecksResponse(response, numbersToFetch);
        for (const [num, entry] of fetched) {
          prRequiredStatusCache.set(cacheKeyFor(num), entry);
        }
      }
    } catch {
      // Best-effort — fall through; PRs keep their raw ciStatus and no ciSummary.
    }
  }

  return prs.map((pr) => {
    const entry = cached.get(pr.number) ?? fetched.get(pr.number);
    if (!entry) return pr;
    return {
      ...pr,
      ciStatus: entry.ciStatus ?? pr.ciStatus,
      ciSummary: entry.ciSummary,
    };
  });
}

function parseBatchRequiredChecksResponse(
  data: Record<string, unknown>,
  prNumbers: number[]
): Map<number, PRRequiredStatusEntry> {
  const out = new Map<number, PRRequiredStatusEntry>();
  for (const num of prNumbers) {
    const alias = `pr_${num}`;
    const repo = data?.[alias] as
      | {
          pullRequest?: {
            commits?: {
              nodes?: Array<{
                commit?: {
                  statusCheckRollup?: {
                    state?: string | null;
                    contexts?: {
                      pageInfo?: { hasNextPage?: boolean };
                      nodes?: RollupContextNode[];
                    };
                  } | null;
                } | null;
              }>;
            };
          };
        }
      | undefined;
    const rollup = repo?.pullRequest?.commits?.nodes?.[0]?.commit?.statusCheckRollup;
    if (!rollup) continue;
    const derived = deriveRequiredCIStatus(
      rollup.contexts?.nodes,
      rollup.contexts?.pageInfo?.hasNextPage ?? false,
      rollup.state
    );
    out.set(num, { ciStatus: derived.ciStatus, ciSummary: derived.ciSummary });
  }
  return out;
}

export async function listPullRequests(
  options: GitHubListOptions
): Promise<GitHubListResponse<GitHubPR>> {
  const client = GitHubAuth.createClient();
  if (!client) {
    throw new Error("GitHub token not configured. Set it in Settings.");
  }

  const resolvedSortOrder = options.sortOrder ?? "created";
  const orderBy = {
    field: resolvedSortOrder === "updated" ? "UPDATED_AT" : "CREATED_AT",
    direction: "DESC",
  };

  return withRepoContextRetry(options.cwd, async (context) => {
    const cacheKey = buildListCacheKey(
      "pr",
      context.owner,
      context.repo,
      options.state ?? "open",
      options.search ?? "",
      resolvedSortOrder,
      options.cursor ?? ""
    );

    if (!options.search && !options.bypassCache) {
      const cached = prListCache.get(cacheKey);
      if (cached) return cached;
    }

    try {
      let result: GitHubListResponse<GitHubPR>;

      if (options.search) {
        let stateFilter = "";
        if (options.state === "open") stateFilter = "is:open";
        else if (options.state === "closed") stateFilter = "is:closed is:unmerged";
        else if (options.state === "merged") stateFilter = "is:merged";

        const sortQualifier =
          resolvedSortOrder === "updated" ? "sort:updated-desc" : "sort:created-desc";
        const searchQuery =
          `repo:${context.owner}/${context.repo} is:pr ${stateFilter} ${sortQualifier} ${options.search}`.trim();

        const response = (await client(SEARCH_QUERY, {
          searchQuery,
          type: "ISSUE",
          cursor: options.cursor,
          limit: 20,
          request: { signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS) },
        })) as GraphQlQueryResponseData;

        const search = response?.search;
        const nodes = (search?.nodes ?? []) as Array<Record<string, unknown>>;

        const parsedItems = nodes.filter(Boolean).map(parsePRNode);
        const enrichedItems = await enrichPRsWithRequiredStatus(
          context,
          parsedItems,
          client,
          options.bypassCache ?? false
        );
        result = {
          items: enrichedItems,
          pageInfo: {
            hasNextPage: search?.pageInfo?.hasNextPage ?? false,
            endCursor: search?.pageInfo?.endCursor ?? null,
          },
        };
      } else {
        const states = mapPRStates(options.state);

        const response = (await client(LIST_PRS_QUERY, {
          owner: context.owner,
          repo: context.repo,
          states,
          cursor: options.cursor,
          limit: 20,
          orderBy,
          request: { signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS) },
        })) as GraphQlQueryResponseData;

        if (!response?.repository) {
          throw new Error("Repository not found or token lacks access.");
        }

        const pullRequests = response?.repository?.pullRequests;
        const nodes = (pullRequests?.nodes ?? []) as Array<Record<string, unknown>>;
        const totalCount = (pullRequests?.totalCount as number) ?? undefined;

        const parsedItems = nodes.filter(Boolean).map(parsePRNode);
        const enrichedItems = await enrichPRsWithRequiredStatus(
          context,
          parsedItems,
          client,
          options.bypassCache ?? false
        );
        result = {
          items: enrichedItems,
          pageInfo: {
            hasNextPage: pullRequests?.pageInfo?.hasNextPage ?? false,
            endCursor: pullRequests?.pageInfo?.endCursor ?? null,
          },
        };

        prListCache.set(cacheKey, result);

        if (
          (!options.state || options.state === "open") &&
          !options.cursor &&
          totalCount !== undefined
        ) {
          const statsCacheKey = `${context.owner}/${context.repo}`;
          updateRepoStatsCount(statsCacheKey, "pr", totalCount);

          const memoryStats = repoStatsCache.get(statsCacheKey);
          if (memoryStats && memoryStats.issueCount > 0 && memoryStats.prCount > 0) {
            const persistentCache = GitHubStatsCache.getInstance();
            persistentCache.set(
              statsCacheKey,
              {
                issueCount: memoryStats.issueCount,
                prCount: memoryStats.prCount,
              },
              options.cwd
            );
          }
        }
      }

      return result;
    } catch (error) {
      throw new Error(parseGitHubError(error));
    }
  });
}

export async function getPRByNumber(cwd: string, prNumber: number): Promise<GitHubPR | null> {
  const client = GitHubAuth.createClient();
  if (!client) {
    throw new Error("GitHub token not configured. Set it in Settings.");
  }

  try {
    return await withRepoContextRetry(cwd, async (context) => {
      const response = (await client(GET_PR_QUERY, {
        owner: context.owner,
        repo: context.repo,
        number: prNumber,
        request: { signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS) },
      })) as GraphQlQueryResponseData;

      const pr = response?.repository?.pullRequest;
      if (!pr) {
        return null;
      }

      return parsePRNode(pr as Record<string, unknown>);
    });
  } catch (error) {
    const message = (error as Error).message || "";
    if (message === "Not a GitHub repository") {
      throw error;
    }
    if (message.includes("Could not resolve to") || message.includes("Could not resolve")) {
      return null;
    }
    throw new Error(parseGitHubError(error));
  }
}
