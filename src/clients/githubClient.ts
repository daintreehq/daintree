import type {
  RepositoryStats,
  GitHubCliStatus,
  GitHubTokenConfig,
  GitHubTokenValidation,
  PRDetectedPayload,
  PRClearedPayload,
} from "../types";
import type {
  GitHubIssue,
  GitHubPR,
  GitHubListOptions,
  GitHubListResponse,
} from "@shared/types/github";

export const githubClient = {
  getRepoStats: (cwd: string, bypassCache = false): Promise<RepositoryStats> => {
    return window.electron.github.getRepoStats(cwd, bypassCache);
  },

  openIssues: (cwd: string): Promise<void> => {
    return window.electron.github.openIssues(cwd);
  },

  openPRs: (cwd: string): Promise<void> => {
    return window.electron.github.openPRs(cwd);
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

  onPRDetected: (callback: (data: PRDetectedPayload) => void): (() => void) => {
    return window.electron.github.onPRDetected(callback);
  },

  onPRCleared: (callback: (data: PRClearedPayload) => void): (() => void) => {
    return window.electron.github.onPRCleared(callback);
  },
} as const;
