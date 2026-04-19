/** Kind of GitHub rate limit currently active */
export type GitHubRateLimitKind = "primary" | "secondary";

/** Repository stats from GitHub API */
export interface RepositoryStats {
  /** Total commit count for current branch */
  commitCount: number;
  /** Open issues count (null if unavailable) */
  issueCount: number | null;
  /** Open pull requests count (null if unavailable) */
  prCount: number | null;
  /** Whether stats are currently loading */
  loading: boolean;
  /** Error message if GitHub API failed */
  ghError?: string;
  /** Whether the stats are from cache and may be outdated */
  stale?: boolean;
  /** Timestamp when stats were last successfully fetched from API */
  lastUpdated?: number;
  /** Unix epoch milliseconds when a GitHub rate limit resumes */
  rateLimitResetAt?: number;
  /** Kind of active GitHub rate limit (primary quota vs secondary abuse) */
  rateLimitKind?: GitHubRateLimitKind;
}

/** Push payload describing the current GitHub rate-limit state */
export interface GitHubRateLimitPayload {
  /** Whether outbound GitHub calls are currently blocked */
  blocked: boolean;
  /** Kind of active rate limit, or null when unblocked */
  kind: GitHubRateLimitKind | null;
  /** Unix epoch milliseconds when the block is expected to resume (primary only) */
  resetAt?: number;
}

/**
 * Current health of the configured GitHub token.
 *
 * - `unknown`: no token configured or no probe has completed yet
 * - `healthy`: the most recent health probe returned 2xx
 * - `unhealthy`: the most recent health probe returned 401 (token expired/revoked)
 *
 * Network failures and non-401 errors deliberately do not transition the
 * state — only an authoritative 401 from GitHub flips to `unhealthy`.
 */
export type GitHubTokenHealthStatus = "unknown" | "healthy" | "unhealthy";

/** Push payload describing the current GitHub token health state */
export interface GitHubTokenHealthPayload {
  /** Current health status */
  status: GitHubTokenHealthStatus;
  /** Token version at the time of the last completed probe */
  tokenVersion: number;
  /** Unix epoch milliseconds at which the last probe completed */
  checkedAt: number;
  /**
   * Captured SSO re-authorization URL (`X-GitHub-SSO: required; url=...`) if
   * one was observed on any recent response. Expires one hour after capture.
   */
  ssoUrl?: string;
}

/** Project health data from GitHub API */
export interface ProjectHealthData {
  ciStatus: "success" | "failure" | "error" | "pending" | "expected" | "none";
  issueCount: number;
  prCount: number;
  latestRelease: {
    tagName: string;
    publishedAt: string | null;
    url: string;
  } | null;
  securityAlerts: {
    visible: boolean;
    count: number;
  };
  mergeVelocity: {
    mergedCounts: Record<60 | 120 | 180, number>;
  };
  repoUrl: string;
  hasRemote: boolean;
  loading: boolean;
  error?: string;
  lastUpdated?: number;
}

/** GitHub CLI availability check result */
export interface GitHubCliStatus {
  /** Whether gh CLI is available */
  available: boolean;
  /** Error message if not available */
  error?: string;
}

/** GitHub token configuration status */
export interface GitHubTokenConfig {
  /** Whether a token is configured */
  hasToken: boolean;
  /** Token scopes (only available after validation) */
  scopes?: string[];
  /** GitHub username (only available after validation) */
  username?: string;
  /** GitHub avatar URL (only available after validation) */
  avatarUrl?: string;
}

/** GitHub token validation result */
export interface GitHubTokenValidation {
  /** Whether the token is valid */
  valid: boolean;
  /** Token scopes */
  scopes: string[];
  /** GitHub username */
  username?: string;
  /** GitHub avatar URL */
  avatarUrl?: string;
  /** Error message if validation failed */
  error?: string;
}

/** PR detected payload */
export interface PRDetectedPayload {
  worktreeId: string;
  prNumber: number;
  prUrl: string;
  prState: "open" | "merged" | "closed";
  prTitle?: string;
  issueNumber?: number;
  issueTitle?: string;
  timestamp: number;
}

/** Payload for PR cleared notification */
export interface PRClearedPayload {
  worktreeId: string;
  timestamp: number;
}

/** Issue detected payload */
export interface IssueDetectedPayload {
  worktreeId: string;
  issueNumber: number;
  issueTitle: string;
}

/** Git remote with parsed GitHub repo info */
export interface RemoteInfo {
  name: string;
  fetchUrl: string;
  parsedRepo: { owner: string; repo: string } | null;
}

/** Issue not found payload - emitted when GitHub confirms issue doesn't exist on current repo */
export interface IssueNotFoundPayload {
  worktreeId: string;
  issueNumber: number;
  timestamp: number;
}
