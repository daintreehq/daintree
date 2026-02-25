import type {
  RepositoryStats,
  GitHubCliStatus,
  GitHubTokenConfig,
  GitHubTokenValidation,
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

  assignIssue: (cwd: string, issueNumber: number, username: string): Promise<void> => {
    return window.electron.github.assignIssue(cwd, issueNumber, username);
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
} as const;
