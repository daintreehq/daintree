import { shell } from "electron";
import fs from "fs/promises";
import path from "path";
import { CHANNELS } from "../channels.js";
import { broadcastToRenderer, checkRateLimit, typedHandle } from "../utils.js";
import type { HandlerDependencies } from "../types.js";
import type {
  RepositoryStats,
  ProjectHealthData,
  GitHubCliStatus,
  GitHubTokenConfig,
  GitHubTokenValidation,
  RepoStatsAndPagePayload,
  GitHubFirstPageCachePayload,
  GitHubRateLimitDetails,
} from "../../types/index.js";
import {
  gitHubRateLimitService,
  gitHubTokenHealthService,
  fetchRateLimitDetails,
  setTokenAndSync,
  clearTokenAndSync,
} from "../../services/github/index.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";

export function registerGithubHandlers(_deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  // Main-process transport: push rate-limit state changes to every renderer.
  const unsubscribeRateLimit = gitHubRateLimitService.onStateChange((state) => {
    broadcastToRenderer(CHANNELS.GITHUB_RATE_LIMIT_CHANGED, state);
  });
  handlers.push(unsubscribeRateLimit);

  // Main-process transport: push token-health state changes to every renderer.
  const unsubscribeTokenHealth = gitHubTokenHealthService.onStateChange((state) => {
    broadcastToRenderer(CHANNELS.GITHUB_TOKEN_HEALTH_CHANGED, state);
  });
  handlers.push(unsubscribeTokenHealth);

  // Replay current token-health state on mount so a second window can surface
  // the banner without waiting for the next probe.
  const handleGetTokenHealth = async () => gitHubTokenHealthService.getState();
  handlers.push(typedHandle(CHANNELS.GITHUB_GET_TOKEN_HEALTH, handleGetTokenHealth));

  const handleGetRateLimitDetails = async (): Promise<GitHubRateLimitDetails | null> => {
    checkRateLimit(CHANNELS.GITHUB_GET_RATE_LIMIT_DETAILS, 30, 60_000);
    return fetchRateLimitDetails();
  };
  handlers.push(typedHandle(CHANNELS.GITHUB_GET_RATE_LIMIT_DETAILS, handleGetRateLimitDetails));

  const handleGitHubGetRepoStats = async (
    cwd: string,
    bypassCache = false
  ): Promise<RepositoryStats> => {
    checkRateLimit(CHANNELS.GITHUB_GET_REPO_STATS, 10, 10_000);
    if (typeof cwd !== "string" || !cwd) {
      throw new Error("Invalid working directory");
    }
    if (!path.isAbsolute(cwd)) {
      throw new Error("Working directory must be an absolute path");
    }

    const { getRepoStatsComplete } = await import("../../services/github/index.js");
    const result = await getRepoStatsComplete(cwd, bypassCache);

    if (result.issues && result.prs && result.source === "network" && !result.stale) {
      const resolved = path.resolve(cwd);
      const payload: RepoStatsAndPagePayload = {
        projectPath: resolved,
        stats: result.stats,
        issues: result.issues,
        prs: result.prs,
        fetchedAt: Date.now(),
      };
      broadcastToRenderer(CHANNELS.GITHUB_REPO_STATS_AND_PAGE_UPDATED, payload);
    }

    return result.stats;
  };
  handlers.push(typedHandle(CHANNELS.GITHUB_GET_REPO_STATS, handleGitHubGetRepoStats));

  const handleGitHubGetFirstPageCache = async (
    cwd: string
  ): Promise<GitHubFirstPageCachePayload | null> => {
    checkRateLimit(CHANNELS.GITHUB_GET_FIRST_PAGE_CACHE, 10, 10_000);
    if (typeof cwd !== "string" || !cwd) return null;
    if (!path.isAbsolute(cwd)) return null;

    const { getFirstPageCache } = await import("../../services/github/index.js");
    return getFirstPageCache(cwd);
  };
  handlers.push(typedHandle(CHANNELS.GITHUB_GET_FIRST_PAGE_CACHE, handleGitHubGetFirstPageCache));

  const handleGitHubGetProjectHealth = async (
    cwd: string,
    bypassCache = false
  ): Promise<ProjectHealthData> => {
    checkRateLimit(CHANNELS.GITHUB_GET_PROJECT_HEALTH, 10, 10_000);
    if (typeof cwd !== "string" || !cwd) {
      throw new Error("Invalid working directory");
    }
    if (!path.isAbsolute(cwd)) {
      throw new Error("Working directory must be an absolute path");
    }

    const { getProjectHealth, buildEmptyProjectHealthData } =
      await import("../../services/github/index.js");

    try {
      const resolved = path.resolve(cwd);
      const stat = await fs.stat(resolved);
      if (!stat.isDirectory()) {
        return buildEmptyProjectHealthData({ error: "Path is not a directory" });
      }

      const result = await getProjectHealth(resolved, bypassCache);

      if (result.health) {
        return { ...result.health, hasRemote: true, loading: false, error: result.error };
      }

      return buildEmptyProjectHealthData({
        error: result.error,
        hasRemote: result.error !== "Not a GitHub repository",
      });
    } catch (err) {
      const message = formatErrorMessage(err, "Failed to fetch GitHub project health");
      return buildEmptyProjectHealthData({ error: message });
    }
  };
  handlers.push(typedHandle(CHANNELS.GITHUB_GET_PROJECT_HEALTH, handleGitHubGetProjectHealth));

  const handleGitHubOpenIssues = async (cwd: string, query?: string, state?: string) => {
    checkRateLimit(CHANNELS.GITHUB_OPEN_ISSUES, 20, 10_000);
    if (typeof cwd !== "string" || !cwd) {
      throw new Error("Invalid working directory");
    }
    if (!path.isAbsolute(cwd)) {
      throw new Error("Working directory must be an absolute path");
    }
    const { getRepoUrl, buildGitHubSearchQuery } = await import("../../services/github/index.js");
    const repoUrl = await getRepoUrl(cwd);
    if (!repoUrl) {
      throw new Error("Not a GitHub repository");
    }
    const q = buildGitHubSearchQuery(query, state, "issue");
    const url = q ? `${repoUrl}/issues?q=${encodeURIComponent(q)}` : `${repoUrl}/issues`;
    await shell.openExternal(url);
  };
  handlers.push(typedHandle(CHANNELS.GITHUB_OPEN_ISSUES, handleGitHubOpenIssues));

  const handleGitHubOpenPRs = async (cwd: string, query?: string, state?: string) => {
    checkRateLimit(CHANNELS.GITHUB_OPEN_PRS, 20, 10_000);
    if (typeof cwd !== "string" || !cwd) {
      throw new Error("Invalid working directory");
    }
    if (!path.isAbsolute(cwd)) {
      throw new Error("Working directory must be an absolute path");
    }
    const { getRepoUrl, buildGitHubSearchQuery } = await import("../../services/github/index.js");
    const repoUrl = await getRepoUrl(cwd);
    if (!repoUrl) {
      throw new Error("Not a GitHub repository");
    }
    const q = buildGitHubSearchQuery(query, state, "pr");
    const url = q ? `${repoUrl}/pulls?q=${encodeURIComponent(q)}` : `${repoUrl}/pulls`;
    await shell.openExternal(url);
  };
  handlers.push(typedHandle(CHANNELS.GITHUB_OPEN_PRS, handleGitHubOpenPRs));

  const handleGitHubOpenCommits = async (cwd: string, branch?: string) => {
    checkRateLimit(CHANNELS.GITHUB_OPEN_COMMITS, 20, 10_000);
    if (typeof cwd !== "string" || !cwd) {
      throw new Error("Invalid working directory");
    }
    if (!path.isAbsolute(cwd)) {
      throw new Error("Working directory must be an absolute path");
    }
    if (branch !== undefined && (typeof branch !== "string" || !branch.trim())) {
      throw new Error("Invalid branch name");
    }
    const { getRepoUrl } = await import("../../services/github/index.js");
    const repoUrl = await getRepoUrl(cwd);
    if (!repoUrl) {
      throw new Error("Not a GitHub repository");
    }
    const url = branch ? `${repoUrl}/commits/${encodeURIComponent(branch)}` : `${repoUrl}/commits`;
    await shell.openExternal(url);
  };
  handlers.push(typedHandle(CHANNELS.GITHUB_OPEN_COMMITS, handleGitHubOpenCommits));

  const handleGitHubOpenIssue = async (payload: { cwd: string; issueNumber: number }) => {
    checkRateLimit(CHANNELS.GITHUB_OPEN_ISSUE, 20, 10_000);
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }
    if (typeof payload.cwd !== "string" || !payload.cwd) {
      throw new Error("Invalid working directory");
    }
    if (!path.isAbsolute(payload.cwd)) {
      throw new Error("Working directory must be an absolute path");
    }
    if (
      typeof payload.issueNumber !== "number" ||
      !Number.isInteger(payload.issueNumber) ||
      payload.issueNumber <= 0
    ) {
      throw new Error("Invalid issue number");
    }
    const { getIssueUrl } = await import("../../services/github/index.js");
    const issueUrl = await getIssueUrl(payload.cwd, payload.issueNumber);
    if (!issueUrl) {
      throw new Error("Not a GitHub repository");
    }
    await shell.openExternal(issueUrl);
  };
  handlers.push(typedHandle(CHANNELS.GITHUB_OPEN_ISSUE, handleGitHubOpenIssue));

  const handleGitHubOpenPR = async (prUrl: string) => {
    checkRateLimit(CHANNELS.GITHUB_OPEN_PR, 20, 10_000);
    if (typeof prUrl !== "string" || !prUrl) {
      throw new Error("Invalid PR URL");
    }
    try {
      const url = new URL(prUrl);
      if (url.protocol !== "https:") {
        throw new Error(`Only https:// GitHub PR URLs are allowed, got ${url.protocol}`);
      }
      const hostname = url.hostname.toLowerCase();
      if (hostname !== "github.com" && !hostname.endsWith(".github.com")) {
        throw new Error(`Only GitHub PR URLs are allowed, got ${url.hostname}`);
      }
    } catch (error) {
      throw new Error(formatErrorMessage(error, "Invalid PR URL"));
    }
    await shell.openExternal(prUrl);
  };
  handlers.push(typedHandle(CHANNELS.GITHUB_OPEN_PR, handleGitHubOpenPR));

  const handleGitHubCheckCli = async (): Promise<GitHubCliStatus> => {
    checkRateLimit(CHANNELS.GITHUB_CHECK_CLI, 10, 10_000);
    const { hasGitHubToken } = await import("../../services/github/index.js");
    if (hasGitHubToken()) {
      return { available: true };
    }
    return { available: false, error: "GitHub token not configured. Set it in Settings." };
  };
  handlers.push(typedHandle(CHANNELS.GITHUB_CHECK_CLI, handleGitHubCheckCli));

  const handleGitHubGetConfig = async (): Promise<GitHubTokenConfig> => {
    checkRateLimit(CHANNELS.GITHUB_GET_CONFIG, 10, 10_000);
    const { getGitHubConfigAsync } = await import("../../services/github/index.js");
    return getGitHubConfigAsync();
  };
  handlers.push(typedHandle(CHANNELS.GITHUB_GET_CONFIG, handleGitHubGetConfig));

  const handleGitHubSetToken = async (token: string): Promise<GitHubTokenValidation> => {
    checkRateLimit(CHANNELS.GITHUB_SET_TOKEN, 5, 10_000);
    if (typeof token !== "string" || !token.trim()) {
      return { valid: false, scopes: [], error: "Token is required" };
    }
    return setTokenAndSync(token);
  };
  handlers.push(typedHandle(CHANNELS.GITHUB_SET_TOKEN, handleGitHubSetToken));

  const handleGitHubClearToken = async (): Promise<void> => {
    checkRateLimit(CHANNELS.GITHUB_CLEAR_TOKEN, 5, 10_000);
    await clearTokenAndSync();
  };
  handlers.push(typedHandle(CHANNELS.GITHUB_CLEAR_TOKEN, handleGitHubClearToken));

  const handleGitHubValidateToken = async (token: string): Promise<GitHubTokenValidation> => {
    checkRateLimit(CHANNELS.GITHUB_VALIDATE_TOKEN, 5, 10_000);
    if (typeof token !== "string" || !token.trim()) {
      return { valid: false, scopes: [], error: "Token is required" };
    }
    const { validateGitHubToken } = await import("../../services/github/index.js");
    return validateGitHubToken(token.trim());
  };
  handlers.push(typedHandle(CHANNELS.GITHUB_VALIDATE_TOKEN, handleGitHubValidateToken));

  const handleGitHubListIssues = async (options: {
    cwd: string;
    search?: string;
    state?: "open" | "closed" | "all";
    cursor?: string;
    bypassCache?: boolean;
    sortOrder?: "created" | "updated";
  }) => {
    checkRateLimit(CHANNELS.GITHUB_LIST_ISSUES, 10, 10_000);
    if (!options || typeof options.cwd !== "string" || !options.cwd) {
      throw new Error("Invalid options: cwd is required");
    }
    if (!path.isAbsolute(options.cwd)) {
      throw new Error("Working directory must be an absolute path");
    }
    const { listIssues } = await import("../../services/github/index.js");
    return listIssues(options);
  };
  handlers.push(typedHandle(CHANNELS.GITHUB_LIST_ISSUES, handleGitHubListIssues));

  const handleGitHubListPRs = async (options: {
    cwd: string;
    search?: string;
    state?: "open" | "closed" | "merged" | "all";
    cursor?: string;
    bypassCache?: boolean;
    sortOrder?: "created" | "updated";
  }) => {
    checkRateLimit(CHANNELS.GITHUB_LIST_PRS, 10, 10_000);
    if (!options || typeof options.cwd !== "string" || !options.cwd) {
      throw new Error("Invalid options: cwd is required");
    }
    if (!path.isAbsolute(options.cwd)) {
      throw new Error("Working directory must be an absolute path");
    }
    const { listPullRequests } = await import("../../services/github/index.js");
    return listPullRequests(options);
  };
  handlers.push(typedHandle(CHANNELS.GITHUB_LIST_PRS, handleGitHubListPRs));

  const handleGitHubAssignIssue = async (payload: {
    cwd: string;
    issueNumber: number;
    username: string;
  }): Promise<void> => {
    checkRateLimit(CHANNELS.GITHUB_ASSIGN_ISSUE, 5, 10_000);
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }
    if (typeof payload.cwd !== "string" || !payload.cwd.trim()) {
      throw new Error("Invalid working directory");
    }
    if (!path.isAbsolute(payload.cwd)) {
      throw new Error("Working directory must be an absolute path");
    }
    if (
      typeof payload.issueNumber !== "number" ||
      !Number.isInteger(payload.issueNumber) ||
      payload.issueNumber <= 0
    ) {
      throw new Error("Invalid issue number");
    }
    const trimmedUsername = payload.username?.trim();
    if (typeof payload.username !== "string" || !trimmedUsername) {
      throw new Error("Invalid username");
    }
    const { assignIssue } = await import("../../services/github/index.js");
    await assignIssue(payload.cwd.trim(), payload.issueNumber, trimmedUsername);
  };
  handlers.push(typedHandle(CHANNELS.GITHUB_ASSIGN_ISSUE, handleGitHubAssignIssue));

  const handleGitHubGetIssueTooltip = async (payload: { cwd: string; issueNumber: number }) => {
    checkRateLimit(CHANNELS.GITHUB_GET_ISSUE_TOOLTIP, 20, 10_000);
    if (!payload || typeof payload !== "object") return null;
    if (typeof payload.cwd !== "string" || !payload.cwd.trim()) return null;
    if (!path.isAbsolute(payload.cwd)) return null;
    if (
      typeof payload.issueNumber !== "number" ||
      !Number.isInteger(payload.issueNumber) ||
      payload.issueNumber <= 0
    )
      return null;
    const { getIssueTooltip } = await import("../../services/github/index.js");
    return getIssueTooltip(payload.cwd.trim(), payload.issueNumber);
  };
  handlers.push(typedHandle(CHANNELS.GITHUB_GET_ISSUE_TOOLTIP, handleGitHubGetIssueTooltip));

  const handleGitHubGetPRTooltip = async (payload: { cwd: string; prNumber: number }) => {
    checkRateLimit(CHANNELS.GITHUB_GET_PR_TOOLTIP, 20, 10_000);
    if (!payload || typeof payload !== "object") return null;
    if (typeof payload.cwd !== "string" || !payload.cwd.trim()) return null;
    if (!path.isAbsolute(payload.cwd)) return null;
    if (
      typeof payload.prNumber !== "number" ||
      !Number.isInteger(payload.prNumber) ||
      payload.prNumber <= 0
    )
      return null;
    const { getPRTooltip } = await import("../../services/github/index.js");
    return getPRTooltip(payload.cwd.trim(), payload.prNumber);
  };
  handlers.push(typedHandle(CHANNELS.GITHUB_GET_PR_TOOLTIP, handleGitHubGetPRTooltip));

  const handleGitHubGetIssueUrl = async (payload: {
    cwd: string;
    issueNumber: number;
  }): Promise<string | null> => {
    checkRateLimit(CHANNELS.GITHUB_GET_ISSUE_URL, 10, 10_000);
    if (!payload || typeof payload !== "object") return null;
    if (typeof payload.cwd !== "string" || !payload.cwd.trim()) return null;
    if (!path.isAbsolute(payload.cwd)) return null;
    if (
      typeof payload.issueNumber !== "number" ||
      !Number.isInteger(payload.issueNumber) ||
      payload.issueNumber <= 0
    )
      return null;
    const { getIssueUrl } = await import("../../services/github/index.js");
    return getIssueUrl(payload.cwd.trim(), payload.issueNumber);
  };
  handlers.push(typedHandle(CHANNELS.GITHUB_GET_ISSUE_URL, handleGitHubGetIssueUrl));

  const handleGitHubGetIssueByNumber = async (payload: { cwd: string; issueNumber: number }) => {
    checkRateLimit(CHANNELS.GITHUB_GET_ISSUE_BY_NUMBER, 25, 10_000);
    if (!payload || typeof payload !== "object") return null;
    if (typeof payload.cwd !== "string" || !payload.cwd.trim()) return null;
    if (!path.isAbsolute(payload.cwd)) return null;
    if (
      typeof payload.issueNumber !== "number" ||
      !Number.isInteger(payload.issueNumber) ||
      payload.issueNumber <= 0
    )
      return null;
    const { getIssueByNumber } = await import("../../services/github/index.js");
    return getIssueByNumber(payload.cwd.trim(), payload.issueNumber);
  };
  handlers.push(typedHandle(CHANNELS.GITHUB_GET_ISSUE_BY_NUMBER, handleGitHubGetIssueByNumber));

  const handleGitHubGetPRByNumber = async (payload: { cwd: string; prNumber: number }) => {
    checkRateLimit(CHANNELS.GITHUB_GET_PR_BY_NUMBER, 25, 10_000);
    if (!payload || typeof payload !== "object") return null;
    if (typeof payload.cwd !== "string" || !payload.cwd.trim()) return null;
    if (!path.isAbsolute(payload.cwd)) return null;
    if (
      typeof payload.prNumber !== "number" ||
      !Number.isInteger(payload.prNumber) ||
      payload.prNumber <= 0
    )
      return null;
    const { getPRByNumber } = await import("../../services/github/index.js");
    return getPRByNumber(payload.cwd.trim(), payload.prNumber);
  };
  handlers.push(typedHandle(CHANNELS.GITHUB_GET_PR_BY_NUMBER, handleGitHubGetPRByNumber));

  const handleGitHubGetPRReviewThreads = async (payload: { cwd: string; prNumber: number }) => {
    checkRateLimit(CHANNELS.GITHUB_GET_PR_REVIEW_THREADS, 10, 10_000);
    if (!payload || typeof payload !== "object") {
      return {};
    }
    if (typeof payload.cwd !== "string" || !payload.cwd.trim()) {
      return {};
    }
    if (!path.isAbsolute(payload.cwd)) {
      return {};
    }
    if (
      typeof payload.prNumber !== "number" ||
      !Number.isInteger(payload.prNumber) ||
      payload.prNumber <= 0
    ) {
      return {};
    }

    const { getPRReviewThreads } = await import("../../services/GitHubService.js");
    return getPRReviewThreads(payload.cwd.trim(), payload.prNumber);
  };
  handlers.push(typedHandle(CHANNELS.GITHUB_GET_PR_REVIEW_THREADS, handleGitHubGetPRReviewThreads));

  // Lists all git remotes (origin, upstream, …) with an optional parsed
  // owner/repo for remotes whose URL looks like a forge repo. The data is
  // provider-agnostic; the `github:list-remotes` channel name is legacy.
  // New callers should use `project:list-remotes` (#8456); the GitHub
  // channel stays registered for backward compat.
  const listRemotesForChannel = async (
    rateLimitKey: string,
    cwd: string
  ): Promise<
    Array<{ name: string; fetchUrl: string; parsedRepo: { owner: string; repo: string } | null }>
  > => {
    checkRateLimit(rateLimitKey, 10, 10_000);
    if (typeof cwd !== "string" || !cwd) {
      throw new Error("Invalid working directory");
    }
    if (!path.isAbsolute(cwd)) {
      throw new Error("Working directory must be an absolute path");
    }
    const { listGitHubRemotes } = await import("../../services/github/index.js");
    return listGitHubRemotes(cwd);
  };
  handlers.push(
    typedHandle(CHANNELS.GITHUB_LIST_REMOTES, (cwd: string) =>
      listRemotesForChannel(CHANNELS.GITHUB_LIST_REMOTES, cwd)
    )
  );
  handlers.push(
    typedHandle(CHANNELS.PROJECT_LIST_REMOTES, (cwd: string) =>
      listRemotesForChannel(CHANNELS.PROJECT_LIST_REMOTES, cwd)
    )
  );

  return () => handlers.forEach((cleanup) => cleanup());
}
