// Core GitHub Types

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
  /** Number of reviews */
  reviewCount?: number;
}

// Git Commit Types

/** Git commit author */
export interface GitCommitAuthor {
  name: string;
  email: string;
}

/** Git commit representation */
export interface GitCommit {
  hash: string;
  shortHash: string;
  message: string;
  body?: string;
  author: GitCommitAuthor;
  date: string;
}

/** Git commit list options */
export interface GitCommitListOptions {
  cwd: string;
  search?: string;
  branch?: string;
  skip?: number;
  limit?: number;
}

/** Git commit list response */
export interface GitCommitListResponse {
  items: GitCommit[];
  hasMore: boolean;
  total: number;
}

// List Options and Response Types

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
}
