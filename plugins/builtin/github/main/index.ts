import type { PluginHostApi } from "../../../../shared/types/plugin.js";
import { secureStorage } from "../../../../electron/services/SecureStorage.js";
import { githubForgeProvider } from "./forgeProvider.js";
import { registerReviewDecorationProvider } from "./reviewDecorationProvider.js";
import { startCacheSweep, stopCacheSweep, clearGitHubCaches } from "./GitHubCaches.js";
import { gitHubTokenHealthService } from "./GitHubTokenHealthService.js";
import { GitHubAuth } from "./GitHubAuth.js";
import { BUILTIN_GITHUB_PROVIDER_ID } from "../../../../shared/utils/forgeProviderIds.js";
import { store } from "../../../../electron/store.js";

// Token STORAGE is plugin-owned (formerly eager in globalServicesInit) and
// wires up at the top of activate(): persisted tokens live in electron-store
// (plain sync I/O), so re-initialization on every enable cycle is an
// idempotent re-read and a token stored before a disable survives re-enable.
// A disabled plugin never activates, so it holds no token state in memory.
function initializeTokenStorage(): void {
  GitHubAuth.initializeStorage({
    get: () => secureStorage.get("userConfig.githubToken"),
    set: (token) => secureStorage.set("userConfig.githubToken", token),
    delete: () => secureStorage.delete("userConfig.githubToken"),
  });
}

// E2E hook: seed/clear an in-memory GitHub token so fault-mode tests can
// reach IPC paths gated on `hasToken: true` without hitting the network.
// Skips token validation by pre-seeding cached user info, mirroring the
// post-validate state. Mirrors the __daintreeFaultRegistry pattern — gated
// on DAINTREE_E2E_FAULT_MODE / --daintree-e2e-fault-mode, never present in production.
//
// Post-forge-neutral the renderer's "connected" gate reads
// `forge.getCredentialStatus` (the durable `forgeCredentials` store), NOT the
// in-memory GitHubAuth token, so the seed must write BOTH: the memory token
// for the impl's network calls and the forge-credential store entry for the
// renderer config store (#10347).
const E2E_FAULT_MODE_ARG = "--daintree-e2e-fault-mode";

if (process.env.DAINTREE_E2E_FAULT_MODE === "1" || process.argv.includes(E2E_FAULT_MODE_ARG)) {
  const setForgeCredentialPresence = (token: string | null): void => {
    const existing = store.get("forgeCredentials") ?? {};
    const next = { ...existing };
    if (token) {
      next[BUILTIN_GITHUB_PROVIDER_ID] = JSON.stringify({ token });
    } else {
      delete next[BUILTIN_GITHUB_PROVIDER_ID];
    }
    store.set("forgeCredentials", next);
  };
  (globalThis as Record<string, unknown>).__daintreeSeedGitHubToken = (token: string) => {
    GitHubAuth.setMemoryToken(token);
    const version = GitHubAuth.getTokenVersion();
    GitHubAuth.setValidatedUserInfo("e2e-user", undefined, ["repo"], version);
    setForgeCredentialPresence(token);
  };
  (globalThis as Record<string, unknown>).__daintreeClearGitHubToken = () => {
    GitHubAuth.setMemoryToken(null);
    setForgeCredentialPresence(null);
  };
}

/**
 * Float a one-shot validation of the stored token so user info (username,
 * avatar, scopes) is cached for the session. Never awaited — GitHubAuth.validate
 * has an internal 10s AbortSignal.timeout and nothing depends on the result;
 * the tokenVersion guard makes setValidatedUserInfo a no-op if the token
 * rotates mid-flight.
 */
function validateStoredTokenInBackground(): void {
  const token = GitHubAuth.getToken();
  if (!token) return;
  const versionAtStart = GitHubAuth.getTokenVersion();
  void (async () => {
    try {
      const validation = await GitHubAuth.validate(token);
      if (validation.valid && validation.username) {
        GitHubAuth.setValidatedUserInfo(
          validation.username,
          validation.avatarUrl,
          validation.scopes,
          versionAtStart
        );
        console.log("[github-plugin] user info cached for:", validation.username);
      }
    } catch (err) {
      console.warn("[github-plugin] Failed to validate stored GitHub token:", err);
    }
  })();
}

