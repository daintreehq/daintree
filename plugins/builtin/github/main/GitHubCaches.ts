import { Cache } from "../../../../electron/utils/cache.js";
import { GitHubFirstPageCache } from "../../../../electron/services/GitHubFirstPageCache.js";
import { GitHubStatsCache } from "../../../../electron/services/GitHubStatsCache.js";
import type {
  GitHubIssue,
  GitHubPR,
  GitHubPRCIStatus,
  GitHubPRCISummary,
  GitHubListResponse,
  IssueTooltipData,
  PRTooltipData,
} from "../../../../shared/types/github.js";
import type {
  RepoActivityProbe,
  RepoContext,
  RepoStats,
  RepoStatsAndPageSnapshot,
} from "./types.js";

export const repoContextCache = new Cache<string, RepoContext>({ defaultTTL: 300000 });
export const repoStatsCache = new Cache<string, RepoStats>({ defaultTTL: 60000 });
export const issueListCache = new Cache<string, GitHubListResponse<GitHubIssue>>({
  defaultTTL: 60000,
});
export const prListCache = new Cache<string, GitHubListResponse<GitHubPR>>({ defaultTTL: 60000 });
export const projectHealthCache = new Cache<string, unknown>({ defaultTTL: 60000 });
export const issueTooltipCache = new Cache<string, IssueTooltipData>({ defaultTTL: 300000 });

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;

/**
 * Merged-PR velocity counts (60/120/180-day windows). Keyed by repo + UTC date
 * so a new day forces a recompute even within the 4h TTL — the velocity
 * windows are anchored to "now", so yesterday's cache would use stale date
 * boundaries. See `buildVelocityCacheKey` in `GitHubHealth.ts`.
 */
export const velocityCache = new Cache<string, Record<60 | 120 | 180, number>>({
  defaultTTL: FOUR_HOURS_MS,
});

/**
 * Last seen {@link REPO_ACTIVITY_PROBE_QUERY} result per repo. `getRepoStatsAndPage`
 * compares a fresh probe against this to decide whether the expensive stats
 * query can be skipped. 10-minute TTL caps how long a probe gap can suppress
 * a real fetch.
 */
export const repoActivityProbeCache = new Cache<string, RepoActivityProbe>({
  defaultTTL: TEN_MINUTES_MS,
});

/**
 * Last full `getRepoStatsAndPage` network result per repo. Returned when the
 * activity probe confirms nothing changed. 10-minute TTL bounds worst-case
 * staleness if the probe ever fails to detect a change.
 */
export const repoStatsAndPageSnapshotCache = new Cache<string, RepoStatsAndPageSnapshot>({
  defaultTTL: TEN_MINUTES_MS,
});

export const prTooltipWrittenAt = new Map<string, number>();
export const prTooltipCache = new Cache<string, PRTooltipData>({
  defaultTTL: 300000,
  onEvict: (key) => {
    prTooltipWrittenAt.delete(key as string);
  },
});

const ETAG_CACHE_MAX_SIZE = 500;
const ETAG_CACHE_TTL = 3_600_000; // 1 hour

export const prETagCache = new Cache<string, string>({
  maxSize: ETAG_CACHE_MAX_SIZE,
  defaultTTL: ETAG_CACHE_TTL,
});
export const branchListETagCache = new Cache<string, string>({
  maxSize: ETAG_CACHE_MAX_SIZE,
  defaultTTL: ETAG_CACHE_TTL,
});

let etagCacheVersion = 0;

export function getETagCacheVersion(): number {
  return etagCacheVersion;
}

export interface PRRequiredStatusEntry {
  ciStatus: GitHubPRCIStatus | undefined;
  ciSummary: GitHubPRCISummary | undefined;
}
export const reviewThreadsCache = new Cache<string, Record<string, number>>({
  defaultTTL: 300000,
});

export const prRequiredStatusCache = new Cache<string, PRRequiredStatusEntry>({
  defaultTTL: 60000,
});

export function clearGitHubCaches(): void {
  etagCacheVersion++;
  repoContextCache.clear();
  repoStatsCache.clear();
  projectHealthCache.clear();
  velocityCache.clear();
  repoActivityProbeCache.clear();
  repoStatsAndPageSnapshotCache.clear();
  issueListCache.clear();
  prListCache.clear();
  issueTooltipCache.clear();
  prTooltipCache.clear();
  prTooltipWrittenAt.clear();
  prETagCache.clear();
  branchListETagCache.clear();
  reviewThreadsCache.clear();
  prRequiredStatusCache.clear();
  GitHubFirstPageCache.getInstance().clear();
  GitHubStatsCache.getInstance().clear();
}

export function truncateBody(body: string | null | undefined, maxLength = 150): string {
  if (!body) return "";
  const cleaned = body.replace(/\r?\n/g, " ").trim();
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.slice(0, maxLength).trim() + "…";
}

export function clearPRCaches(): void {
  etagCacheVersion++;
  prListCache.clear();
  prTooltipCache.clear();
  prTooltipWrittenAt.clear();
  prETagCache.clear();
  branchListETagCache.clear();
  reviewThreadsCache.clear();
  prRequiredStatusCache.clear();
}
