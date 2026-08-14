import { createHash } from "node:crypto";
import type {
  AuthValidation,
  AvatarCapability,
  ChecksCapability,
  Credentials,
  FirstPageSnapshot,
  ForgeProviderImpl,
  ForgeRepoCounts,
  ForgeTokenHealthState,
  ForgeUser,
  HealthEventsCapability,
  IdentityCapability,
  IssueTooltipData,
  PRTooltipData,
  IssueCommentCapability,
  ProjectHealthCapability,
  ProjectHealthSnapshot,
  RateLimitDetails,
  RateLimitInfo,
  RepoRef,
  RepoStatsCapability,
  RepoStatsSnapshot,
  ReviewCapability,
  StatsPage,
  TooltipCapability,
} from "../../../../shared/types/forge.js";
import { GitHubAuth } from "./GitHubAuth.js";
import { cloneCapability } from "./GitHubClone.js";
import { validateGitHubToken } from "./GitHubToken.js";
import { parseGitHubRepoUrl } from "./GitHubRepoContext.js";
import { gitHubRateLimitService } from "./GitHubRateLimitService.js";
import { clearPRCaches, repoEventsETagCache } from "./GitHubCaches.js";
import {
  fetchActivityProbe,
  getFirstPageCacheForContext,
  getRepoStatsAndPageForContext,
} from "./GitHubStats.js";
import type { RepoStatsAndPageResult } from "./GitHubStats.js";
import { getProjectHealthForContext } from "./GitHubHealth.js";
import { getIssueTooltipForContext } from "./GitHubIssues.js";
import { getPRTooltipForContext } from "./GitHubPRs.js";
import { resolveAuthorAvatar } from "./GitHubProfilePicture.js";
import { gitHubTokenHealthService } from "./GitHubTokenHealthService.js";
import { fetchRateLimitDetails } from "./GitHubRateLimitApi.js";
import { toRateLimitInfo } from "./rateLimitUtils.js";
import type { GitHubTokenHealthPayload } from "../shared/types.js";
import { gitHubIssueToForgeIssue, gitHubPRToForgePR } from "./mappers.js";
import {
  listIssuesImpl,
  listPRsImpl,
  getIssueImpl,
  getPRImpl,
  findPRByBranchImpl,
  findPRsByBranchesImpl,
  getCIStatusImpl,
  getChecksImpl,
  findPRsByNumbersImpl,
  findIssuesByNumbersImpl,
  getCIStatusesImpl,
  probeOpenPRListImpl,
  getRepoMetadataImpl,
  getReviewThreadsImpl,
  listIssueCommentsImpl,
  getRateLimitImpl,
  classifyPushErrorImpl,
} from "./readOps.js";
import {
  createIssueImpl,
  assignIssueImpl,
  unassignIssueImpl,
  createPRImpl,
  closePRImpl,
  reopenPRImpl,
  mergePRImpl,
  convertPRToDraftImpl,
  markPRReadyForReviewImpl,
  commentOnPRImpl,
  editPRImpl,
  closeIssueImpl,
  reopenIssueImpl,
  editIssueImpl,
  addIssueCommentImpl,
  addIssueLabelImpl,
  removeIssueLabelImpl,
  submitReviewImpl,
  dismissReviewImpl,
  requestReviewersImpl,
} from "./mutations.js";

export { gitHubIssueToForgeIssue, gitHubPRToForgePR };

const reviewCapability: ReviewCapability = {
  getReviewThreads: getReviewThreadsImpl,
  approvePR: (repo, prNumber, body) => submitReviewImpl(repo, prNumber, "APPROVE", body),
  requestChanges: (repo, prNumber, body) =>
    submitReviewImpl(repo, prNumber, "REQUEST_CHANGES", body),
  dismissReview: dismissReviewImpl,
  requestReviewers: requestReviewersImpl,
};

const issueCommentCapability: IssueCommentCapability = {
  listIssueComments: listIssueCommentsImpl,
};

const checksCapability: ChecksCapability = {
  getChecks: getChecksImpl,
};

// Thin pass-through over `GitHubAuth.getConfigAsync()` — reuses the same
// cached `username`/`avatarUrl` and the `pendingValidation` singleflight so a
// cold-start probe (token present, cache empty) coalesces with any other
// concurrent caller and doesn't double-hit `/user`. The provider surface
// expects a `ForgeUser`, so the GitHub `{ login, avatarUrl }` shape is
// projected and the raw `GitHubTokenConfig` stays inside the auth module.
const identityCapability: IdentityCapability = {
  async getCurrentUser(): Promise<ForgeUser | null> {
    const config = await GitHubAuth.getConfigAsync();
    if (!config.username) return null;
    return {
      login: config.username,
      ...(config.avatarUrl ? { avatarUrl: config.avatarUrl } : {}),
      rawData: { source: "GitHubAuth.cached" },
    };
  },
};