/**
 * Push the current credentials to every running workspace host. Covers hosts
 * that became ready before this plugin activated — the host-side ready replay
 * pulls from the forge registry, which only knows this provider after
 * activate() binds it.
 */
async function syncCredentialsToWorkspaceHosts(): Promise<void> {
  const token = GitHubAuth.getToken();
  if (!token) return;
  try {
    const { getWorkspaceClient } = await import("../../../../electron/services/WorkspaceClient.js");
    getWorkspaceClient().updateForgeCredentials(BUILTIN_GITHUB_PROVIDER_ID, {
      kind: "bearer",
      value: token,
    });
  } catch {
    // WorkspaceClient may not be initialized yet — hosts created later are
    // seeded from the registry-backed ready replay.
  }
}

/**
 * Plugin activation entry point — called by `PluginService` after manifest
 * validation. Registers the `github` forge provider plus the
 * `worktree-diff-review` file-decoration provider, both declared in
 * `plugin.json`. The descriptor ids MUST match the manifest contributions or
 * the host throws. Returns a disposer that tears down both.
 */
export async function activate(host: PluginHostApi): Promise<() => void> {
  initializeTokenStorage();
  const disposeForge = await host.registerForgeProvider({ id: "github" }, githubForgeProvider);
  validateStoredTokenInBackground();
  void syncCredentialsToWorkspaceHosts();
  // Pass the registered forge provider so the decoration hook can author
  // the per-file deep-link via `buildPRFileUrl` (a future non-GitHub provider
  // would inject its own equivalent). The provider instance is the same
  // object the host holds — sharing the reference keeps the capability
  // check a single source of truth.
  const disposeDecorations = await registerReviewDecorationProvider(host, githubForgeProvider);
  // Periodic sweep of the data caches' expired entries (lazy get()-time
  // eviction can pin entries that stop being read). Cleared on deactivation.
  startCacheSweep();
  // Background token-health probing is plugin-owned (#9304 follow-up): it
  // starts with activation (previously a core deferred task) and stops on
  // deactivation, so a disabled plugin issues no GitHub network. Token
  // STORAGE initializes at the top of activate() — persisted tokens live in
  // electron-store, so they survive disable/enable.
  gitHubTokenHealthService.start();
  return () => {
    disposeForge();
    disposeDecorations();
    stopCacheSweep();
    // stop(), not dispose(): listeners belong to host transports (the forge
    // health relay) which manage their own subscription lifecycle across a
    // disable → enable cycle. resetState() retires any visible unhealthy
    // badge so a banner for a now-off integration can't linger.
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
export {
  getRepoStatsAndPage,
  getRepoStatsAndPageForContext,
  getFirstPageCache,
  getFirstPageCacheForContext,
  getRepoStatsComplete,
} from "./GitHubStats.js";
export type { RepoStatsAndPageResult, RepoStatsCompleteResult } from "./GitHubStats.js";

// Project health
export {
  getProjectHealth,
  getProjectHealthForContext,
  buildEmptyProjectHealthData,
} from "./GitHubHealth.js";

// PR discovery
export { batchCheckLinkedPRs } from "./GitHubPRDiscovery.js";

// Error handling
export { parseGitHubError } from "./GitHubErrors.js";

// PRs
export {
  listPullRequests,
  getPRByNumber,
  getPRsByNumbers,
  getPRsByNumbersForContext,
  getPRTooltip,
  getPRTooltipForContext,
  getPRReviewThreads,
} from "./GitHubPRs.js";

// Issues
export {
  listIssues,
  getIssueByNumber,
  getIssuesByNumbers,
  getIssuesByNumbersForContext,
  getIssueTooltip,
  getIssueTooltipForContext,
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
