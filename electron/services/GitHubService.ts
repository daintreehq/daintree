import type { GraphQlQueryResponseData } from "@octokit/graphql";
import { GitService } from "./GitService.js";
import { Cache } from "../utils/cache.js";
import { GitHubStatsCache } from "./GitHubStatsCache.js";
import type {
  GitHubIssue,
  GitHubPR,
  GitHubUser,
  GitHubListOptions,
  GitHubListResponse,
  LinkedPRInfo,
  IssueTooltipData,
  PRTooltipData,
} from "../../shared/types/github.js";

import {
  GitHubAuth,
  REPO_STATS_QUERY,
  LIST_ISSUES_QUERY,
  LIST_PRS_QUERY,
  SEARCH_QUERY,
  GET_ISSUE_QUERY,
  GET_PR_QUERY,
  buildBatchPRQuery,
} from "./github/index.js";

import type {
  RepoContext,
  RepoStats,
  RepoStatsResult,
  LinkedPR,
  PRCheckResult,
  PRCheckCandidate,
  BatchPRCheckResult,
} from "./github/index.js";

export type { GitHubTokenConfig, GitHubTokenValidation } from "./github/index.js";
export type {
  RepoContext,
  RepoStats,
  RepoStatsResult,
  LinkedPR,
  PRCheckResult,
  PRCheckCandidate,
  BatchPRCheckResult,
};

// Caches
const repoContextCache = new Cache<string, RepoContext>({ defaultTTL: 300000 });
const repoStatsCache = new Cache<string, RepoStats>({ defaultTTL: 60000 });
const issueListCache = new Cache<string, GitHubListResponse<GitHubIssue>>({ defaultTTL: 60000 });
const prListCache = new Cache<string, GitHubListResponse<GitHubPR>>({ defaultTTL: 60000 });
const issueTooltipCache = new Cache<string, IssueTooltipData>({ defaultTTL: 300000 }); // 5 min TTL
const prTooltipCache = new Cache<string, PRTooltipData>({ defaultTTL: 300000 }); // 5 min TTL

export function getGitHubToken(): string | undefined {
  return GitHubAuth.getToken();
}

export function hasGitHubToken(): boolean {
  return GitHubAuth.hasToken();
}

export function setGitHubToken(token: string): void {
  GitHubAuth.setToken(token);
  clearGitHubCaches();
}

export function clearGitHubToken(): void {
  GitHubAuth.clearToken();
  clearGitHubCaches();
}

export function getGitHubConfig() {
  return GitHubAuth.getConfig();
}

export async function getGitHubConfigAsync() {
  return GitHubAuth.getConfigAsync();
}

export async function validateGitHubToken(token: string) {
  return GitHubAuth.validate(token);
}

/**
 * Parse owner and repo from a GitHub URL (HTTPS or SSH format).
 *
 * Handles:
 * - HTTPS URLs: https://github.com/owner/repo, https://github.com/owner/repo.git
 * - SSH URLs: git@github.com:owner/repo, git@github.com:owner/repo.git
 * - Trailing slashes: https://github.com/owner/repo/
 * - Dotted repo names: https://github.com/owner/my.repo
 */
export function parseGitHubRepoUrl(url: string): { owner: string; repo: string } | null {
  // Normalize SSH format to HTTPS-like format for easier parsing
  const normalized = url.replace(/^git@github\.com:/, "https://github.com/");

  try {
    const parsed = new URL(normalized);

    // Must be github.com
    if (parsed.hostname !== "github.com") {
      return null;
    }

    // Remove leading slash, trailing slash, and .git suffix
    const pathname = parsed.pathname
      .replace(/^\//, "")
      .replace(/\/$/, "")
      .replace(/\.git$/, "");

    const parts = pathname.split("/");

    // Need at least owner and repo
    if (parts.length < 2 || !parts[0] || !parts[1]) {
      return null;
    }

    return { owner: parts[0], repo: parts[1] };
  } catch {
    return null;
  }
}

export async function getRepoContext(cwd: string): Promise<RepoContext | null> {
  const cached = repoContextCache.get(cwd);
  if (cached) return cached;

  try {
    const gitService = new GitService(cwd);
    const fetchUrl = await gitService.getRemoteUrl(cwd);

    if (!fetchUrl) return null;

    const parsed = parseGitHubRepoUrl(fetchUrl);
    if (!parsed) return null;

    const context = { owner: parsed.owner, repo: parsed.repo };
    repoContextCache.set(cwd, context);
    return context;
  } catch {
    return null;
  }
}

export async function getRepoStats(cwd: string, bypassCache = false): Promise<RepoStatsResult> {
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
        error: "GitHub token not configured",
      };
    }
    return { stats: null, error: "GitHub token not configured" };
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

