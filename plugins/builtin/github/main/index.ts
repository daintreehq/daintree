import type { PluginHostApi } from "../../../../shared/types/plugin.js";
import { githubForgeProvider } from "./forgeProvider.js";
import { registerReviewDecorationProvider } from "./reviewDecorationProvider.js";
import { startCacheSweep, stopCacheSweep, clearGitHubCaches } from "./GitHubCaches.js";
import { gitHubTokenHealthService } from "./GitHubTokenHealthService.js";

/**
 * Plugin activation entry point — called by `PluginService` after manifest
 * validation. Registers the `github` forge provider plus the
 * `worktree-diff-review` file-decoration provider, both declared in
 * `plugin.json`. The descriptor ids MUST match the manifest contributions or
 * the host throws. Returns a disposer that tears down both.
 */
export function activate(host: PluginHostApi): () => void {
  const disposeForge = host.registerForgeProvider({ id: "github" }, githubForgeProvider);
  // Pass the registered forge provider so the decoration hook can author
  // the per-file deep-link via `buildPRFileUrl` (a future non-GitHub provider
  // would inject its own equivalent). The provider instance is the same
  // object the host holds — sharing the reference keeps the capability
  // check a single source of truth.
  const disposeDecorations = registerReviewDecorationProvider(host, githubForgeProvider);
  // Periodic sweep of the data caches' expired entries (lazy get()-time
  // eviction can pin entries that stop being read). Cleared on deactivation.
  startCacheSweep();
  // Background token-health probing is plugin-owned (#9304 follow-up): it
  // starts with activation (previously a core deferred task) and stops on
  // deactivation, so a disabled plugin issues no GitHub network. Token
  // STORAGE stays host-owned and eager (GitHubAuth.initializeStorage in
  // globalServicesInit) — a stored token must survive disable/enable.
  gitHubTokenHealthService.start();
  return () => {
    disposeForge();
    disposeDecorations();
    stopCacheSweep();
    // stop(), not dispose(): the renderer-broadcast listeners registered by
    // the host transport (registerGithubHandlers) must survive a disable →
    // enable cycle. resetState() retires any visible unhealthy badge so a
    // banner for a now-off integration can't linger.
    gitHubTokenHealthService.stop();
    gitHubTokenHealthService.resetState();
    // Drop cached issue/PR/stat pages so a later re-enable (possibly under a
    // different token) starts from the network, not stale data.
    clearGitHubCaches();
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
  RestCountsSnapshot,
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
export { getRepoStatsAndPage, getFirstPageCache, getRepoStatsComplete } from "./GitHubStats.js";
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