// Tooltip lookups route through the context-variant cores (dedicated
// short-TTL tooltip caches + per-number singleflight). Tooltips are
// best-effort by contract, so every failure collapses to `null` here.
const tooltipCapability: TooltipCapability = {
  async getIssueTooltip(repo: RepoRef, issueNumber: number): Promise<IssueTooltipData | null> {
    try {
      return await getIssueTooltipForContext({ owner: repo.owner, repo: repo.repo }, issueNumber);
    } catch {
      return null;
    }
  },
  async getPRTooltip(repo: RepoRef, prNumber: number): Promise<PRTooltipData | null> {
    try {
      return await getPRTooltipForContext({ owner: repo.owner, repo: repo.repo }, prNumber);
    } catch {
      return null;
    }
  },
};

/**
 * Project a {@link RepoStatsAndPageResult} onto the contract counts shape.
 * The rate-limit fields mirror `getRepoStatsComplete`: populated only while a
 * block is active. Local-git facts (commit count) are deliberately absent —
 * the host computes those itself.
 */
function toForgeRepoCounts(result: RepoStatsAndPageResult): ForgeRepoCounts {
  const rateLimitState = gitHubRateLimitService.getState();
  return {
    issueCount: result.stats?.issueCount ?? null,
    prCount: result.stats?.prCount ?? null,
    stale: result.stats?.stale,
    lastUpdated: result.stats?.lastUpdated,
    issueCountRefreshedAt: result.stats?.issueCountRefreshedAt,
    prCountRefreshedAt: result.stats?.prCountRefreshedAt,
    error: result.error,
    rateLimitResetAt:
      rateLimitState.blocked && rateLimitState.resetAt ? rateLimitState.resetAt : undefined,
    rateLimitKind: rateLimitState.blocked ? (rateLimitState.kind ?? undefined) : undefined,
    nextPollIntervalMs: result.nextPollIntervalMs,
  };
}

function toStatsPage<TIn, TOut>(
  page: { items: TIn[]; endCursor: string | null; hasNextPage: boolean; totalCount?: number },
  mapItem: (item: TIn) => TOut
): StatsPage<TOut> {
  return {
    items: page.items.map(mapItem),
    endCursor: page.endCursor,
    hasNextPage: page.hasNextPage,
    ...(typeof page.totalCount === "number" ? { totalCount: page.totalCount } : {}),
  };
}

const repoStatsCapability: RepoStatsCapability = {
  async getRepoStats(repo: RepoRef, opts?: { bypassCache?: boolean }): Promise<RepoStatsSnapshot> {
    const result = await getRepoStatsAndPageForContext(
      { owner: repo.owner, repo: repo.repo },
      { bypassCache: opts?.bypassCache === true }
    );
    return {
      counts: toForgeRepoCounts(result),
      issues: result.issues ? toStatsPage(result.issues, gitHubIssueToForgeIssue) : null,
      prs: result.prs ? toStatsPage(result.prs, gitHubPRToForgePR) : null,
      source: result.source,
    };
  },

  async getFirstPageCache(repo: RepoRef): Promise<FirstPageSnapshot | null> {
    const payload = await getFirstPageCacheForContext({ owner: repo.owner, repo: repo.repo });
    if (!payload) return null;
    return {
      issues: toStatsPage(payload.issues, gitHubIssueToForgeIssue),
      prs: toStatsPage(payload.prs, gitHubPRToForgePR),
      lastUpdated: payload.lastUpdated,
      ...(payload.stats ? { counts: payload.stats } : {}),
    };
  },
};

const projectHealthCapability: ProjectHealthCapability = {
  async getProjectHealth(
    repo: RepoRef,
    opts?: { bypassCache?: boolean }
  ): Promise<{ health: ProjectHealthSnapshot | null; error?: string }> {
    const result = await getProjectHealthForContext(
      { owner: repo.owner, repo: repo.repo },
      { bypassCache: opts?.bypassCache === true }
    );
    if (!result.health) {
      return { health: null, ...(result.error ? { error: result.error } : {}) };
    }
    const health = result.health;
    return {
      health: {
        ciStatus: health.ciStatus,
        issueCount: health.issueCount,
        prCount: health.prCount,
        latestRelease: health.latestRelease,
        securityAlerts: health.securityAlerts,
        mergeVelocity: health.mergeVelocity,
        repoUrl: health.repoUrl,
        ...(health.lastUpdated !== undefined ? { lastUpdated: health.lastUpdated } : {}),
      },
      ...(result.error ? { error: result.error } : {}),
    };
  },
};

const avatarCapability: AvatarCapability = {
  resolveAuthorAvatar: (email: string) => resolveAuthorAvatar(email),
};

