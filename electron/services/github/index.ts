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
