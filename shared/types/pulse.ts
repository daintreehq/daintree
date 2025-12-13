export type PulseRangeDays = 60 | 120 | 180;
export type HeatLevel = 0 | 1 | 2 | 3 | 4;

export interface HeatCell {
  date: string;
  count: number;
  level: HeatLevel;
  isToday?: boolean;
  isMostRecentActive?: boolean;
}

export interface CommitItem {
  sha: string;
  subject: string;
  authorName?: string;
  timestamp: number;
}

export interface BranchDeltaToMain {
  baseBranch: string;
  headBranch?: string;
  ahead: number;
  behind: number;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
}

export interface ProjectPulse {
  worktreeId: string;
  worktreePath: string;
  branch?: string;
  mainBranch: string;
  rangeDays: PulseRangeDays;
  generatedAt: number;
  heatmap: HeatCell[];
  commitsInRange: number;
  activeDays: number;
  currentStreakDays?: number;
  recentCommits: CommitItem[];
  uncommitted?: {
    changedFiles: number;
    insertions?: number;
    deletions?: number;
    lastUpdated?: number;
  };
  deltaToMain?: BranchDeltaToMain;
}

export interface GetProjectPulseOptions {
  worktreePath: string;
  worktreeId: string;
  mainBranch: string;
  rangeDays: PulseRangeDays;
  includeDelta?: boolean;
  includeRecentCommits?: boolean;
  forceRefresh?: boolean;
}
