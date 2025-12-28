import type { GraphQlQueryResponseData } from "@octokit/graphql";
import { GitService } from "./GitService.js";
import { Cache } from "../utils/cache.js";
import { GitHubStatsCache } from "./GitHubStatsCache.js";
import type {
  GitHubIssue,
  GitHubPR,
  GitHubListOptions,
  GitHubListResponse,
} from "../../shared/types/github.js";

import {
  GitHubAuth,
  REPO_STATS_QUERY,
  LIST_ISSUES_QUERY,
  LIST_PRS_QUERY,
  SEARCH_QUERY,
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

export async function validateGitHubToken(token: string) {
  return GitHubAuth.validate(token);
}

export async function getRepoContext(cwd: string): Promise<RepoContext | null> {
  const cached = repoContextCache.get(cwd);
  if (cached) return cached;

  try {
    const gitService = new GitService(cwd);
    const fetchUrl = await gitService.getRemoteUrl(cwd);

    if (!fetchUrl) return null;

    const match = fetchUrl.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/);

    if (!match) return null;

    const context = { owner: match[1], repo: match[2] };
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
    let issueTitle: string | undefined;

    const issueResponse = (
      data?.[`${alias}_issue`] as { issue?: { title?: string; timelineItems?: { nodes?: unknown[] } } }
    )?.issue;
    issueTitle = issueResponse?.title;
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

export async function assignIssue(
  cwd: string,
  issueNumber: number,
  username: string
): Promise<void> {
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
  } catch (error) {
    throw new Error(parseGitHubError(error));
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

function parseIssueNode(node: Record<string, unknown>): GitHubIssue {
  const author = node.author as { login?: string; avatarUrl?: string } | null;
  const assigneesData = node.assignees as { nodes?: Array<{ login?: string; avatarUrl?: string }> };
  const commentsData = node.comments as { totalCount?: number };
  const labelsData = node.labels as { nodes?: Array<{ name?: string; color?: string }> };

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
        query: searchQuery,
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
        query: searchQuery,
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