export async function getRepoInfo(cwd: string): Promise<RepoContext | null> {
  return getRepoContext(cwd);
}

function parseBatchPRResponse(
  data: Record<string, unknown>,
  candidates: PRCheckCandidate[]
): Map<string, PRCheckResult> {
  const results = new Map<string, PRCheckResult>();

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const alias = `wt_${i}`;
    let foundPR: LinkedPR | null = null;
    const issueResponse = (
      data?.[`${alias}_issue`] as {
        issue?: { title?: string; timelineItems?: { nodes?: unknown[] } };
      }
    )?.issue;
    const issueTitle = issueResponse?.title;
    const issueData = issueResponse?.timelineItems?.nodes;
    if (issueData && Array.isArray(issueData)) {
      const prs: LinkedPR[] = [];
      for (const node of issueData as Array<{
        source?: {
          number?: number;
          title?: string;
          url?: string;
          state?: string;
          isDraft?: boolean;
          merged?: boolean;
        };
      }>) {
        const source = node?.source;
        if (source?.number && source?.url) {
          prs.push({
            number: source.number,
            title: source.title || "",
            url: source.url,
            state: source.merged
              ? "merged"
              : (source.state?.toLowerCase() as "open" | "closed") || "open",
            isDraft: source.isDraft ?? false,
          });
        }
      }

      const openPRs = prs.filter((pr) => pr.state === "open");
      const mergedPRs = prs.filter((pr) => pr.state === "merged");
      const closedPRs = prs.filter((pr) => pr.state === "closed");

      if (openPRs.length > 0) {
        foundPR = openPRs[openPRs.length - 1];
      } else if (mergedPRs.length > 0) {
        foundPR = mergedPRs[mergedPRs.length - 1];
      } else if (closedPRs.length > 0) {
        foundPR = closedPRs[closedPRs.length - 1];
      }
    }

    if (!foundPR) {
      const branchData = (data?.[`${alias}_branch`] as { pullRequests?: { nodes?: unknown[] } })
        ?.pullRequests?.nodes;
      if (branchData && Array.isArray(branchData) && branchData.length > 0) {
        const pr = branchData[0] as {
          number?: number;
          title?: string;
          url?: string;
          state?: string;
          isDraft?: boolean;
          merged?: boolean;
        };
        if (pr?.number && pr?.url) {
          foundPR = {
            number: pr.number,
            title: pr.title || "",
            url: pr.url,
            state: pr.merged ? "merged" : (pr.state?.toLowerCase() as "open" | "closed") || "open",
            isDraft: pr.isDraft ?? false,
          };
        }
      }
    }

    results.set(candidate.worktreeId, {
      issueNumber: candidate.issueNumber,
      issueTitle,
      branchName: candidate.branchName,
      pr: foundPR,
    });
  }

  return results;
}

export async function batchCheckLinkedPRs(
  cwd: string,
  candidates: PRCheckCandidate[]
): Promise<BatchPRCheckResult> {
  if (candidates.length === 0) {
    return { results: new Map() };
  }

  const client = GitHubAuth.createClient();
  if (!client) {
    return { results: new Map(), error: "GitHub token not configured" };
  }

  const context = await getRepoContext(cwd);
  if (!context) {
    return { results: new Map(), error: "Not a GitHub repository" };
  }

  try {
    const query = buildBatchPRQuery(context.owner, context.repo, candidates);
    const response = (await client(query)) as Record<string, unknown>;

    const results = parseBatchPRResponse(response, candidates);
    return { results };
  } catch (error) {
    return { results: new Map(), error: parseGitHubError(error) };
  }
}

