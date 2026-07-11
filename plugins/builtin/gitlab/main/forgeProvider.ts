import type {
  AuthValidation,
  Credentials,
  ForgeProviderImpl,
  ForgeUser,
  HealthEventsCapability,
  IdentityCapability,
  RateLimitDetails,
  ReleaseCapability,
  RepoRef,
  RepoStatsCapability,
  TooltipCapability,
} from "../../../../shared/types/forge.js";
import {
  getInstanceHost,
  getToken,
  getTokenHealth,
  getTokenVersion,
  getValidatedUserInfo,
  onTokenHealthChanged,
  refreshTokenHealth,
  setMemoryToken,
  setValidatedUserInfo,
  validateGitLabToken,
} from "./GitLabAuth.js";
import { getRateLimitSnapshot } from "./GitLabClient.js";
import { parseGitLabRemoteUrl, repoWebUrl } from "./gitlabRemote.js";
import {
  clearGitLabCaches,
  findPRByBranchImpl,
  findPRsByBranchesImpl,
  getCIStatusImpl,
  getIssueImpl,
  getIssueTooltipImpl,
  getLatestReleaseImpl,
  getPRImpl,
  getPRTooltipImpl,
  getRateLimitImpl,
  getRepoMetadataImpl,
  getRepoStatsImpl,
  listIssuesImpl,
  listPRsImpl,
  listReleasesImpl,
  resolveAuthorAvatarImpl,
} from "./readOps.js";
import {
  addIssueCommentImpl,
  addIssueLabelImpl,
  assignIssueImpl,
  closeIssueImpl,
  closePRImpl,
  commentOnPRImpl,
  convertPRToDraftImpl,
  createIssueImpl,
  createPRImpl,
  editIssueImpl,
  editPRImpl,
  markPRReadyForReviewImpl,
  mergePRImpl,
  removeIssueLabelImpl,
  reopenIssueImpl,
  reopenPRImpl,
  unassignIssueImpl,
} from "./mutations.js";

