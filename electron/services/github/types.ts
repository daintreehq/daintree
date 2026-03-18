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
}

export interface PRCheckResult {
  issueNumber?: number;
  issueTitle?: string;
  branchName?: string;
  pr: LinkedPR | null;
}

export interface PRCheckCandidate {
  worktreeId: string;
  issueNumber?: number;
  branchName?: string;
}

export interface BatchPRCheckResult {
  results: Map<string, PRCheckResult>;
  error?: string;
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
    recentMergedCount: number;
    recentMergedDates: string[];
  };
  repoUrl: string;
  lastUpdated?: number;
}

export interface ProjectHealthResult {
  health: ProjectHealth | null;
  error?: string;
}