export async function getRepoUrl(cwd: string): Promise<string | null> {
  const context = await getRepoContext(cwd);
  if (!context) return null;
  return `https://github.com/${context.owner}/${context.repo}`;
}

export async function getIssueUrl(cwd: string, issueNumber: number): Promise<string | null> {
  const repoUrl = await getRepoUrl(cwd);
  if (!repoUrl) return null;
  return `${repoUrl}/issues/${issueNumber}`;
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
  const token = getGitHubToken();
  if (!token) {
    throw new Error("GitHub token not configured");
  }

  const context = await getRepoContext(cwd);
  if (!context) {
    throw new Error("Not a GitHub repository");
  }

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

    // Parse the response to get the updated assignee info
    const data = (await response.json()) as {
      assignees?: Array<{ login?: string; avatar_url?: string }>;
    };

    // Validate response structure
    if (!Array.isArray(data.assignees)) {
      throw new Error("Invalid GitHub API response: assignees field missing or malformed");
    }

    // Find the assignee we just added
    const assignee = data.assignees.find((a) => a.login?.toLowerCase() === username.toLowerCase());
    if (!assignee?.login) {
      throw new Error(`Assignment succeeded but user "${username}" not found in response`);
    }

    const assigneeData = {
      login: assignee.login,
      avatarUrl: assignee.avatar_url ?? "",
    };

    // Optimistically update the issue cache
    updateIssueAssigneeInCache(context.owner, context.repo, issueNumber, assigneeData);

    return { username: assigneeData.login, avatarUrl: assigneeData.avatarUrl };
  } catch (error) {
    throw new Error(parseGitHubError(error));
  }
}

function updateIssueAssigneeInCache(
  owner: string,
  repo: string,
  issueNumber: number,
  assignee: { login: string; avatarUrl: string }
): void {
  // The cache key format is: type:owner/repo:state:search:cursor
  // We need to iterate through all cache entries and update any that contain this issue
  const cachePrefix = `issue:${owner}/${repo}:`;

  // Collect all updates first to avoid modifying cache during iteration
  const updates: Array<{ key: string; value: GitHubListResponse<GitHubIssue> }> = [];

  issueListCache.forEach((value, key) => {
    if (!key.startsWith(cachePrefix)) return;

    const issueIndex = value.items.findIndex((issue) => issue.number === issueNumber);
    if (issueIndex === -1) return;

    // Check if assignee already exists
    const existingAssignees = value.items[issueIndex].assignees;
    const existingIndex = existingAssignees.findIndex(
      (a) => a.login.toLowerCase() === assignee.login.toLowerCase()
    );

    let updatedAssignees: GitHubUser[];
    if (existingIndex !== -1) {
      // Update existing assignee if avatarUrl changed
      if (existingAssignees[existingIndex].avatarUrl !== assignee.avatarUrl) {
        updatedAssignees = [...existingAssignees];
        updatedAssignees[existingIndex] = assignee;
      } else {
        return;
      }
    } else {
      // Add new assignee
      updatedAssignees = [...existingAssignees, assignee];
    }

    // Create updated items array
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

  // Apply all updates after iteration completes
  for (const update of updates) {
    issueListCache.set(update.key, update.value);
  }
}

function parseGitHubError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("rate limit") || message.includes("API rate limit")) {
    return "GitHub rate limit exceeded. Try again in a few minutes.";
  }

  if (message.includes("401") || message.includes("Bad credentials")) {
    return "Invalid GitHub token. Please update in Settings.";
  }

  if (message.includes("403")) {
    return "Token lacks required permissions. Required scopes: repo, read:org";
  }

  if (message.includes("404") || message.includes("Could not resolve")) {
    return "Repository not found or token lacks access.";
  }

  if (
    message.includes("ENOTFOUND") ||
    message.includes("ETIMEDOUT") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ECONNRESET") ||
    message.includes("EAI_AGAIN") ||
    message.includes("network") ||
    message.includes("fetch failed")
  ) {
    return "Cannot reach GitHub. Check your internet connection.";
  }

  if (message.includes("SAML") || message.includes("SSO")) {
    return "SSO authorization required. Re-authorize at github.com.";
  }

  return `GitHub API error: ${message}`;
}