function toAuthValidation(result: Awaited<ReturnType<typeof validateGitLabToken>>): AuthValidation {
  return {
    valid: result.valid,
    ...(result.scopes ? { scopes: result.scopes } : {}),
    // Absent = expiry unknown (introspection unavailable); explicit null =
    // confirmed non-expiring. Don't collapse unknown into "never expires".
    ...(result.expiresAt !== undefined ? { expiresAt: result.expiresAt } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}

const identityCapability: IdentityCapability = {
  /**
   * Cached "who am I" against the configured instance. Validates lazily on
   * the first call after a token change and caches the result under the
   * token version, so repeated calls don't re-hit `/user`.
   */
  async getCurrentUser(): Promise<ForgeUser | null> {
    const token = getToken();
    if (!token) return null;
    const cached = getValidatedUserInfo();
    if (cached) {
      return {
        login: cached.username,
        ...(cached.avatarUrl ? { avatarUrl: cached.avatarUrl } : {}),
        rawData: { source: "GitLabAuth.cached" },
      };
    }
    const versionAtStart = getTokenVersion();
    const result = await validateGitLabToken(token);
    if (!result.valid || !result.username) return null;
    setValidatedUserInfo(
      {
        username: result.username,
        ...(result.avatarUrl ? { avatarUrl: result.avatarUrl } : {}),
        ...(result.scopes ? { scopes: result.scopes } : {}),
      },
      versionAtStart
    );
    return {
      login: result.username,
      ...(result.avatarUrl ? { avatarUrl: result.avatarUrl } : {}),
      rawData: { source: "GitLabAuth.validated" },
    };
  },
};

const tooltipCapability: TooltipCapability = {
  getIssueTooltip: getIssueTooltipImpl,
  getPRTooltip: getPRTooltipImpl,
};

const releaseCapability: ReleaseCapability = {
  listReleases: listReleasesImpl,
  getLatestRelease: getLatestReleaseImpl,
};

const repoStatsCapability: RepoStatsCapability = {
  getRepoStats: getRepoStatsImpl,
};

const healthEventsCapability: HealthEventsCapability = {
  getTokenHealth,
  onTokenHealthChanged,
  refreshTokenHealth,

  /**
   * GitLab reports one per-user REST quota via `RateLimit-*` headers rather
   * than named buckets; project the configured instance's last-seen snapshot
   * as a single bucket, or `null` before any request has observed the
   * headers. `fetchedAt` is the real capture time, not the call time.
   */
  async getRateLimitDetails(): Promise<RateLimitDetails | null> {
    const snapshot = getRateLimitSnapshot(await getInstanceHost());
    if (!snapshot) return null;
    const { info, fetchedAt } = snapshot;
    if (info.limit === null || info.remaining === null || info.resetAt === null) {
      return null;
    }
    return {
      buckets: [
        {
          name: "rest",
          limit: info.limit,
          used: info.limit - info.remaining,
          remaining: info.remaining,
          resetAt: info.resetAt,
        },
      ],
      fetchedAt,
    };
  },
};

// No clone capability in v1: the host's fallback is a plain anonymous
// `git clone`, which is the safe default. A token-embedded clone URL would
// persist the PAT into `.git/config` via `remote.origin.url` — authenticated
// clone needs an askpass-style flow (see the GitHub plugin's `gh repo clone`
// path) and is deliberately deferred.

function listUrl(
  repo: RepoRef,
  kind: "issues" | "merge_requests",
  options?: { query?: string; state?: string }
): string {
  const base = `${repoWebUrl(repo)}/-/${kind}`;
  const params = new URLSearchParams();
  if (options?.query) params.set("search", options.query);
  if (options?.state && options.state !== "all") {
    params.set("state", options.state === "open" ? "opened" : options.state);
  }
  const qs = params.toString();
  return qs.length > 0 ? `${base}/?${qs}` : base;
}

export const gitlabForgeProvider: ForgeProviderImpl = {
  async getCredentials(): Promise<Credentials | null> {
    const token = getToken();
    if (!token) return null;
    return { kind: "bearer", value: token };
  },

  setCredentials(credentials: Credentials | null): void {
    const before = getTokenVersion();
    if (credentials === null) {
      setMemoryToken(null);
    } else if (credentials.kind === "bearer") {
      setMemoryToken(credentials.value);
    }
    // Non-bearer credentials are silently ignored — GitLab tokens are bearer.
    // A credential change invalidates everything fetched under the old one
    // (private tooltips, stats, instance-scoped avatars).
    if (getTokenVersion() !== before) {
      clearGitLabCaches();
    }
  },

  async validateCredentials(): Promise<AuthValidation> {
    const token = getToken();
    if (!token) {
      return { valid: false, error: "No GitLab token configured" };
    }
    const versionAtStart = getTokenVersion();
    const result = await validateGitLabToken(token);
    if (result.valid && result.username) {
      setValidatedUserInfo(
        {
          username: result.username,
          ...(result.avatarUrl ? { avatarUrl: result.avatarUrl } : {}),
          ...(result.scopes ? { scopes: result.scopes } : {}),
        },
        versionAtStart
      );
    }
    return toAuthValidation(result);
  },

  parseRemote(url: string): RepoRef | null {
    // Host-agnostic on purpose: routing (manifest hostnames, per-project
    // override, global default) happens before parseRemote, so a self-hosted
    // GitLab remote parses here and the REST base derives from its host.
    const parsed = parseGitLabRemoteUrl(url);
    if (!parsed) return null;
    return {
      host: parsed.host,
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
  getRepoMetadata: getRepoMetadataImpl,

  buildIssueUrl(repo: RepoRef, number: number): string {
    return `${repoWebUrl(repo)}/-/issues/${number}`;
  },

  buildPRUrl(repo: RepoRef, number: number): string {
    return `${repoWebUrl(repo)}/-/merge_requests/${number}`;
  },

  buildIssuesUrl(repo: RepoRef, options?: { query?: string; state?: string }): string {
    return listUrl(repo, "issues", options);
  },

  buildPRsUrl(repo: RepoRef, options?: { query?: string; state?: string }): string {
    return listUrl(repo, "merge_requests", options);
  },

  buildCommitsUrl(repo: RepoRef, branch?: string): string {
    const base = `${repoWebUrl(repo)}/-/commits`;
    return branch ? `${base}/${encodeURIComponent(branch)}` : base;
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
    const result = await validateGitLabToken(token.trim());
    return toAuthValidation(result);
  },

  getRateLimit: getRateLimitImpl,

  clearPullRequestCaches(): void {
    clearGitLabCaches();
  },

  identity: identityCapability,
  tooltips: tooltipCapability,
  releases: releaseCapability,
  repoStats: repoStatsCapability,
  healthEvents: healthEventsCapability,

  avatars: {
    async resolveAuthorAvatar(email: string): Promise<string | null> {
      return resolveAuthorAvatarImpl(await getInstanceHost(), email);
    },
  },
};
