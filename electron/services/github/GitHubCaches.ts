import { Cache } from "../../utils/cache.js";
import { GitHubFirstPageCache } from "../GitHubFirstPageCache.js";
import { GitHubStatsCache } from "../GitHubStatsCache.js";
import type {
  GitHubIssue,
  GitHubPR,
  GitHubPRCIStatus,
  GitHubPRCISummary,
  GitHubListResponse,
  IssueTooltipData,
  PRTooltipData,
} from "../../../shared/types/github.js";
import type { RepoContext, RepoStats } from "./types.js";

export const repoContextCache = new Cache<string, RepoContext>({ defaultTTL: 300000 });
export const repoStatsCache = new Cache<string, RepoStats>({ defaultTTL: 60000 });
export const issueListCache = new Cache<string, GitHubListResponse<GitHubIssue>>({
  defaultTTL: 60000,
});
export const prListCache = new Cache<string, GitHubListResponse<GitHubPR>>({ defaultTTL: 60000 });
export const projectHealthCache = new Cache<string, unknown>({ defaultTTL: 60000 });
export const issueTooltipCache = new Cache<string, IssueTooltipData>({ defaultTTL: 300000 });

export const prTooltipWrittenAt = new Map<string, number>();
export const prTooltipCache = new Cache<string, PRTooltipData>({
  defaultTTL: 300000,
  onEvict: (key) => {
    prTooltipWrittenAt.delete(key as string);
  },
});

export const prETagCache = new Map<string, string>();
export const branchListETagCache = new Map<string, string>();

export interface PRRequiredStatusEntry {
  ciStatus: GitHubPRCIStatus | undefined;
  ciSummary: GitHubPRCISummary | undefined;
}
export const prRequiredStatusCache = new Cache<string, PRRequiredStatusEntry>({
  defaultTTL: 60000,
});

export function clearGitHubCaches(): void {
  repoContextCache.clear();
  repoStatsCache.clear();
  projectHealthCache.clear();
  issueListCache.clear();
  prListCache.clear();
  issueTooltipCache.clear();
  prTooltipCache.clear();
  prTooltipWrittenAt.clear();
  prETagCache.clear();
  branchListETagCache.clear();
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
  prListCache.clear();
  prTooltipCache.clear();
  prTooltipWrittenAt.clear();
  prRequiredStatusCache.clear();
}
