import type { PluginHostApi } from "../../../../shared/types/plugin.js";
import { githubForgeProvider } from "./forgeProvider.js";
import { registerReviewDecorationProvider } from "./reviewDecorationProvider.js";

/**
 * Plugin activation entry point — called by `PluginService` after manifest
 * validation. Registers the `github` forge provider plus the
 * `worktree-diff-review` file-decoration provider, both declared in
 * `plugin.json`. The descriptor ids MUST match the manifest contributions or
 * the host throws. Returns a disposer that tears down both.
 */
export function activate(host: PluginHostApi): () => void {
  const disposeForge = host.registerForgeProvider({ id: "github" }, githubForgeProvider);
  const disposeDecorations = registerReviewDecorationProvider(host);
  return () => {
    disposeForge();
    disposeDecorations();
  };
}

export { githubForgeProvider } from "./forgeProvider.js";

export {
  createReviewDecorationProvider,
  registerReviewDecorationProvider,
} from "./reviewDecorationProvider.js";

export {
  GitHubAuth,
  GITHUB_API_TIMEOUT_MS,
  GITHUB_AUTH_TIMEOUT_MS,
  captureAuthMetadata,
} from "./GitHubAuth.js";
export type { GitHubTokenConfig, GitHubTokenValidation } from "./GitHubAuth.js";

export {
  gitHubRateLimitService,
  GitHubRateLimitError,
  PRIMARY_RESET_BUFFER_MS,
} from "./GitHubRateLimitService.js";
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
  MERGE_VELOCITY_QUERY,
  LIST_ISSUES_QUERY,
  LIST_PRS_QUERY,
  SEARCH_QUERY,
  GET_ISSUE_QUERY,
  GET_PR_QUERY,
  GET_PR_REVIEW_THREADS_QUERY,
  buildBatchPRQuery,
  buildBatchRequiredChecksQuery,
  buildBatchIssuesQuery,
  buildBatchPRsQuery,
  GRAPHQL_BATCH_CHUNK_SIZE,
  buildGitHubSearchQuery,
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

// Token orchestration
export { setTokenAndSync, clearTokenAndSync } from "./GitHubTokenOrchestrator.js";

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
export {
  getRepoStats,
  getRepoStatsAndPage,
  getFirstPageCache,
  getRepoStatsComplete,
} from "./GitHubStats.js";
export type { RepoStatsAndPageResult, RepoStatsCompleteResult } from "./GitHubStats.js";

// Project health
export { getProjectHealth, buildEmptyProjectHealthData } from "./GitHubHealth.js";

// PR discovery
export { batchCheckLinkedPRs } from "./GitHubPRDiscovery.js";

// Error handling
export { parseGitHubError } from "./GitHubErrors.js";

// PRs
export {
  listPullRequests,
  getPRByNumber,
  getPRsByNumbers,
  getPRTooltip,
  getPRReviewThreads,
} from "./GitHubPRs.js";

// Issues
export {
  listIssues,
  getIssueByNumber,
  getIssuesByNumbers,
  getIssueTooltip,
  assignIssue,
  unassignIssue,
} from "./GitHubIssues.js";
export type { AssignIssueResult } from "./GitHubIssues.js";

// Rate limit API
export { fetchRateLimitDetails } from "./GitHubRateLimitApi.js";

// Remotes
export { listGitHubRemotes } from "./GitHubRemotes.js";

// Profile pictures (forge-agnostic avatar resolution)
export { resolveAuthorAvatar, gitHubProfilePictureProvider } from "./GitHubProfilePicture.js";
