import type {
  RepositoryStats,
  ProjectHealthData,
  GitHubCliStatus,
  GitHubTokenConfig,
  GitHubTokenValidation,
  GitHubRateLimitPayload,
  GitHubRateLimitDetails,
  GitHubTokenHealthPayload,
  RepoStatsAndPagePayload,
  GitHubFirstPageCachePayload,
  PRDetectedPayload,
  PRClearedPayload,
  IssueDetectedPayload,
  IssueNotFoundPayload,
} from "../types";
import type {
  GitHubIssue,
  GitHubPR,
  GitHubListOptions,
  GitHubListResponse,
} from "@shared/types/github";
import type { RateLimitInfo } from "@shared/types/forge";
import { BUILTIN_GITHUB_PROVIDER_ID } from "@shared/utils/forgeProviderIds";

/**
 * Project the provider-agnostic {@link RateLimitInfo} the workspace-host
 * observed onto the GitHub-flavored {@link GitHubRateLimitPayload} existing
 * GitHub consumers expect. GitHub is blocked when its budget is spent
 * (`remaining === 0`) or a secondary/abuse throttle is active.
 */
function toGitHubRateLimitPayload(info: RateLimitInfo): GitHubRateLimitPayload {
  const blocked = info.remaining === 0 || info.secondaryThrottled === true;
  if (!blocked) return { blocked: false, kind: null, throttleMultiplier: info.throttleMultiplier };
  return {
    blocked: true,
    kind: info.secondaryThrottled ? "secondary" : "primary",
    ...(info.resetAt != null ? { resetAt: info.resetAt } : {}),
    throttleMultiplier: info.throttleMultiplier,
  };
}

export const githubClient = {
  getRepoStats: (cwd: string, bypassCache = false): Promise<RepositoryStats> => {
    return window.electron.github.getRepoStats(cwd, bypassCache);
  },

  getFirstPageCache: (cwd: string): Promise<GitHubFirstPageCachePayload | null> => {
    return window.electron.github.getFirstPageCache(cwd);
  },

  getProjectHealth: (cwd: string, bypassCache = false): Promise<ProjectHealthData> => {
    return window.electron.github.getProjectHealth(cwd, bypassCache);
  },

  openIssues: (cwd: string, query?: string, state?: string): Promise<void> => {
    return window.electron.github.openIssues(cwd, query, state);
  },

  openPRs: (cwd: string, query?: string, state?: string): Promise<void> => {
    return window.electron.github.openPRs(cwd, query, state);
  },

  openCommits: (cwd: string, branch?: string): Promise<void> => {
    return window.electron.github.openCommits(cwd, branch);
  },

  openIssue: (cwd: string, issueNumber: number): Promise<void> => {
    return window.electron.github.openIssue(cwd, issueNumber);
  },

  openPR: (prUrl: string): Promise<void> => {
    return window.electron.github.openPR(prUrl);
  },

  checkCli: (): Promise<GitHubCliStatus> => {
    return window.electron.github.checkCli();
  },

  getConfig: (): Promise<GitHubTokenConfig> => {
    return window.electron.github.getConfig();
  },

  setToken: (token: string): Promise<GitHubTokenValidation> => {
    return window.electron.github.setToken(token);
  },

  clearToken: (): Promise<void> => {
    return window.electron.github.clearToken();
  },

  validateToken: (token: string): Promise<GitHubTokenValidation> => {
    return window.electron.github.validateToken(token);
  },

  listIssues: (
    options: Omit<GitHubListOptions, "state"> & { state?: "open" | "closed" | "all" }
  ): Promise<GitHubListResponse<GitHubIssue>> => {
    return window.electron.github.listIssues(options);
  },

  listPullRequests: (
    options: Omit<GitHubListOptions, "state"> & { state?: "open" | "closed" | "merged" | "all" }
  ): Promise<GitHubListResponse<GitHubPR>> => {
    return window.electron.github.listPullRequests(options);
  },

  assignIssue: (cwd: string, issueNumber: number, username: string): Promise<void> => {
    return window.electron.github.assignIssue(cwd, issueNumber, username);
  },

  unassignIssue: (cwd: string, issueNumber: number, username: string): Promise<void> => {
    return window.electron.github.unassignIssue(cwd, issueNumber, username);
  },

  onPRDetected: (callback: (data: PRDetectedPayload) => void): (() => void) => {
    return window.electron.github.onPRDetected(callback);
  },

  onPRCleared: (callback: (data: PRClearedPayload) => void): (() => void) => {
    return window.electron.github.onPRCleared(callback);
  },

  onIssueDetected: (callback: (data: IssueDetectedPayload) => void): (() => void) => {
    return window.electron.github.onIssueDetected(callback);
  },

  onIssueNotFound: (callback: (data: IssueNotFoundPayload) => void): (() => void) => {
    return window.electron.github.onIssueNotFound(callback);
  },

  onRateLimitChanged: (callback: (data: GitHubRateLimitPayload) => void): (() => void) => {
    // Rate-limit state now flows over the provider-keyed forge channel for
    // every provider. Filter to GitHub's canonical id and project back to the
    // GitHub-flavored payload so GitHub consumers are unchanged.
    return window.electron.forge.onRateLimitChanged((payload) => {
      if (payload.providerId !== BUILTIN_GITHUB_PROVIDER_ID) return;
      callback(toGitHubRateLimitPayload(payload.state));
    });
  },

  getRateLimitDetails: (): Promise<GitHubRateLimitDetails | null> => {
    return window.electron.github.getRateLimitDetails();
  },

  onTokenHealthChanged: (callback: (data: GitHubTokenHealthPayload) => void): (() => void) => {
    return window.electron.github.onTokenHealthChanged(callback);
  },

  onRepoStatsAndPageUpdated: (callback: (data: RepoStatsAndPagePayload) => void): (() => void) => {
    return window.electron.github.onRepoStatsAndPageUpdated(callback);
  },

  getTokenHealth: (): Promise<GitHubTokenHealthPayload> => {
    return window.electron.github.getTokenHealth();
  },

  getIssueUrl: (cwd: string, issueNumber: number): Promise<string | null> => {
    return window.electron.github.getIssueUrl(cwd, issueNumber);
  },

  getIssueByNumber: (
    cwd: string,
    issueNumber: number
  ): Promise<import("@shared/types/github").GitHubIssue | null> => {
    return window.electron.github.getIssueByNumber(cwd, issueNumber);
  },

  getPRByNumber: (
    cwd: string,
    prNumber: number
  ): Promise<import("@shared/types/github").GitHubPR | null> => {
    return window.electron.github.getPRByNumber(cwd, prNumber);
  },

  getIssuesByNumbers: (
    cwd: string,
    numbers: number[]
  ): Promise<Array<import("@shared/types/github").GitHubIssue | null>> => {
    return window.electron.github.getIssuesByNumbers(cwd, numbers);
  },

  getPRsByNumbers: (
    cwd: string,
    numbers: number[]
  ): Promise<Array<import("@shared/types/github").GitHubPR | null>> => {
    return window.electron.github.getPRsByNumbers(cwd, numbers);
  },

  getPRReviewThreads: (cwd: string, prNumber: number): Promise<Record<string, number>> => {
    return window.electron.github.getPRReviewThreads(cwd, prNumber);
  },
} as const;
