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
}

/** GitHub token validation result */
export interface GitHubTokenValidation {
  /** Whether the token is valid */
  valid: boolean;
  /** Token scopes */
  scopes: string[];
  /** GitHub username */
  username?: string;
  /** Error message if validation failed */
  error?: string;
}

/** PR detected payload */
export interface PRDetectedPayload {
  worktreeId: string;
  prNumber: number;
  prUrl: string;
  prState: "open" | "merged" | "closed";
  issueNumber?: number;
}

/** Payload for PR cleared notification */
export interface PRClearedPayload {
  worktreeId: string;
}