function toForgeTokenHealthState(state: GitHubTokenHealthPayload): ForgeTokenHealthState {
  return {
    status: state.status,
    tokenVersion: state.tokenVersion,
    checkedAt: state.checkedAt,
    ...(state.ssoUrl ? { reauthUrl: state.ssoUrl } : {}),
  };
}

// Health events project the plugin-internal service states onto the contract
// shapes. The rate-limit projection reuses `toRateLimitInfo` — the same
// canonical mapping the main-process renderer broadcast applies — so the rule
// can't drift between the capability and the legacy transport.
const healthEventsCapability: HealthEventsCapability = {
  getTokenHealth(): ForgeTokenHealthState {
    return toForgeTokenHealthState(gitHubTokenHealthService.getState());
  },

  onTokenHealthChanged(callback: (state: ForgeTokenHealthState) => void): () => void {
    return gitHubTokenHealthService.onStateChange((state) => {
      callback(toForgeTokenHealthState(state));
    });
  },

  onRateLimitChanged(callback: (info: RateLimitInfo) => void): () => void {
    return gitHubRateLimitService.onStateChange((state) => {
      callback(toRateLimitInfo(state));
    });
  },

  refreshTokenHealth(options?: { force?: boolean }): Promise<void> {
    // The service's own start()/stop() gate and 5-minute cooldown apply, so a
    // disabled plugin never probes and rapid focus toggling can't hammer the API.
    return gitHubTokenHealthService.refresh(options);
  },

  async getRateLimitDetails(): Promise<RateLimitDetails | null> {
    const details = await fetchRateLimitDetails();
    if (!details) return null;
    return {
      buckets: [
        { name: "core", ...details.core },
        { name: "graphql", ...details.graphql },
        { name: "search", ...details.search },
      ],
      fetchedAt: details.fetchedAt,
    };
  },
};