export function clearGitHubCaches(): void {
  repoContextCache.clear();
  repoStatsCache.clear();
  issueListCache.clear();
  prListCache.clear();
  issueTooltipCache.clear();
  prTooltipCache.clear();
}

function buildListCacheKey(
  type: "issue" | "pr",
  owner: string,
  repo: string,
  state: string,
  search: string,
  cursor: string
): string {
  return `${type}:${owner}/${repo}:${state}:${search}:${cursor}`;
}

function mapIssueStates(state?: string): string[] {
  if (!state || state === "open") return ["OPEN"];
  if (state === "closed") return ["CLOSED"];
  if (state === "all") return ["OPEN", "CLOSED"];
  return ["OPEN"];
}

function mapPRStates(state?: string): string[] {
  if (!state || state === "open") return ["OPEN"];
  if (state === "closed") return ["CLOSED"];
  if (state === "merged") return ["MERGED"];
  if (state === "all") return ["OPEN", "CLOSED", "MERGED"];
  return ["OPEN"];
}

function extractLinkedPR(
  timelineItems:
    | {
        nodes?: Array<{
          source?: { number?: number; state?: string; merged?: boolean; url?: string };
        }>;
      }
    | undefined
): LinkedPRInfo | undefined {
  if (!timelineItems?.nodes) return undefined;

  const prs: Array<{ number: number; state: "OPEN" | "CLOSED" | "MERGED"; url: string }> = [];

  for (const node of timelineItems.nodes) {
    const source = node?.source;
    if (source?.number && source?.url) {
      const state: "OPEN" | "CLOSED" | "MERGED" = source.merged
        ? "MERGED"
        : (source.state?.toUpperCase() as "OPEN" | "CLOSED") || "OPEN";
      prs.push({ number: source.number, state, url: source.url });
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

function parseIssueNode(node: Record<string, unknown>): GitHubIssue {
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
    assignees: (assigneesData?.nodes ?? []).map((a) => ({
      login: a.login ?? "unknown",
      avatarUrl: a.avatarUrl ?? "",
    })),
    commentCount: commentsData?.totalCount ?? 0,
    labels: (labelsData?.nodes ?? []).map((l) => ({
      name: l.name ?? "",
      color: l.color ?? "",
    })),
    linkedPR,
  };
}

function parsePRNode(node: Record<string, unknown>): GitHubPR {
  const author = node.author as { login?: string; avatarUrl?: string } | null;
  const reviewsData = node.reviews as { totalCount?: number };
  const merged = node.merged as boolean;
  const rawState = node.state as string;

  let state: "OPEN" | "CLOSED" | "MERGED" = rawState as "OPEN" | "CLOSED" | "MERGED";
  if (merged) {
    state = "MERGED";
  }

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
  };
}

export async function listIssues(
  options: GitHubListOptions
): Promise<GitHubListResponse<GitHubIssue>> {
  const client = GitHubAuth.createClient();
  if (!client) {
    throw new Error("GitHub token not configured");
  }

  const context = await getRepoContext(options.cwd);
  if (!context) {
    throw new Error("Not a GitHub repository");
  }

  const cacheKey = buildListCacheKey(
    "issue",
    context.owner,
    context.repo,
    options.state ?? "open",
    options.search ?? "",
    options.cursor ?? ""
  );

  if (!options.search) {
    const cached = issueListCache.get(cacheKey);
    if (cached) return cached;
  }

  try {
    let result: GitHubListResponse<GitHubIssue>;

    if (options.search) {
      const stateFilter =
        options.state === "closed" ? "is:closed" : options.state === "all" ? "" : "is:open";
      const searchQuery =
        `repo:${context.owner}/${context.repo} is:issue ${stateFilter} sort:updated-desc ${options.search}`.trim();

      const response = (await client(SEARCH_QUERY, {
        searchQuery,
        type: "ISSUE",
        cursor: options.cursor,
        limit: 20,
      })) as GraphQlQueryResponseData;

      const search = response?.search;
      const nodes = (search?.nodes ?? []) as Array<Record<string, unknown>>;

      result = {
        items: nodes.map(parseIssueNode),
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
      })) as GraphQlQueryResponseData;

      const issues = response?.repository?.issues;
      const nodes = (issues?.nodes ?? []) as Array<Record<string, unknown>>;

      result = {
        items: nodes.map(parseIssueNode),
        pageInfo: {
          hasNextPage: issues?.pageInfo?.hasNextPage ?? false,
          endCursor: issues?.pageInfo?.endCursor ?? null,
        },
      };

      issueListCache.set(cacheKey, result);
    }

    return result;
  } catch (error) {
    throw new Error(parseGitHubError(error));
  }
}

