import type { GraphQlQueryResponseData } from "@octokit/graphql";
import { GitHubAuth, GITHUB_API_TIMEOUT_MS, rateLimitAwareFetch } from "./GitHubAuth.js";
import {
  LIST_ISSUES_QUERY,
  SEARCH_QUERY,
  GET_ISSUE_QUERY,
  buildBatchIssuesQuery,
  GRAPHQL_BATCH_CHUNK_SIZE,
} from "./GitHubQueries.js";
import { gitHubRateLimitService } from "./GitHubRateLimitService.js";
import { parseGitHubError } from "./GitHubErrors.js";
import { withRepoContextRetry } from "./GitHubRepoContext.js";
import {
  repoStatsCache,
  issueListCache,
  issueTooltipCache,
  issueTooltipWrittenAt,
  getRepoListEpoch,
} from "./GitHubCaches.js";
import { GitHubStatsCache } from "./GitHubStatsCache.js";
import { buildListCacheKey, DEFAULT_LIST_PER_PAGE, updateRepoStatsCount } from "./GitHubPRs.js";
import { truncateBody, isoToEpochMs } from "./GitHubCaches.js";
import type {
  GitHubIssue,
  GitHubUser,
  GitHubListOptions,
  GitHubListResponse,
} from "../shared/types.js";
import type { ForgeLabel, ForgeUser, IssueTooltipData } from "../../../../shared/types/forge.js";
import type { RepoContext } from "./types.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import { extractLinkedPR } from "./mappers.js";

// Re-exported from its new home in `mappers.ts` (#11527): both mapper families
// need it, and `mappers.ts` is a leaf module, so the forge mapper can reach it
// without importing this module's auth/cache/query machinery.
export { extractLinkedPR };

export function parseIssueNode(node: Record<string, unknown>): GitHubIssue {
  const author = node.author as { login?: string; avatarUrl?: string } | null;
  const assigneesData = node.assignees as { nodes?: Array<{ login?: string; avatarUrl?: string }> };
  const commentsData = node.comments as { totalCount?: number };
  const labelsData = node.labels as { nodes?: Array<{ name?: string; color?: string }> };

  const linkedPR = extractLinkedPR(node.timelineItems);

  return {
    number: node.number as number,
    title: node.title as string,
    url: node.url as string,
    state: node.state as "OPEN" | "CLOSED",
    updatedAt: node.updatedAt as string,
    author: {
      login: author?.login ?? "unknown",
      avatarUrl: author?.avatarUrl ?? "",
    },
    assignees: (assigneesData?.nodes ?? []).filter(Boolean).map((a) => ({
      login: a.login ?? "unknown",
      avatarUrl: a.avatarUrl ?? "",
    })),
    commentCount: commentsData?.totalCount ?? 0,
    labels: (labelsData?.nodes ?? []).filter(Boolean).map((l) => ({
      name: l.name ?? "",
      color: l.color ?? "",
    })),
    linkedPR,
  };
}

export function mapIssueStates(state?: string): string[] {
  if (!state || state === "open") return ["OPEN"];
  if (state === "closed") return ["CLOSED"];
  if (state === "all") return ["OPEN", "CLOSED"];
  return ["OPEN"];
}

export interface AssignIssueResult {
  username: string;
  avatarUrl: string;
}