export const githubForgeProvider: ForgeProviderImpl = {
  async getCredentials(): Promise<Credentials | null> {
    const token = GitHubAuth.getToken();
    if (!token) return null;
    return { kind: "bearer", value: token };
  },

  setCredentials(credentials: Credentials | null): void {
    if (credentials === null) {
      GitHubAuth.setMemoryToken(null);
    } else if (credentials.kind === "bearer") {
      GitHubAuth.setMemoryToken(credentials.value);
    }
    // Non-bearer credentials are silently ignored — GitHub only supports bearer tokens.
  },

  async validateCredentials(): Promise<AuthValidation> {
    const token = GitHubAuth.getToken();
    if (!token) {
      return { valid: false, error: "No GitHub token configured" };
    }
    const result = await validateGitHubToken(token);
    return {
      valid: result.valid,
      scopes: result.scopes,
      expiresAt: null,
      ...(result.error ? { error: result.error } : {}),
    };
  },

  parseRemote(url: string): RepoRef | null {
    const parsed = parseGitHubRepoUrl(url);
    if (!parsed) return null;
    return {
      host: "github.com",
      owner: parsed.owner,
      repo: parsed.repo,
      rawData: { url },
    };
  },

  listIssues: listIssuesImpl,
  listPRs: listPRsImpl,
  getIssue: getIssueImpl,
  getPR: getPRImpl,
  findPRByBranch: findPRByBranchImpl,
  findPRsByBranches: findPRsByBranchesImpl,
  getCIStatus: getCIStatusImpl,
  batchLookups: {
    findPRsByNumbers: findPRsByNumbersImpl,
    findIssuesByNumbers: findIssuesByNumbersImpl,
    getCIStatuses: getCIStatusesImpl,
    probeOpenPRList: probeOpenPRListImpl,
  },
  getRepoMetadata: getRepoMetadataImpl,

  buildIssueUrl(repo: RepoRef, number: number): string {
    return `https://github.com/${repo.owner}/${repo.repo}/issues/${number}`;
  },

  buildPRUrl(repo: RepoRef, number: number): string {
    return `https://github.com/${repo.owner}/${repo.repo}/pull/${number}`;
  },

  // GitHub's bare `/issues` list already scopes to `is:issue is:open`, so the
  // default open filter with no search should link there directly rather than a
  // raw `?q=is:open` search view (#11201). Once a search query is present the
  // `is:issue` type qualifier is required to keep results scoped to issues and
  // not leak PRs (GitHub's issue/PR search is unified). `is:closed`/`is:merged`
  // have no bare-URL equivalent, so they stay as `q` qualifiers even without a
  // query (#9986).
  buildIssuesUrl(repo: RepoRef, options?: { query?: string; state?: string }): string {
    const base = `https://github.com/${repo.owner}/${repo.repo}/issues`;
    const query = options?.query;
    const state = options?.state;
    const qParts: string[] = [];
    if (query) qParts.push("is:issue", query);
    if (state && state !== "all" && (state !== "open" || query)) qParts.push(`is:${state}`);
    const params = new URLSearchParams();
    if (qParts.length > 0) params.set("q", qParts.join(" "));
    return params.toString() ? `${base}?${params.toString()}` : base;
  },

  // Mirrors buildIssuesUrl with the `is:pr` type qualifier; bare `/pulls`
  // already scopes to `is:pr is:open`. See buildIssuesUrl for the rationale.
  buildPRsUrl(repo: RepoRef, options?: { query?: string; state?: string }): string {
    const base = `https://github.com/${repo.owner}/${repo.repo}/pulls`;
    const query = options?.query;
    const state = options?.state;
    const qParts: string[] = [];
    if (query) qParts.push("is:pr", query);
    if (state && state !== "all" && (state !== "open" || query)) qParts.push(`is:${state}`);
    const params = new URLSearchParams();
    if (qParts.length > 0) params.set("q", qParts.join(" "));
    return params.toString() ? `${base}?${params.toString()}` : base;
  },

  buildCommitsUrl(repo: RepoRef, branch?: string): string {
    const base = `https://github.com/${repo.owner}/${repo.repo}/commits`;
    return branch ? `${base}/${encodeURIComponent(branch)}` : base;
  },

  // GitHub's `Files changed` view deep-links to a specific file via a
  // `#diff-<sha256-of-utf8-path>` anchor (the SHA-256 is computed from the
  // file's UTF-8 path bytes, not the URL-encoded form). The hash input must
  // match what the plugin's `getPRReviewThreads` data path uses for the
  // file path — if that path is normalized upstream, this hash must mirror
  // the same normalization. Base-SHA-agnostic: github.com resolves the
  // anchor to the current diff on the PR's "Files changed" tab.
  buildPRFileUrl(repo: RepoRef, number: number, path: string): string {
    const hash = createHash("sha256").update(path, "utf8").digest("hex");
    return `https://github.com/${repo.owner}/${repo.repo}/pull/${number}/files#diff-${hash}`;
  },

  createIssue: createIssueImpl,
  assignIssue: assignIssueImpl,
  unassignIssue: unassignIssueImpl,
  createPR: createPRImpl,
  closePR: closePRImpl,
  reopenPR: reopenPRImpl,
  mergePR: mergePRImpl,
  convertPRToDraft: convertPRToDraftImpl,
  markPRReadyForReview: markPRReadyForReviewImpl,
  commentOnPR: commentOnPRImpl,
  editPR: editPRImpl,
  closeIssue: closeIssueImpl,
  reopenIssue: reopenIssueImpl,
  editIssue: editIssueImpl,
  addIssueComment: addIssueCommentImpl,
  addIssueLabel: addIssueLabelImpl,
  removeIssueLabel: removeIssueLabelImpl,

  async validateToken(token: string): Promise<AuthValidation> {
    if (!token || !token.trim()) {
      return { valid: false, error: "Token is required" };
    }
    const result = await validateGitHubToken(token.trim());
    return {
      valid: result.valid,
      scopes: result.scopes,
      expiresAt: null,
      ...(result.error ? { error: result.error } : {}),
    };
  },

  getRateLimit: getRateLimitImpl,

  clearPullRequestCaches(): void {
    clearPRCaches();
  },

  async getRepoActivityProbe(repo: RepoRef): Promise<{ freshnessToken: string }> {
    const token = GitHubAuth.getToken();
    if (!token) {
      throw new Error("GitHub token not configured");
    }
    const probe = await fetchActivityProbe(token, repo.owner, repo.repo);
    const cacheKey = `${repo.owner}/${repo.repo}`;
    // The REST events probe returns either a fresh ETag (`changed`) or signals
    // "nothing new since the cached ETag" (`unchanged`); either way the latest
    // ETag is what the host should byte-compare. On `unknown` the probe has no
    // signal to offer — surface the failure rather than fabricate a token.
    if (probe.status === "unknown") {
      throw new Error("Failed to capture repo activity probe");
    }
    const etag = probe.status === "changed" ? probe.etag : repoEventsETagCache.get(cacheKey);
    if (!etag) {
      throw new Error("Repo activity probe produced no ETag");
    }
    return { freshnessToken: etag };
  },

  classifyPushError: classifyPushErrorImpl,

  reviews: reviewCapability,
  issueComments: issueCommentCapability,
  checks: checksCapability,
  identity: identityCapability,
  tooltips: tooltipCapability,
  repoStats: repoStatsCapability,
  projectHealth: projectHealthCapability,
  avatars: avatarCapability,
  healthEvents: healthEventsCapability,
  clone: cloneCapability,
};
