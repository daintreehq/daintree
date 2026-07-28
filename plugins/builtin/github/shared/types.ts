/**
 * GitHub wire types — the plugin's own request/response and push-payload
 * shapes, shared between its main-process services and renderer views.
 * Moved from `shared/types/github.ts` / `shared/types/ipc/github.ts` when the
 * host finished migrating to the provider-neutral `forge:*` surface; nothing
 * outside this plugin should import these.
 */

// Core GitHub Types

import type { NormalizedReviewDecision } from "../../../../shared/types/forge.js";

/** GitHub user */
export interface GitHubUser {
  /** GitHub username */
  login: string;
  /** Avatar URL */
  avatarUrl: string;
}

/** GitHub label */
export interface GitHubLabel {
  /** Label name */
  name: string;
  /** Label color (hex without #) */
  color: string;
}

/** Linked PR information for an issue */
export interface LinkedPRInfo {
  /** PR number */
  number: number;
  /** PR state */
  state: "OPEN" | "CLOSED" | "MERGED";
  /** PR URL */
  url: string;
  /** Last updated timestamp, when selected by a query that includes it */
  updatedAt?: string;
  /** CI status rollup from the latest commit, when selected by the linked-PR query */
  ciStatus?: GitHubPRCIStatus;
  /** Required-check summary, when selected by a hydrated linked-PR query */
  ciSummary?: GitHubPRCISummary;
}

/** GitHub issue representation */
export interface GitHubIssue {
  /** Issue number */
  number: number;
  /** Issue title */
  title: string;
  /** Issue URL */
  url: string;
  /** Issue state */
  state: "OPEN" | "CLOSED";
  /** Last updated timestamp */
  updatedAt: string;
  /** Issue author */
  author: GitHubUser;
  /** Assigned users */
  assignees: GitHubUser[];
  /** Number of comments */
  commentCount: number;
  /** Issue labels */
  labels?: GitHubLabel[];
  /** Associated PR information (if any) */
  linkedPR?: LinkedPRInfo;
}

export type GitHubPRCIStatus = "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED";

/** Required-check summary derived from statusCheckRollup.contexts */
export interface GitHubPRCISummary {
  /** Total number of required contexts seen */
  requiredTotal: number;
  /** Number of required contexts with a failing conclusion/state */
  requiredFailing: number;
  /** Number of required contexts still in progress / pending */
  requiredPending: number;
}

/** Global (non-required-filtered) CI aggregate summary from in-band statusCheckRollup.contexts */
export interface GitHubPRGlobalCISummary {
  /** Total check runs across all states */
  checkRunCount: number;
  /** Total status contexts across all states */
  statusContextCount: number;
  /** Failing check runs + status contexts (global, not required-filtered) */
  failingCount: number;
  /** Pending check runs + status contexts (global, not required-filtered) */
  pendingCount: number;
}

/** GitHub pull request representation */
export interface GitHubPR {
  /** PR number */
  number: number;
  /** PR title */
  title: string;
  /** PR URL */
  url: string;
  /** PR state */
  state: "OPEN" | "CLOSED" | "MERGED";
  /** Whether this is a draft PR */
  isDraft: boolean;
  /** Last updated timestamp */
  updatedAt: string;
  /** PR author */
  author: GitHubUser;
  /** Aggregate review decision — drives the approval badge without an N+1 fetch.
   *  `null` when the repo doesn't gate on reviews, `undefined` when not reported. */
  reviewDecision?: NormalizedReviewDecision;
  /** Head branch name (short ref, e.g. "feature/my-branch") */
  headRefName?: string;
  /** Whether this PR originates from a fork repository */
  isFork?: boolean;
  /** Number of comments */
  commentCount?: number;
  /** CI status rollup from the latest commit (reflects required checks only when ciSummary is present) */
  ciStatus?: GitHubPRCIStatus;
  /** Summary of required checks. Absent when enrichment hasn't run, when the context page
   *  was truncated, or when the repository has no required checks configured (in which case
   *  ciStatus reflects the raw rollup). */
  ciSummary?: GitHubPRCISummary;
  /** Merge state status from the PR. UNKNOWN on freshly-opened PRs that GitHub hasn't backgrounded yet. */
  mergeStateStatus?:
    "BEHIND" | "BLOCKED" | "CLEAN" | "DIRTY" | "HAS_HOOKS" | "UNKNOWN" | "UNSTABLE";
  /** Global CI status derived from in-band statusCheckRollup.contexts aggregates (not required-filtered) */
  globalCIStatus?: GitHubPRCIStatus;
  /** Global CI aggregate counts from in-band statusCheckRollup.contexts (not required-filtered) */
  globalCISummary?: GitHubPRGlobalCISummary;
  /** Plain-text PR body. Used to body-parse closing-issue references (`Closes #N`)
   *  when capturing the source PR at worktree-create time. */
  bodyText?: string;
}