export async function assignIssue(
  cwd: string,
  issueNumber: number,
  username: string
): Promise<AssignIssueResult> {
  const token = GitHubAuth.getToken();
  if (!token) {
    throw new Error("GitHub token not configured. Set it in Settings.");
  }

  return withRepoContextRetry(cwd, async (context) => {
    const url = `https://api.github.com/repos/${context.owner}/${context.repo}/issues/${issueNumber}/assignees`;

    try {
      const response = await rateLimitAwareFetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ assignees: [username] }),
        signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
      });

      if (!response.ok) {
        let body: { message?: string; errors?: Array<{ code?: string; message?: string }> } | null =
          null;
        try {
          body = await response.json();
        } catch {
          // Body is not JSON or already consumed — continue with null
        }

        if (response.status === 401) {
          throw new Error("Invalid GitHub token. Please update in Settings.");
        }
        if (response.status === 403) {
          throw new Error("Token lacks required permissions. Required scopes: repo, read:org");
        }
        if (response.status === 404) {
          throw new Error("Issue not found or you don't have access to this repository");
        }
        if (response.status === 422) {
          const errors = body?.errors ?? [];
          if (errors.some((e) => e?.code === "too_many_assignees")) {
            throw new Error(
              `Cannot assign user "${username}" - issue already has the maximum 10 assignees`
            );
          }
          if (errors.some((e) => e?.code === "invalid")) {
            throw new Error(`Cannot assign user "${username}" - they may not be a collaborator`);
          }
          const githubMessage = errors[0]?.message ?? body?.message;
          throw new Error(`Cannot assign user "${username}" - ${githubMessage || "HTTP 422"}`);
        }
        throw new Error(
          `Cannot assign user "${username}" - server error (HTTP ${response.status})`
        );
      }

      const data = (await response.json()) as {
        assignees?: Array<{ login?: string; avatar_url?: string }>;
      };

      if (!Array.isArray(data.assignees)) {
        throw new Error("Invalid GitHub API response: assignees field missing or malformed");
      }

      const assignee = data.assignees.find(
        (a) => a.login?.toLowerCase() === username.toLowerCase()
      );
      if (!assignee?.login) {
        throw new Error(`Assignment succeeded but user "${username}" not found in response`);
      }

      const assigneeData = {
        login: assignee.login,
        avatarUrl: assignee.avatar_url ?? "",
      };

      updateIssueAssigneeInCache(context.owner, context.repo, issueNumber, assigneeData);

      return { username: assigneeData.login, avatarUrl: assigneeData.avatarUrl };
    } catch (error) {
      throw new Error(parseGitHubError(error));
    }
  });
}

export async function unassignIssue(
  cwd: string,
  issueNumber: number,
  username: string
): Promise<void> {
  const token = GitHubAuth.getToken();
  if (!token) {
    throw new Error("GitHub token not configured. Set it in Settings.");
  }

  return withRepoContextRetry(cwd, async (context) => {
    const url = `https://api.github.com/repos/${context.owner}/${context.repo}/issues/${issueNumber}/assignees`;

    try {
      const response = await rateLimitAwareFetch(url, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ assignees: [username] }),
        signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error("Invalid GitHub token. Please update in Settings.");
        }
        if (response.status === 403) {
          throw new Error("Token lacks required permissions. Required scopes: repo, read:org");
        }
        if (response.status === 404) {
          throw new Error("Issue not found or you don't have access to this repository");
        }
        throw new Error(
          `Cannot unassign user "${username}" - server error (HTTP ${response.status})`
        );
      }

      removeIssueAssigneeFromCache(context.owner, context.repo, issueNumber, username);
    } catch (error) {
      throw new Error(parseGitHubError(error), { cause: error });
    }
  });
}

function updateIssueAssigneeInCache(
  owner: string,
  repo: string,
  issueNumber: number,
  assignee: { login: string; avatarUrl: string }
): void {
  const cachePrefix = `issue:${owner}/${repo}:`;

  const updates: Array<{ key: string; value: GitHubListResponse<GitHubIssue> }> = [];

  issueListCache.forEach((value, key) => {
    if (!key.startsWith(cachePrefix)) return;

    const issueIndex = value.items.findIndex((issue) => issue.number === issueNumber);
    if (issueIndex === -1) return;

    const existingAssignees = value.items[issueIndex].assignees;
    const existingIndex = existingAssignees.findIndex(
      (a) => a.login.toLowerCase() === assignee.login.toLowerCase()
    );

    let updatedAssignees: GitHubUser[];
    if (existingIndex !== -1) {
      if (existingAssignees[existingIndex].avatarUrl !== assignee.avatarUrl) {
        updatedAssignees = [...existingAssignees];
        updatedAssignees[existingIndex] = assignee;
      } else {
        return;
      }
    } else {
      updatedAssignees = [...existingAssignees, assignee];
    }

    const updatedItems = [...value.items];
    updatedItems[issueIndex] = {
      ...updatedItems[issueIndex],
      assignees: updatedAssignees,
    };

    updates.push({
      key,
      value: {
        ...value,
        items: updatedItems,
      },
    });
  });

  for (const update of updates) {
    issueListCache.set(update.key, update.value);
  }

  issueTooltipCache.invalidate(`${owner}/${repo}:${issueNumber}`);
}