export async function listPullRequests(
  options: GitHubListOptions
): Promise<GitHubListResponse<GitHubPR>> {
  const client = GitHubAuth.createClient();
  if (!client) {
    throw new Error("GitHub token not configured");
  }

  const context = await getRepoContext(options.cwd);
  if (!context) {
    throw new Error("Not a GitHub repository");
  }

  const cacheKey = buildListCacheKey(
    "pr",
    context.owner,
    context.repo,
    options.state ?? "open",
    options.search ?? "",
    options.cursor ?? ""
  );

  if (!options.search) {
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

      const searchQuery =
        `repo:${context.owner}/${context.repo} is:pr ${stateFilter} sort:updated-desc ${options.search}`.trim();

      const response = (await client(SEARCH_QUERY, {
        searchQuery,
        type: "ISSUE",
        cursor: options.cursor,
        limit: 20,
      })) as GraphQlQueryResponseData;

      const search = response?.search;
      const nodes = (search?.nodes ?? []) as Array<Record<string, unknown>>;

      result = {
        items: nodes.map(parsePRNode),
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
      })) as GraphQlQueryResponseData;

      const pullRequests = response?.repository?.pullRequests;
      const nodes = (pullRequests?.nodes ?? []) as Array<Record<string, unknown>>;

      result = {
        items: nodes.map(parsePRNode),
        pageInfo: {
          hasNextPage: pullRequests?.pageInfo?.hasNextPage ?? false,
          endCursor: pullRequests?.pageInfo?.endCursor ?? null,
        },
      };

      prListCache.set(cacheKey, result);
    }

    return result;
  } catch (error) {
    throw new Error(parseGitHubError(error));
  }
}

function truncateBody(body: string | null | undefined, maxLength = 150): string {
  if (!body) return "";
  const cleaned = body.replace(/\r?\n/g, " ").trim();
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.slice(0, maxLength).trim() + "…";
}

export async function getIssueTooltip(
  cwd: string,
  issueNumber: number
): Promise<IssueTooltipData | null> {
  const client = GitHubAuth.createClient();
  if (!client) {
    return null;
  }

  const context = await getRepoContext(cwd);
  if (!context) {
    return null;
  }

  const cacheKey = `${context.owner}/${context.repo}:${issueNumber}`;
  const cached = issueTooltipCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const response = (await client(GET_ISSUE_QUERY, {
      owner: context.owner,
      repo: context.repo,
      number: issueNumber,
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
  } catch {
    return null;
  }
}

export async function getPRTooltip(cwd: string, prNumber: number): Promise<PRTooltipData | null> {
  const client = GitHubAuth.createClient();
  if (!client) {
    return null;
  }

  const context = await getRepoContext(cwd);
  if (!context) {
    return null;
  }

  const cacheKey = `${context.owner}/${context.repo}:${prNumber}`;
  const cached = prTooltipCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const response = (await client(GET_PR_QUERY, {
      owner: context.owner,
      repo: context.repo,
      number: prNumber,
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

    prTooltipCache.set(cacheKey, tooltipData);
    return tooltipData;
  } catch {
    return null;
  }
}
