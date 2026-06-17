import type {
  AuthValidation,
  ForgeUser,
  PushErrorClassification,
  Issue,
  PR,
  Page,
  RepoMetadata,
  ListOptions,
  IssueTooltipData,
  PRTooltipData,
  ReviewThread,
  ForgeTokenHealthState,
  RateLimitDetails,
} from "@shared/types/forge";
import type {
  ForgeRepositoryStats,
  ForgeRepoStatsAndPagePayload,
  ForgeRepoCountsUpdatedPayload,
  ForgeFirstPageCachePayload,
  ForgeProjectHealthPayload,
  ForgeRateLimitChangedPayload,
  ForgeTokenHealthChangedPayload,
  PRDetectedPayload,
  PRClearedPayload,
  IssueDetectedPayload,
  IssueNotFoundPayload,
} from "@shared/types/ipc/forge";

export const forgeClient = {
  openIssues: (cwd: string, query?: string, state?: string): Promise<void> => {
    return window.electron.forge.openIssues(cwd, query, state);
  },

  openPRs: (cwd: string, query?: string, state?: string): Promise<void> => {
    return window.electron.forge.openPRs(cwd, query, state);
  },

  openCommits: (cwd: string, branch?: string): Promise<void> => {
    return window.electron.forge.openCommits(cwd, branch);
  },

  openIssue: (cwd: string, issueNumber: number): Promise<void> => {
    return window.electron.forge.openIssue({ cwd, issueNumber });
  },

  getIssueUrl: (cwd: string, issueNumber: number): Promise<string> => {
    return window.electron.forge.getIssueUrl({ cwd, issueNumber });
  },

  assignIssue: (cwd: string, issueNumber: number, username: string): Promise<void> => {
    return window.electron.forge.assignIssue({ cwd, issueNumber, username });
  },

  unassignIssue: (cwd: string, issueNumber: number, username: string): Promise<void> => {
    return window.electron.forge.unassignIssue({ cwd, issueNumber, username });
  },

  approvePR: (cwd: string, prNumber: number, body?: string): Promise<void> => {
    return window.electron.forge.approvePR({ cwd, prNumber, body });
  },

  requestChanges: (cwd: string, prNumber: number, body: string): Promise<void> => {
    return window.electron.forge.requestChanges({ cwd, prNumber, body });
  },

  dismissReview: (
    cwd: string,
    prNumber: number,
    reviewId: number,
    message: string
  ): Promise<void> => {
    return window.electron.forge.dismissReview({ cwd, prNumber, reviewId, message });
  },

  requestReviewers: (
    cwd: string,
    prNumber: number,
    reviewers: { users?: string[]; teams?: string[] }
  ): Promise<void> => {
    return window.electron.forge.requestReviewers({ cwd, prNumber, ...reviewers });
  },

  validateToken: (providerId: string, token: string): Promise<AuthValidation> => {
    return window.electron.forge.validateToken({ providerId, token });
  },

  listIssues: (cwd: string, opts?: ListOptions): Promise<Page<Issue>> => {
    return window.electron.forge.listIssues({ cwd, opts });
  },

  listPRs: (cwd: string, opts?: ListOptions): Promise<Page<PR>> => {
    return window.electron.forge.listPRs({ cwd, opts });
  },

  getIssue: (cwd: string, issueNumber: number): Promise<Issue | null> => {
    return window.electron.forge.getIssue({ cwd, issueNumber });
  },

  getPR: (cwd: string, prNumber: number): Promise<PR | null> => {
    return window.electron.forge.getPR({ cwd, prNumber });
  },

  getRepoMetadata: (cwd: string): Promise<RepoMetadata> => {
    return window.electron.forge.getRepoMetadata({ cwd });
  },

  getCurrentUser: (cwd: string): Promise<ForgeUser | null> => {
    return window.electron.forge.getCurrentUser({ cwd });
  },

  classifyPushError: (
    cwd: string,
    stderr: string
  ): Promise<{ providerId: string; classification: PushErrorClassification | null } | null> => {
    return window.electron.forge.classifyPushError({ cwd, stderr });
  },

  getRepoStats: (cwd: string, bypassCache?: boolean): Promise<ForgeRepositoryStats> => {
    return window.electron.forge.getRepoStats({ cwd, bypassCache });
  },

  getFirstPageCache: (cwd: string): Promise<ForgeFirstPageCachePayload | null> => {
    return window.electron.forge.getFirstPageCache({ cwd });
  },

  getProjectHealth: (cwd: string, bypassCache?: boolean): Promise<ForgeProjectHealthPayload> => {
    return window.electron.forge.getProjectHealth({ cwd, bypassCache });
  },

  getIssueTooltip: (cwd: string, issueNumber: number): Promise<IssueTooltipData | null> => {
    return window.electron.forge.getIssueTooltip({ cwd, issueNumber });
  },

  getPRTooltip: (cwd: string, prNumber: number): Promise<PRTooltipData | null> => {
    return window.electron.forge.getPRTooltip({ cwd, prNumber });
  },

  getIssuesByNumbers: (cwd: string, numbers: number[]): Promise<Issue[]> => {
    return window.electron.forge.getIssuesByNumbers({ cwd, numbers });
  },

  getPRsByNumbers: (cwd: string, numbers: number[]): Promise<PR[]> => {
    return window.electron.forge.getPRsByNumbers({ cwd, numbers });
  },

  getPRReviewThreads: (cwd: string, prNumber: number): Promise<ReviewThread[]> => {
    return window.electron.forge.getPRReviewThreads({ cwd, prNumber });
  },

  resolveAuthorAvatar: (cwd: string, email: string): Promise<string | null> => {
    return window.electron.forge.resolveAuthorAvatar({ cwd, email });
  },

  getTokenHealth: (providerId: string): Promise<ForgeTokenHealthState | null> => {
    return window.electron.forge.getTokenHealth({ providerId });
  },

  getRateLimitDetails: (cwd: string): Promise<RateLimitDetails | null> => {
    return window.electron.forge.getRateLimitDetails({ cwd });
  },

  openPR: (cwd: string, prNumber: number): Promise<void> => {
    return window.electron.forge.openPR({ cwd, prNumber });
  },

  onRepoStatsAndPageUpdated: (
    callback: (data: ForgeRepoStatsAndPagePayload) => void
  ): (() => void) => {
    return window.electron.forge.onRepoStatsAndPageUpdated(callback);
  },

  onRepoCountsUpdated: (callback: (data: ForgeRepoCountsUpdatedPayload) => void): (() => void) => {
    return window.electron.forge.onRepoCountsUpdated(callback);
  },

  onRateLimitChanged: (callback: (data: ForgeRateLimitChangedPayload) => void): (() => void) => {
    return window.electron.forge.onRateLimitChanged(callback);
  },

  onTokenHealthChanged: (
    callback: (data: ForgeTokenHealthChangedPayload) => void
  ): (() => void) => {
    return window.electron.forge.onTokenHealthChanged(callback);
  },

  onPRDetected: (callback: (data: PRDetectedPayload) => void): (() => void) => {
    return window.electron.forge.onPRDetected(callback);
  },

  onPRCleared: (callback: (data: PRClearedPayload) => void): (() => void) => {
    return window.electron.forge.onPRCleared(callback);
  },

  onIssueDetected: (callback: (data: IssueDetectedPayload) => void): (() => void) => {
    return window.electron.forge.onIssueDetected(callback);
  },

  onIssueNotFound: (callback: (data: IssueNotFoundPayload) => void): (() => void) => {
    return window.electron.forge.onIssueNotFound(callback);
  },
} as const;