function removeIssueAssigneeFromCache(
  owner: string,
  repo: string,
  issueNumber: number,
  username: string
): void {
  const cachePrefix = `issue:${owner}/${repo}:`;
  const normalizedUsername = username.toLowerCase();

  const updates: Array<{ key: string; value: GitHubListResponse<GitHubIssue> }> = [];

  issueListCache.forEach((value, key) => {
    if (!key.startsWith(cachePrefix)) return;

    const issueIndex = value.items.findIndex((issue) => issue.number === issueNumber);
    if (issueIndex === -1) return;

    const existingAssignees = value.items[issueIndex].assignees;
    const existingIndex = existingAssignees.findIndex(
      (a) => a.login.toLowerCase() === normalizedUsername
    );
    if (existingIndex === -1) return;

    const updatedAssignees = [
      ...existingAssignees.slice(0, existingIndex),
      ...existingAssignees.slice(existingIndex + 1),
    ];

    const updatedItems = [...value.items];
    updatedItems[issueIndex] = {
      ...updatedItems[issueIndex],
      assignees: updatedAssignees,
    };

    updates.push({
      key,
      value: {
        ...value,
        items: updatedItems,
      },
    });
  });

  for (const update of updates) {
    issueListCache.set(update.key, update.value);
  }

  issueTooltipCache.invalidate(`${owner}/${repo}:${issueNumber}`);
}

const inFlightIssueTooltips = new Map<string, Promise<IssueTooltipData | null>>();

/** GraphQL `{ login, avatarUrl }` actor node → forge {@link ForgeUser} tooltip projection. */
function toTooltipUser(node: { login?: string; avatarUrl?: string } | null | undefined): ForgeUser {
  return { login: node?.login ?? "unknown", avatarUrl: node?.avatarUrl ?? "", rawData: null };
}

function toTooltipLabels(
  nodes: Array<{ name?: string; color?: string }> | undefined
): ForgeLabel[] {
  return (nodes ?? []).filter(Boolean).map((l) => ({ name: l.name ?? "", color: l.color ?? "" }));
}

/**
 * Context-variant core of {@link getIssueTooltip}. Network errors propagate so
 * the cwd wrapper's repo-context retry can classify them; capability callers
 * (forge `tooltips`) catch and return `null` themselves.
 */
export async function getIssueTooltipForContext(
  context: RepoContext,
  issueNumber: number
): Promise<IssueTooltipData | null> {
  const client = GitHubAuth.createClient();
  if (!client) {
    return null;
  }

  const cacheKey = `${context.owner}/${context.repo}:${issueNumber}`;
  const cached = issueTooltipCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const inFlight = inFlightIssueTooltips.get(cacheKey);
  if (inFlight) return inFlight;

  const requestedAt = Date.now();
  const promise = (async () => {
    const response = (await client(GET_ISSUE_QUERY, {
      owner: context.owner,
      repo: context.repo,
      number: issueNumber,
      request: { signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS) },
    })) as GraphQlQueryResponseData;

    gitHubRateLimitService.updateFromGraphQL(response, "GET_ISSUE_QUERY");

    const issue = response?.repository?.issue;
    if (!issue) {
      return null;
    }

    const author = issue.author as { login?: string; avatarUrl?: string } | null;
    const assigneesData = issue.assignees as {
      nodes?: Array<{ login?: string; avatarUrl?: string }>;
    };
    const labelsData = issue.labels as { nodes?: Array<{ name?: string; color?: string }> };
    const rawState = (issue.state as string) ?? "OPEN";

    const tooltipData: IssueTooltipData = {
      number: issue.number as number,
      title: issue.title as string,
      bodyExcerpt: truncateBody(issue.bodyText as string | null),
      state: rawState.toUpperCase() === "CLOSED" ? "closed" : "open",
      rawState,
      createdAt: isoToEpochMs(issue.createdAt),
      author: toTooltipUser(author),
      assignees: (assigneesData?.nodes ?? []).filter(Boolean).map(toTooltipUser),
      labels: toTooltipLabels(labelsData?.nodes),
    };

    const existing = issueTooltipWrittenAt.get(cacheKey);
    if (existing === undefined || requestedAt >= existing) {
      issueTooltipCache.set(cacheKey, tooltipData);
      issueTooltipWrittenAt.set(cacheKey, requestedAt);
    }
    return tooltipData;
  })();

  inFlightIssueTooltips.set(cacheKey, promise);
  promise.then(
    () => {
      inFlightIssueTooltips.delete(cacheKey);
    },
    () => {
      inFlightIssueTooltips.delete(cacheKey);
    }
  );

  return promise;
}

export async function getIssueTooltip(
  cwd: string,
  issueNumber: number
): Promise<IssueTooltipData | null> {
  try {
    return await withRepoContextRetry(cwd, (context) =>
      getIssueTooltipForContext(context, issueNumber)
    );
  } catch {
    return null;
  }
}

