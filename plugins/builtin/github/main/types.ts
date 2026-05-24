import type {
  GitHubIssue,
  GitHubPR,
  GitHubPRCIStatus,
  PRTooltipData,
} from "../../../../shared/types/github.js";

export interface RepoContext {
  owner: string;
  repo: string;
}

export interface RepoStats {
  issueCount: number;
  prCount: number;
  stale?: boolean;
  lastUpdated?: number;
}

/** One connection page (issues or PRs) as returned by `getRepoStatsAndPage`. */
export interface RepoConnectionPage<TItem> {
  items: TItem[];
  endCursor: string | null;
  hasNextPage: boolean;
  totalCount: number;
}

/**
 * Full result of a network `getRepoStatsAndPage` fetch, cached so a matching
 * activity probe can return it without re-issuing `REPO_STATS_AND_PAGE_QUERY`.
 */
export interface RepoStatsAndPageSnapshot {
  stats: RepoStats;
  issues: RepoConnectionPage<GitHubIssue>;
  prs: RepoConnectionPage<GitHubPR>;
}

export interface RepoStatsResult {
  stats: RepoStats | null;
  error?: string;
}

export interface LinkedPR {
  number: number;
  url: string;
  state: "open" | "merged" | "closed";
  isDraft: boolean;
  title: string;
  /**
   * Roll-up CI state for the PR head commit, sourced from
   * `commits(last: 1).commit.statusCheckRollup.state` in the batch GraphQL
   * query. Absent when the PR has no checks or the field was not returned.
   */
  ciStatus?: GitHubPRCIStatus;
}

export interface PRCheckResult {
  issueNumber?: number;
  issueTitle?: string;
  branchName?: string;
  pr: LinkedPR | null;
  /**
   * Tooltip-shaped data harvested from the same batch query, used to pre-warm
   * `prTooltipCache` so hover-time fetches hit instantly. Populated only when
   * the batch query yielded a PR with the extended tooltip fields.
   */
  tooltipData?: PRTooltipData;
}

export interface PRCheckCandidate {
  worktreeId: string;
  issueNumber?: number;
  branchName?: string;
  /**
   * When set, enables ETag-based change detection on `/pulls/{knownPRNumber}`
   * before issuing the batch GraphQL query. Used by the revalidation path to
   * skip GraphQL entirely when all known PRs return 304 Not Modified (which
   * does not consume primary rate-limit points).
   */
  knownPRNumber?: number;
}

export interface BatchPRCheckResult {
  results: Map<string, PRCheckResult>;
  error?: string;
  /**
   * When set, the error originated from a GitHub rate limit and includes
   * the resume timestamp. Callers use this to park retry scheduling at
   * the known resume time without counting the failure toward a
   * circuit-breaker threshold.
   */
  rateLimit?: { kind: "primary" | "secondary"; resumeAt: number };
}

export type CIStatus = "success" | "failure" | "error" | "pending" | "expected" | "none";

export interface ProjectHealth {
  ciStatus: CIStatus;
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
  lastUpdated?: number;
}

export interface ProjectHealthResult {
  health: ProjectHealth | null;
  error?: string;
}