// List Options and Response Types

export type GitHubSortOrder = "created" | "updated";

/** GitHub list options */
export interface GitHubListOptions {
  /** Working directory to determine repository */
  cwd: string;
  /** Search query (optional) */
  search?: string;
  /** State filter */
  state?: "open" | "closed" | "merged" | "all";
  /** Pagination cursor */
  cursor?: string;
  /** Skip the in-memory list cache and fetch fresh data */
  bypassCache?: boolean;
  /** Sort order field */
  sortOrder?: GitHubSortOrder;
}

/** Paginated response for GitHub lists */
export interface GitHubListResponse<T> {
  /** List items */
  items: T[];
  /** Pagination info */
  pageInfo: {
    /** Whether more results are available */
    hasNextPage: boolean;
    /** Cursor for next page */
    endCursor: string | null;
  };
  /**
   * Server-side total for the requested states (GraphQL `totalCount`). Present
   * only on the non-search list path; absent for search results, which have no
   * stable "total open" count. Lets the toolbar badge show the real total
   * instead of the loaded first-page length (issue #9717).
   */
  totalCount?: number;
}

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
  /**
   * Timestamps when the issue/PR counts were last read from a GitHub count
   * endpoint. `lastUpdated` is re-stamped when the main-process activity
   * probe confirms "nothing changed" and re-serves cached counts; these are
   * not — consumers that need true count recency (badge arbitration,
   * dropdown-open force refresh) read them, treating absence on a
   * `stale: true` payload as unknown rather than fresh. Per-count because a
   * list query's write-back refreshes only its own kind.
   */
  issueCountRefreshedAt?: number;
  prCountRefreshedAt?: number;
  /** Unix epoch milliseconds when a GitHub rate limit resumes */
  rateLimitResetAt?: number;
  /** Kind of active GitHub rate limit (primary quota vs secondary abuse) */
  rateLimitKind?: GitHubRateLimitKind;
  /**
   * Suggested delay (ms) until the next background stats poll, derived from the
   * main-process `/events` activity probe's adaptive backoff (issue #9741):
   * ~60s while changes are landing, growing toward ~5min on an idle repo. The
   * renderer's visible-poll scheduler honors this so the badge stays fresh
   * without polling excessively. Absent on error/disk-fallback results.
   */
  nextPollIntervalMs?: number;
}

/** Push payload describing the current GitHub rate-limit state */
export interface GitHubRateLimitPayload {
  /** Whether outbound GitHub calls are currently blocked */
  blocked: boolean;
  /** Kind of active rate limit, or null when unblocked */
  kind: GitHubRateLimitKind | null;
  /** Unix epoch milliseconds when the block is expected to resume (primary only) */
  resetAt?: number;
  /** `x-ratelimit-resource` bucket name when the block is per-resource primary */
  resource?: string;
  /**
   * Points left in the current GraphQL budget window, from the last observed
   * `rateLimit` node. Absent until a budget-carrying response is seen.
   */
  remaining?: number;
  /** Total points in the GraphQL budget window (5000 for authenticated users). */
  limit?: number;
  /**
   * Background-poll cadence multiplier derived from the remaining budget. `1`
   * at full speed; values above `1` stretch background fetch intervals so
   * multiple instances drawing on the same token budget back off in step.
   */
  throttleMultiplier?: number;
}

