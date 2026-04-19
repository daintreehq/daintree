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
} from "../../types/index.js";
import { gitHubRateLimitService, gitHubTokenHealthService } from "../../services/github/index.js";
import { getWorkspaceClient } from "../../services/WorkspaceClient.js";

export function buildGitHubSearchQuery(
  searchText: string | undefined,
  state: string | undefined,
  resourceType: "issue" | "pr"
): string {
  const parts: string[] = [];

  const defaultState = "open";
  const effectiveState = state || defaultState;

  if (effectiveState !== "open") {
    if (resourceType === "pr" && effectiveState === "merged") {
      parts.push("is:merged");
    } else if (effectiveState === "closed") {
      parts.push("is:closed");
    } else if (effectiveState === "all") {
      // No state qualifier for "all"
    }
  }

  if (searchText?.trim()) {
    parts.push(searchText.trim());
  }

  // If state is "open" and no search text, return empty to preserve bare URL
  if (effectiveState === "open" && !searchText?.trim()) {
    return "";
  }

  // If we have search text but state is open, add is:open so GitHub doesn't default differently
  if (effectiveState === "open" && searchText?.trim()) {
    parts.unshift("is:open");
  }

  return parts.join(" ");
}

export function registerGithubHandlers(_deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  // Main-process transport: every time the main-process rate-limit singleton
  // changes state (either from a local fetch observation or a forwarded
  // utility-process observation via WorkspaceClient.routeHostEvent), push
  // the new state to every renderer window.
  const unsubscribeRateLimit = gitHubRateLimitService.onStateChange((state) => {
    broadcastToRenderer(CHANNELS.GITHUB_RATE_LIMIT_CHANGED, state);
  });
  handlers.push(unsubscribeRateLimit);

  // Main-process transport: push token-health state changes to every
  // renderer so a "Reconnect to GitHub" banner can surface when the
  // background probe detects a dead token.
  const unsubscribeTokenHealth = gitHubTokenHealthService.onStateChange((state) => {
    broadcastToRenderer(CHANNELS.GITHUB_TOKEN_HEALTH_CHANGED, state);
  });
  handlers.push(unsubscribeTokenHealth);

  // Invoke handler: renderer subscribers call this on mount to replay the
  // current state — guarantees a second window, or a window that mounts
  // after the initial probe completed, can surface the banner without
  // waiting for the next state transition (which might never come while
  // the token stays unhealthy).
  const handleGetTokenHealth = async () => gitHubTokenHealthService.getState();
  handlers.push(typedHandle(CHANNELS.GITHUB_GET_TOKEN_HEALTH, handleGetTokenHealth));

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

    const { getRepoStats } = await import("../../services/GitHubService.js");
    const { getCommitCount } = await import("../../utils/git.js");

    try {
      const resolved = path.resolve(cwd);
      const stat = await fs.stat(resolved);
      if (!stat.isDirectory()) {
        return {
          commitCount: 0,
          issueCount: null,
          prCount: null,
          loading: false,
          ghError: "Path is not a directory",
        };
      }

      const statsResult = await getRepoStats(resolved, bypassCache);

      const commitCount = await getCommitCount(resolved).catch(() => 0);

      const rateLimitState = gitHubRateLimitService.getState();

      return {
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        commitCount: 0,
        issueCount: null,
        prCount: null,
        loading: false,
        ghError: message,
      };
    }
  };
  handlers.push(typedHandle(CHANNELS.GITHUB_GET_REPO_STATS, handleGitHubGetRepoStats));

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

    const { getProjectHealth } = await import("../../services/GitHubService.js");

    try {
      const resolved = path.resolve(cwd);
      const stat = await fs.stat(resolved);
      if (!stat.isDirectory()) {
        return {
          ciStatus: "none",
          issueCount: 0,
          prCount: 0,
          latestRelease: null,
          securityAlerts: { visible: false, count: 0 },
          mergeVelocity: { mergedCounts: { 60: 0, 120: 0, 180: 0 } },
          repoUrl: "",
          hasRemote: false,
          loading: false,
          error: "Path is not a directory",
        };
      }

      const result = await getProjectHealth(resolved, bypassCache);

      if (result.health) {
        return {
          ...result.health,
          hasRemote: true,
          loading: false,
          error: result.error,
        };
      }

      return {
        ciStatus: "none",
        issueCount: 0,
        prCount: 0,
        latestRelease: null,
        securityAlerts: { visible: false, count: 0 },
        mergeVelocity: { mergedCounts: { 60: 0, 120: 0, 180: 0 } },
        repoUrl: "",
        hasRemote: result.error !== "Not a GitHub repository",
        loading: false,
        error: result.error,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ciStatus: "none",
        issueCount: 0,
        prCount: 0,
        latestRelease: null,
        securityAlerts: { visible: false, count: 0 },
        mergeVelocity: { mergedCounts: { 60: 0, 120: 0, 180: 0 } },
        repoUrl: "",
        hasRemote: false,
        loading: false,
        error: message,
      };
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
    const { getRepoUrl } = await import("../../services/GitHubService.js");
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
    const { getRepoUrl } = await import("../../services/GitHubService.js");
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
    const { getRepoUrl } = await import("../../services/GitHubService.js");
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
    if (typeof payload.issueNumber !== "number" || payload.issueNumber <= 0) {
      throw new Error("Invalid issue number");
    }
    const { getIssueUrl } = await import("../../services/GitHubService.js");
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
      if (!["https:", "http:"].includes(url.protocol)) {
        throw new Error(`Only https:// or http:// PR URLs are allowed, got ${url.protocol}`);
      }
    } catch (error) {
      throw new Error(`Invalid PR URL: ${error instanceof Error ? error.message : String(error)}`);
    }
    await shell.openExternal(prUrl);
  };
  handlers.push(typedHandle(CHANNELS.GITHUB_OPEN_PR, handleGitHubOpenPR));

  const handleGitHubCheckCli = async (): Promise<GitHubCliStatus> => {
    checkRateLimit(CHANNELS.GITHUB_CHECK_CLI, 10, 10_000);
    const { hasGitHubToken } = await import("../../services/GitHubService.js");
    if (hasGitHubToken()) {
      return { available: true };
    }
    return { available: false, error: "GitHub token not configured. Set it in Settings." };
  };
  handlers.push(typedHandle(CHANNELS.GITHUB_CHECK_CLI, handleGitHubCheckCli));

  const handleGitHubGetConfig = async (): Promise<GitHubTokenConfig> => {
    checkRateLimit(CHANNELS.GITHUB_GET_CONFIG, 10, 10_000);
    const { getGitHubConfigAsync } = await import("../../services/GitHubService.js");
    return getGitHubConfigAsync();
  };
  handlers.push(typedHandle(CHANNELS.GITHUB_GET_CONFIG, handleGitHubGetConfig));

  const handleGitHubSetToken = async (token: string): Promise<GitHubTokenValidation> => {
    checkRateLimit(CHANNELS.GITHUB_SET_TOKEN, 5, 10_000);
    if (typeof token !== "string" || !token.trim()) {
      return { valid: false, scopes: [], error: "Token is required" };
    }

    const { validateGitHubToken, setGitHubToken } = await import("../../services/GitHubService.js");
    const { GitHubAuth } = await import("../../services/github/index.js");

    const validation = await validateGitHubToken(token.trim());

    if (validation.valid) {
      setGitHubToken(token.trim());
      const versionAfterSet = GitHubAuth.getTokenVersion();

      if (validation.username) {
        GitHubAuth.setValidatedUserInfo(
          validation.username,
          validation.avatarUrl,
          validation.scopes,
          versionAfterSet
        );
      }

      try {
        const workspaceClient = getWorkspaceClient();
        workspaceClient.updateGitHubToken(token.trim());
      } catch {
        // WorkspaceClient may not be initialized yet
      }

      // Reset any lingering health state so a previously-surfaced
      // "Reconnect" banner is cleared before the next probe runs.
      gitHubTokenHealthService.resetState();
      void gitHubTokenHealthService.refresh({ force: true });
    }

    return validation;
  };
  handlers.push(typedHandle(CHANNELS.GITHUB_SET_TOKEN, handleGitHubSetToken));

  const handleGitHubClearToken = async (): Promise<void> => {
    checkRateLimit(CHANNELS.GITHUB_CLEAR_TOKEN, 5, 10_000);
    const { clearGitHubToken } = await import("../../services/GitHubService.js");
    clearGitHubToken();

    try {
      const workspaceClient = getWorkspaceClient();
      workspaceClient.updateGitHubToken(null);
    } catch {
      // WorkspaceClient may not be initialized yet
    }

    // Token removed: drop any lingering health state and banner.
    gitHubTokenHealthService.resetState();
  };
  handlers.push(typedHandle(CHANNELS.GITHUB_CLEAR_TOKEN, handleGitHubClearToken));

  const handleGitHubValidateToken = async (token: string): Promise<GitHubTokenValidation> => {
    checkRateLimit(CHANNELS.GITHUB_VALIDATE_TOKEN, 5, 10_000);
    if (typeof token !== "string" || !token.trim()) {
      return { valid: false, scopes: [], error: "Token is required" };
    }

    const { validateGitHubToken } = await import("../../services/GitHubService.js");
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

    const { listIssues } = await import("../../services/GitHubService.js");
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

    const { listPullRequests } = await import("../../services/GitHubService.js");
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

    const { assignIssue } = await import("../../services/GitHubService.js");
    await assignIssue(payload.cwd.trim(), payload.issueNumber, trimmedUsername);
  };
  handlers.push(typedHandle(CHANNELS.GITHUB_ASSIGN_ISSUE, handleGitHubAssignIssue));

  const handleGitHubGetIssueTooltip = async (payload: { cwd: string; issueNumber: number }) => {
    checkRateLimit(CHANNELS.GITHUB_GET_ISSUE_TOOLTIP, 20, 10_000);
    if (!payload || typeof payload !== "object") {
      return null;
    }
    if (typeof payload.cwd !== "string" || !payload.cwd.trim()) {
      return null;
    }
    if (!path.isAbsolute(payload.cwd)) {
      return null;
    }
    if (
      typeof payload.issueNumber !== "number" ||
      !Number.isInteger(payload.issueNumber) ||
      payload.issueNumber <= 0
    ) {
      return null;
    }

    const { getIssueTooltip } = await import("../../services/GitHubService.js");
    return getIssueTooltip(payload.cwd.trim(), payload.issueNumber);
  };
  handlers.push(typedHandle(CHANNELS.GITHUB_GET_ISSUE_TOOLTIP, handleGitHubGetIssueTooltip));

  const handleGitHubGetPRTooltip = async (payload: { cwd: string; prNumber: number }) => {
    checkRateLimit(CHANNELS.GITHUB_GET_PR_TOOLTIP, 20, 10_000);
    if (!payload || typeof payload !== "object") {
      return null;
    }
    if (typeof payload.cwd !== "string" || !payload.cwd.trim()) {
      return null;
    }
    if (!path.isAbsolute(payload.cwd)) {
      return null;
    }
    if (
      typeof payload.prNumber !== "number" ||
      !Number.isInteger(payload.prNumber) ||
      payload.prNumber <= 0
    ) {
      return null;
    }

    const { getPRTooltip } = await import("../../services/GitHubService.js");
    return getPRTooltip(payload.cwd.trim(), payload.prNumber);
  };
  handlers.push(typedHandle(CHANNELS.GITHUB_GET_PR_TOOLTIP, handleGitHubGetPRTooltip));

  const handleGitHubGetIssueUrl = async (payload: {
    cwd: string;
    issueNumber: number;
  }): Promise<string | null> => {
    checkRateLimit(CHANNELS.GITHUB_GET_ISSUE_URL, 10, 10_000);
    if (!payload || typeof payload !== "object") {
      return null;
    }
    if (typeof payload.cwd !== "string" || !payload.cwd.trim()) {
      return null;
    }
    if (!path.isAbsolute(payload.cwd)) {
      return null;
    }
    if (
      typeof payload.issueNumber !== "number" ||
      !Number.isInteger(payload.issueNumber) ||
      payload.issueNumber <= 0
    ) {
      return null;
    }

    const { getIssueUrl } = await import("../../services/GitHubService.js");
    return getIssueUrl(payload.cwd.trim(), payload.issueNumber);
  };
  handlers.push(typedHandle(CHANNELS.GITHUB_GET_ISSUE_URL, handleGitHubGetIssueUrl));

  const handleGitHubGetIssueByNumber = async (payload: { cwd: string; issueNumber: number }) => {
    checkRateLimit(CHANNELS.GITHUB_GET_ISSUE_BY_NUMBER, 25, 10_000);
    if (!payload || typeof payload !== "object") {
      return null;
    }
    if (typeof payload.cwd !== "string" || !payload.cwd.trim()) {
      return null;
    }
    if (!path.isAbsolute(payload.cwd)) {
      return null;
    }
    if (
      typeof payload.issueNumber !== "number" ||
      !Number.isInteger(payload.issueNumber) ||
      payload.issueNumber <= 0
    ) {
      return null;
    }

    const { getIssueByNumber } = await import("../../services/GitHubService.js");
    return getIssueByNumber(payload.cwd.trim(), payload.issueNumber);
  };
  handlers.push(typedHandle(CHANNELS.GITHUB_GET_ISSUE_BY_NUMBER, handleGitHubGetIssueByNumber));

  const handleGitHubGetPRByNumber = async (payload: { cwd: string; prNumber: number }) => {
    checkRateLimit(CHANNELS.GITHUB_GET_PR_BY_NUMBER, 25, 10_000);
    if (!payload || typeof payload !== "object") {
      return null;
    }
    if (typeof payload.cwd !== "string" || !payload.cwd.trim()) {
      return null;
    }
    if (!path.isAbsolute(payload.cwd)) {
      return null;
    }
    if (
      typeof payload.prNumber !== "number" ||
      !Number.isInteger(payload.prNumber) ||
      payload.prNumber <= 0
    ) {
      return null;
    }

    const { getPRByNumber } = await import("../../services/GitHubService.js");
    return getPRByNumber(payload.cwd.trim(), payload.prNumber);
  };
  handlers.push(typedHandle(CHANNELS.GITHUB_GET_PR_BY_NUMBER, handleGitHubGetPRByNumber));

  const handleGitHubListRemotes = async (
    cwd: string
  ): Promise<
    Array<{ name: string; fetchUrl: string; parsedRepo: { owner: string; repo: string } | null }>
  > => {
    checkRateLimit(CHANNELS.GITHUB_LIST_REMOTES, 10, 10_000);
    if (typeof cwd !== "string" || !cwd) {
      throw new Error("Invalid working directory");
    }
    if (!path.isAbsolute(cwd)) {
      throw new Error("Working directory must be an absolute path");
    }

    const { GitService } = await import("../../services/GitService.js");
    const { parseGitHubRepoUrl } = await import("../../services/GitHubService.js");
    const gitService = new GitService(cwd);
    const remotes = await gitService.listRemotes(cwd);

    const result = remotes.map((r) => ({
      name: r.name,
      fetchUrl: r.fetchUrl,
      parsedRepo: parseGitHubRepoUrl(r.fetchUrl),
    }));

    result.sort((a, b) => {
      if (a.name === "origin") return -1;
      if (b.name === "origin") return 1;
      return a.name.localeCompare(b.name);
    });

    return result;
  };
  handlers.push(typedHandle(CHANNELS.GITHUB_LIST_REMOTES, handleGitHubListRemotes));

  return () => handlers.forEach((cleanup) => cleanup());
}
