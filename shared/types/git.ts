/** Git file status */
export type GitStatus =
  | "modified"
  | "added"
  | "deleted"
  | "untracked"
  | "ignored"
  | "renamed"
  | "copied"
  | "conflicted";

/** Details about a single file change in a worktree */
export interface FileChangeDetail {
  /** Relative path to the file from worktree root */
  path: string;
  /** Git status of the file */
  status: GitStatus;
  /** Number of lines inserted (null if not applicable) */
  insertions: number | null;
  /** Number of lines deleted (null if not applicable) */
  deletions: number | null;
  /** File modification time in milliseconds (for recency scoring) */
  mtimeMs?: number;
  /** Alias for mtimeMs (compatibility with some APIs) */
  mtime?: number;
}

/** Aggregated git changes for a worktree */
export interface WorktreeChanges {
  /** Unique identifier for the worktree */
  worktreeId: string;
  /** Absolute path to worktree root */
  rootPath: string;
  /** List of individual file changes */
  changes: FileChangeDetail[];
  /** Total count of changed files */
  changedFileCount: number;
  /** Total lines inserted across all files */
  totalInsertions?: number;
  /** Total lines deleted across all files */
  totalDeletions?: number;
  /** Alias for totalInsertions (compatibility) */
  insertions?: number;
  /** Alias for totalDeletions (compatibility) */
  deletions?: number;
  /** Most recent file modification time */
  latestFileMtime?: number;
  /** Timestamp when changes were last calculated */
  lastUpdated?: number;
  /** Last commit message (cached to avoid extra git log calls) */
  lastCommitMessage?: string;
  /** Last commit time (ms since epoch, committer date) */
  lastCommitTimestampMs?: number;
}

export interface StagingFileEntry {
  path: string;
  status: GitStatus;
  insertions: number | null;
  deletions: number | null;
}

/**
 * In-progress repository operation state. `CLEAN` means no operation markers
 * and no unmerged entries; `DIRTY` means unmerged entries exist without an
 * operation marker (unusual). `MERGING`/`REBASING`/`CHERRY_PICKING`/`REVERTING`
 * correspond to the matching `.git/` state files.
 */
export type RepoState = "CLEAN" | "DIRTY" | "MERGING" | "REBASING" | "CHERRY_PICKING" | "REVERTING";

/** XY code from `git status --porcelain=v2` unmerged (`u`) entries. */
export type ConflictXYCode = "UU" | "AA" | "DD" | "AU" | "UA" | "DU" | "UD";

export interface ConflictedFileEntry {
  path: string;
  /** The two-letter unmerged code (e.g. `UU`). Unknown codes are passed through as-is. */
  xy: string;
  /** Human-readable label derived from the XY code (e.g. "both modified"). */
  label: string;
}

export interface StagingStatus {
  staged: StagingFileEntry[];
  unstaged: StagingFileEntry[];
  /** @deprecated Use `conflictedFiles` for richer per-file details. Kept for backward compat. */
  conflicted: string[];
  /** Per-file conflict entries parsed from `git status --porcelain=v2` u-lines. */
  conflictedFiles: ConflictedFileEntry[];
  isDetachedHead: boolean;
  currentBranch: string | null;
  hasRemote: boolean;
  /** Current in-progress repository operation, or `CLEAN`/`DIRTY`. */
  repoState: RepoState;
  /** When `repoState === "REBASING"`, the current step number (1-based). Null otherwise. */
  rebaseStep: number | null;
  /** When `repoState === "REBASING"`, the total step count. Null otherwise. */
  rebaseTotalSteps: number | null;
}