function prewarmIssueTooltips(
  owner: string,
  repo: string,
  nodes: Array<Record<string, unknown>>
): void {
  const requestedAt = Date.now();
  for (const node of nodes) {
    const num = node.number as number;
    if (!num) continue;
    const cacheKey = `${owner}/${repo}:${num}`;
    const existing = issueTooltipWrittenAt.get(cacheKey);
    if (existing !== undefined && requestedAt < existing) continue;
    const author = node.author as { login?: string; avatarUrl?: string } | null;
    const assigneesData = node.assignees as {
      nodes?: Array<{ login?: string; avatarUrl?: string }>;
    };
    const labelsData = node.labels as { nodes?: Array<{ name?: string; color?: string }> };
    const rawState = (node.state as string) ?? "OPEN";
    issueTooltipCache.set(cacheKey, {
      number: num,
      title: node.title as string,
      bodyExcerpt: truncateBody(node.bodyText as string | null),
      state: rawState.toUpperCase() === "CLOSED" ? "closed" : "open",
      rawState,
      createdAt: isoToEpochMs(node.createdAt),
      author: toTooltipUser(author),
      assignees: (assigneesData?.nodes ?? []).filter(Boolean).map(toTooltipUser),
      labels: toTooltipLabels(labelsData?.nodes),
    });
    issueTooltipWrittenAt.set(cacheKey, requestedAt);
  }
}

export async function listIssues(
  options: GitHubListOptions
): Promise<GitHubListResponse<GitHubIssue>> {
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
    const cacheKey = buildListCacheKey({
      type: "issue",
      owner: context.owner,
      repo: context.repo,
      state: options.state ?? "open",
      search: options.search ?? "",
      sortOrder: resolvedSortOrder,
      // This legacy path pins both: `orderBy.direction` is hardcoded DESC above
      // and every query below requests `limit: 20`.
      direction: "desc",
      perPage: DEFAULT_LIST_PER_PAGE,
      cursor: options.cursor ?? "",
    });

    if (!options.search && !options.bypassCache) {
      const cached = issueListCache.get(cacheKey);
      if (cached) return cached;
    }

    // Captured before the network call: if the count-as-cache-buster bumps
    // the epoch mid-flight, this page predates the observed change and must
    // not repopulate the just-busted cache.
    const epochAtStart = getRepoListEpoch("issue", context.owner, context.repo);

    try {
      let result: GitHubListResponse<GitHubIssue>;

      if (options.search) {
        const stateFilter =
          options.state === "closed" ? "is:closed" : options.state === "all" ? "" : "is:open";
        const sortQualifier =
          resolvedSortOrder === "updated" ? "sort:updated-desc" : "sort:created-desc";
        const prefix = `repo:${context.owner}/${context.repo} is:issue ${stateFilter} ${sortQualifier} `;
        const available = 256 - prefix.length;
        const truncatedSearch = available > 0 ? options.search.slice(0, available) : "";
        const searchQuery = `${prefix}${truncatedSearch}`.trim();

        const response = (await client(SEARCH_QUERY, {
          searchQuery,
          type: "ISSUE",
          cursor: options.cursor,
          limit: 20,
          request: { signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS) },
        })) as GraphQlQueryResponseData;

        gitHubRateLimitService.updateFromGraphQL(response, "SEARCH_ISSUES_QUERY");

        const search = response?.search;
        const nodes = (search?.nodes ?? []) as Array<Record<string, unknown>>;
        const filteredNodes = nodes.filter(Boolean);

        prewarmIssueTooltips(context.owner, context.repo, filteredNodes);

        result = {
          items: filteredNodes.map(parseIssueNode),
          pageInfo: {
            hasNextPage: search?.pageInfo?.hasNextPage ?? false,
            endCursor: search?.pageInfo?.endCursor ?? null,
          },
        };
      } else {
        const states = mapIssueStates(options.state);

        const response = (await client(LIST_ISSUES_QUERY, {
          owner: context.owner,
          repo: context.repo,
          states,
          cursor: options.cursor,
          limit: 20,
          orderBy,
          request: { signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS) },
        })) as GraphQlQueryResponseData;

        gitHubRateLimitService.updateFromGraphQL(response, "LIST_ISSUES_QUERY");

        const issues = response?.repository?.issues;
        const nodes = (issues?.nodes ?? []) as Array<Record<string, unknown>>;
        const totalCount = (issues?.totalCount as number) ?? undefined;
        const filteredNodes = nodes.filter(Boolean);

        prewarmIssueTooltips(context.owner, context.repo, filteredNodes);

        result = {
          items: filteredNodes.map(parseIssueNode),
          pageInfo: {
            hasNextPage: issues?.pageInfo?.hasNextPage ?? false,
            endCursor: issues?.pageInfo?.endCursor ?? null,
          },
          totalCount,
        };

        // Mid-flight count-buster guard — see `getRepoListEpoch`. The stats
        // updates sit behind the same guard: a response too old to repopulate
        // the list cache is also too old to roll `repoStatsCache` (or the
        // disk stats) back to its pre-change total under a fresh
        // `lastUpdated`.
        if (getRepoListEpoch("issue", context.owner, context.repo) === epochAtStart) {
          issueListCache.set(cacheKey, result);

          if (
            (!options.state || options.state === "open") &&
            !options.cursor &&
            totalCount !== undefined
          ) {
            const statsCacheKey = `${context.owner}/${context.repo}`;
            updateRepoStatsCount(statsCacheKey, "issue", totalCount);

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
      }

      return result;
    } catch (error) {
      throw new Error(parseGitHubError(error));
    }
  });
}

