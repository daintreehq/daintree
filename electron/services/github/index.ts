export { GitHubAuth, GITHUB_API_TIMEOUT_MS, GITHUB_AUTH_TIMEOUT_MS } from "./GitHubAuth.js";
export type { GitHubTokenConfig, GitHubTokenValidation } from "./GitHubAuth.js";

export { gitHubRateLimitService, GitHubRateLimitError } from "./GitHubRateLimitService.js";
export type { ShouldBlockResult } from "./GitHubRateLimitService.js";

export {
  gitHubTokenHealthService,
  GitHubTokenHealthServiceImpl,
  HEALTH_CHECK_INTERVAL_MS,
  HEALTH_CHECK_FOCUS_COOLDOWN_MS,
  HEALTH_CHECK_FETCH_TIMEOUT_MS,
} from "./GitHubTokenHealthService.js";

export {
  REPO_STATS_QUERY,
  REPO_STATS_AND_PAGE_QUERY,
  PROJECT_HEALTH_QUERY,
  LIST_ISSUES_QUERY,
  LIST_PRS_QUERY,
  SEARCH_QUERY,
  GET_ISSUE_QUERY,
  GET_PR_QUERY,
  buildBatchPRQuery,
  buildBatchRequiredChecksQuery,
} from "./GitHubQueries.js";

export { deriveRequiredCIStatus } from "./prRequiredCIStatus.js";
export type { RollupContextNode, DerivedCIResult } from "./prRequiredCIStatus.js";

export type {
  RepoContext,
  RepoStats,
  RepoStatsResult,
  LinkedPR,
  PRCheckResult,
  PRCheckCandidate,
  BatchPRCheckResult,
  CIStatus,
  ProjectHealth,
  ProjectHealthResult,
} from "./types.js";

// Token helpers
export {
  getGitHubToken,
  hasGitHubToken,
  setGitHubToken,
  clearGitHubToken,
  getGitHubConfig,
  getGitHubConfigAsync,
  validateGitHubToken,
} from "./GitHubToken.js";

// Repo context
export {
  parseGitHubRepoUrl,
  getRepoContext,
  getRepoInfo,
  getRepoUrl,
  getIssueUrl,
  withRepoContextRetry,
} from "./GitHubRepoContext.js";

// Cache management
export { clearGitHubCaches, clearPRCaches } from "./GitHubCaches.js";

// Stats
export { getRepoStats, getRepoStatsAndPage } from "./GitHubStats.js";
export type { RepoStatsAndPageResult } from "./GitHubStats.js";

// Project health
export { getProjectHealth } from "./GitHubHealth.js";

// PR discovery
export { batchCheckLinkedPRs } from "./GitHubPRDiscovery.js";

// Error handling
export { parseGitHubError } from "./GitHubErrors.js";

// PRs
export { listPullRequests, getPRByNumber, getPRTooltip } from "./GitHubPRs.js";

// Issues
export { listIssues, getIssueByNumber, getIssueTooltip, assignIssue } from "./GitHubIssues.js";
export type { AssignIssueResult } from "./GitHubIssues.js";
