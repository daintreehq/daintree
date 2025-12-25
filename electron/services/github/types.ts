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
}

export interface PRCheckResult {
  issueNumber?: number;
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