/** A single rate-limit bucket as reported by `/rate_limit` */
export interface GitHubRateLimitBucket {
  limit: number;
  used: number;
  remaining: number;
  /** Unix epoch milliseconds when this bucket's quota resets */
  resetAt: number;
}

/**
 * Detailed per-bucket rate-limit snapshot from `GET /rate_limit`. Calls to that
 * endpoint don't count against any quota, so consumers can poll it freely.
 */
export interface GitHubRateLimitDetails {
  core: GitHubRateLimitBucket;
  graphql: GitHubRateLimitBucket;
  search: GitHubRateLimitBucket;
  /** Wall-clock timestamp (ms) when the snapshot was fetched */
  fetchedAt: number;
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

/**
 * Disk-persisted first page returned by `getFirstPageCache`. Surfaces the same
 * shape the renderer's `githubResourceCache` expects — minus a wall-clock
 * `timestamp`, which the renderer derives from `lastUpdated`.
 */
export interface GitHubFirstPageCachePayload {
  /** Absolute project path the entry was written for. */
  projectPath: string;
  /** First page of open issues, sorted by created-at desc, as last seen. */
  issues: {
    items: GitHubIssue[];
    endCursor: string | null;
    hasNextPage: boolean;
  };
  /** First page of open pull requests, sorted by created-at desc, as last seen. */
  prs: {
    items: GitHubPR[];
    endCursor: string | null;
    hasNextPage: boolean;
  };
  /** Wall-clock timestamp (ms) when the entry was written. */
  lastUpdated: number;
  /** Optional cached stats for cold-start toolbar hydration (60-min TTL).
   *  Present when `GitHubStatsCache` has a bootstrap-eligible entry even if
   *  the first-page items cache has expired. */
  stats?: {
    issueCount: number;
    prCount: number;
    lastUpdated: number;
  };
}

/**
 * Push payload broadcast after every successful repo-stats-and-first-page poll.
 * Carries both the count badges (matching `RepositoryStats`) and the first page
 * of open issues + open PRs in the default sort (created-desc), so the renderer
 * can prime its `githubResourceCache` with no click-time round-trip.
 */
export interface RepoStatsAndPagePayload {
  /** Absolute project path the payload corresponds to. */
  projectPath: string;
  /** Combined stats (counts + freshness metadata) — same shape useRepositoryStats already consumes. */
  stats: RepositoryStats;
  /** First page of open issues, sorted by created-at desc. */
  issues: {
    items: GitHubIssue[];
    endCursor: string | null;
    hasNextPage: boolean;
    totalCount: number;
  };
  /** First page of open pull requests, sorted by created-at desc. */
  prs: {
    items: GitHubPR[];
    endCursor: string | null;
    hasNextPage: boolean;
    totalCount: number;
  };
  /** Wall-clock timestamp when the poll completed (ms). */
  fetchedAt: number;
}

/**
 * Lightweight count-only push, broadcast when a background poll refreshed the
 * toolbar counts via the cheap REST path (issue #10122) — no first-page items
 * to ship. `RepoStatsAndPagePayload` keeps its full semantics: it fires only
 * when a poll produced actual page data.
 */
export interface RepoCountsUpdatedPayload {
  /** Absolute project path the payload corresponds to. */
  projectPath: string;
  /** Combined stats (counts + freshness metadata) — same shape useRepositoryStats already consumes. */
  stats: RepositoryStats;
  /** Wall-clock timestamp when the poll completed (ms). */
  fetchedAt: number;
}