export async function getIssueByNumber(
  cwd: string,
  issueNumber: number
): Promise<GitHubIssue | null> {
  const client = GitHubAuth.createClient();
  if (!client) {
    throw new Error("GitHub token not configured. Set it in Settings.");
  }

  try {
    return await withRepoContextRetry(cwd, async (context) => {
      const response = (await client(GET_ISSUE_QUERY, {
        owner: context.owner,
        repo: context.repo,
        number: issueNumber,
        request: { signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS) },
      })) as GraphQlQueryResponseData;

      gitHubRateLimitService.updateFromGraphQL(response, "GET_ISSUE_QUERY");

      const issue = response?.repository?.issue;
      if (!issue) {
        return null;
      }

      return parseIssueNode(issue as Record<string, unknown>);
    });
  } catch (error) {
    const message = formatErrorMessage(error, "Failed to fetch GitHub issue");
    if (message === "Not a GitHub repository") {
      throw error;
    }
    if (message.includes("Could not resolve to") || message.includes("Could not resolve")) {
      return null;
    }
    throw new Error(parseGitHubError(error));
  }
}

/**
 * Context-variant core of {@link getIssuesByNumbers}. Results align with the
 * positive-integer-filtered input order; errors propagate so the cwd wrapper's
 * repo-context retry and error classification stay in charge.
 */
export async function getIssuesByNumbersForContext(
  context: RepoContext,
  numbers: number[]
): Promise<Array<GitHubIssue | null>> {
  const client = GitHubAuth.createClient();
  if (!client) {
    throw new Error("GitHub token not configured. Set it in Settings.");
  }

  const valid = numbers.filter((n) => typeof n === "number" && Number.isInteger(n) && n > 0);
  if (valid.length === 0) return [];

  const results: Array<GitHubIssue | null> = [];

  for (let i = 0; i < valid.length; i += GRAPHQL_BATCH_CHUNK_SIZE) {
    const chunk = valid.slice(i, i + GRAPHQL_BATCH_CHUNK_SIZE);
    const query = buildBatchIssuesQuery(context.owner, context.repo, chunk);
    if (!query) continue;

    const response = (await client(query, {
      request: { signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS) },
    })) as GraphQlQueryResponseData;

    gitHubRateLimitService.updateFromGraphQL(response);

    const repo = response?.repository as Record<string, unknown> | undefined;
    for (const num of chunk) {
      const alias = `i${num}`;
      const node = repo?.[alias] as Record<string, unknown> | null;
      results.push(node ? parseIssueNode(node) : null);
    }
  }

  return results;
}

export async function getIssuesByNumbers(
  cwd: string,
  numbers: number[]
): Promise<Array<GitHubIssue | null>> {
  const client = GitHubAuth.createClient();
  if (!client) {
    throw new Error("GitHub token not configured. Set it in Settings.");
  }

  const valid = numbers.filter((n) => typeof n === "number" && Number.isInteger(n) && n > 0);
  if (valid.length === 0) return [];

  try {
    return await withRepoContextRetry(cwd, (context) =>
      getIssuesByNumbersForContext(context, numbers)
    );
  } catch (error) {
    const message = formatErrorMessage(error, "Failed to fetch GitHub issues");
    if (message === "Not a GitHub repository") {
      throw error;
    }
    if (message.includes("Could not resolve to") || message.includes("Could not resolve")) {
      return [];
    }
    throw new Error(parseGitHubError(error));
  }
}
