import type { GraphQlQueryResponseData } from "@octokit/graphql";
import { GitHubAuth, GITHUB_API_TIMEOUT_MS } from "./GitHubAuth.js";
import { LIST_ISSUES_QUERY, SEARCH_QUERY, GET_ISSUE_QUERY } from "./GitHubQueries.js";
import { parseGitHubError } from "./GitHubErrors.js";
import { withRepoContextRetry } from "./GitHubRepoContext.js";
import { repoStatsCache, issueListCache, issueTooltipCache } from "./GitHubCaches.js";
import { GitHubStatsCache } from "../GitHubStatsCache.js";
import { buildListCacheKey, updateRepoStatsCount } from "./GitHubPRs.js";
import { truncateBody } from "./GitHubCaches.js";
import type {
  GitHubIssue,
  GitHubUser,
  GitHubListOptions,
  GitHubListResponse,
  IssueTooltipData,
  LinkedPRInfo,
} from "../../../shared/types/github.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";

export function extractLinkedPR(
  timelineItems:
    | {
        nodes?: Array<{
          source?: { number?: number; state?: string; merged?: boolean; url?: string };
          subject?: { number?: number; state?: string; merged?: boolean; url?: string };
        }>;
      }
    | undefined
): LinkedPRInfo | undefined {
  if (!timelineItems?.nodes) return undefined;

  const prs: Array<{ number: number; state: "OPEN" | "CLOSED" | "MERGED"; url: string }> = [];
  const seenPRNumbers = new Set<number>();

  for (const node of timelineItems.nodes) {
    const prData = node?.source ?? node?.subject;
    if (prData?.number && prData?.url && !seenPRNumbers.has(prData.number)) {
      seenPRNumbers.add(prData.number);
      const state: "OPEN" | "CLOSED" | "MERGED" = prData.merged
        ? "MERGED"
        : (prData.state?.toUpperCase() as "OPEN" | "CLOSED") || "OPEN";
      prs.push({ number: prData.number, state, url: prData.url });
    }
  }

  if (prs.length === 0) return undefined;

  const openPRs = prs.filter((pr) => pr.state === "OPEN");
  const mergedPRs = prs.filter((pr) => pr.state === "MERGED");
  const closedPRs = prs.filter((pr) => pr.state === "CLOSED");

  if (openPRs.length > 0) return openPRs[openPRs.length - 1];
  if (mergedPRs.length > 0) return mergedPRs[mergedPRs.length - 1];
  if (closedPRs.length > 0) return closedPRs[closedPRs.length - 1];

  return undefined;
}

export function parseIssueNode(node: Record<string, unknown>): GitHubIssue {
  const author = node.author as { login?: string; avatarUrl?: string } | null;
  const assigneesData = node.assignees as { nodes?: Array<{ login?: string; avatarUrl?: string }> };
  const commentsData = node.comments as { totalCount?: number };
  const labelsData = node.labels as { nodes?: Array<{ name?: string; color?: string }> };
  const timelineItems = node.timelineItems as
    | {
        nodes?: Array<{
          source?: { number?: number; state?: string; merged?: boolean; url?: string };
        }>;
      }
    | undefined;

  const linkedPR = extractLinkedPR(timelineItems);

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
      const response = await fetch(url, {
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
          throw new Error(`Cannot assign user "${username}" - they may not be a collaborator`);
        }
        throw new Error(`GitHub API error: ${response.statusText}`);
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
}

export async function getIssueTooltip(
  cwd: string,
  issueNumber: number
): Promise<IssueTooltipData | null> {
  const client = GitHubAuth.createClient();
  if (!client) {
    return null;
  }

  try {
    return await withRepoContextRetry(cwd, async (context) => {
      const cacheKey = `${context.owner}/${context.repo}:${issueNumber}`;
      const cached = issueTooltipCache.get(cacheKey);
      if (cached) {
        return cached;
      }

      const response = (await client(GET_ISSUE_QUERY, {
        owner: context.owner,
        repo: context.repo,
        number: issueNumber,
        request: { signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS) },
      })) as GraphQlQueryResponseData;

      const issue = response?.repository?.issue;
      if (!issue) {
        return null;
      }

      const author = issue.author as { login?: string; avatarUrl?: string } | null;
      const assigneesData = issue.assignees as {
        nodes?: Array<{ login?: string; avatarUrl?: string }>;
      };
      const labelsData = issue.labels as { nodes?: Array<{ name?: string; color?: string }> };

      const tooltipData: IssueTooltipData = {
        number: issue.number as number,
        title: issue.title as string,
        bodyExcerpt: truncateBody(issue.bodyText as string | null),
        state: issue.state as "OPEN" | "CLOSED",
        createdAt: issue.createdAt as string,
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

      issueTooltipCache.set(cacheKey, tooltipData);
      return tooltipData;
    });
  } catch {
    return null;
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
    const cacheKey = buildListCacheKey(
      "issue",
      context.owner,
      context.repo,
      options.state ?? "open",
      options.search ?? "",
      resolvedSortOrder,
      options.cursor ?? ""
    );

    if (!options.search && !options.bypassCache) {
      const cached = issueListCache.get(cacheKey);
      if (cached) return cached;
    }

    try {
      let result: GitHubListResponse<GitHubIssue>;

      if (options.search) {
        const stateFilter =
          options.state === "closed" ? "is:closed" : options.state === "all" ? "" : "is:open";
        const sortQualifier =
          resolvedSortOrder === "updated" ? "sort:updated-desc" : "sort:created-desc";
        const searchQuery =
          `repo:${context.owner}/${context.repo} is:issue ${stateFilter} ${sortQualifier} ${options.search}`.trim();

        const response = (await client(SEARCH_QUERY, {
          searchQuery,
          type: "ISSUE",
          cursor: options.cursor,
          limit: 20,
          request: { signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS) },
        })) as GraphQlQueryResponseData;

        const search = response?.search;
        const nodes = (search?.nodes ?? []) as Array<Record<string, unknown>>;

        result = {
          items: nodes.filter(Boolean).map(parseIssueNode),
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

        const issues = response?.repository?.issues;
        const nodes = (issues?.nodes ?? []) as Array<Record<string, unknown>>;
        const totalCount = (issues?.totalCount as number) ?? undefined;

        result = {
          items: nodes.filter(Boolean).map(parseIssueNode),
          pageInfo: {
            hasNextPage: issues?.pageInfo?.hasNextPage ?? false,
            endCursor: issues?.pageInfo?.endCursor ?? null,
          },
        };

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
