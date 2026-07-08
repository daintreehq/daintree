import type { GitStatus } from "../git.js";

/** Get file diff payload */
export interface GitGetFileDiffPayload {
  /** Working directory (worktree path) */
  cwd: string;
  /** Path to the file relative to worktree root */
  filePath: string;
  /** Git status of the file */
  status: GitStatus;
  /** When true, passes --ignore-all-space so whitespace-only changes are omitted */
  ignoreWhitespace?: boolean;
}

/** Single file entry in a cross-worktree comparison */
export interface CrossWorktreeFile {
  /** File path (new path for renames) */
  path: string;
  /** Original path before rename (only set for renamed files) */
  oldPath?: string;
  /** Change status: A=added, D=deleted, M=modified, R=renamed, C=copied, U=unmerged */
  status: "A" | "D" | "M" | "R" | "C" | "U" | string;
  /** Lines inserted (null for binary files or when numstat is unavailable) */
  insertions: number | null;
  /** Lines deleted (null for binary files or when numstat is unavailable) */
  deletions: number | null;
}

/** Result of comparing two branches */
export interface CrossWorktreeDiffResult {
  /** Branch/ref used as left side */
  branch1: string;
  /** Branch/ref used as right side */
  branch2: string;
  /** Files that differ between the two branches */
  files: CrossWorktreeFile[];
}

/** Scan results for a single conflicted file */
export interface ConflictMarkerScanEntry {
  /** Path relative to the worktree root (matches the request path verbatim) */
  path: string;
  /** Count of `<<<<<<<` opening markers — one per hunk. `null` when the scan failed or the file was skipped (binary/oversized/unreadable). */
  hunkCount: number | null;
  /** 1-based line number of the first `<<<<<<<` marker, or `null` when unavailable. */
  firstMarkerLine: number | null;
}

/** Payload for scanning conflict markers across a batch of files */
export interface GitScanConflictMarkersPayload {
  /** Worktree path */
  cwd: string;
  /** Paths relative to the worktree root */
  filePaths: string[];
}

/** Payload for whole-file conflict resolution via `git checkout --ours/--theirs` */
export interface GitCheckoutOursTheirsPayload {
  /** Worktree path */
  cwd: string;
  /** Path relative to the worktree root */
  filePath: string;
  /** Which side of the conflict to take. */
  side: "ours" | "theirs";
}

/** Payload to compare two branches */
export interface GitCompareWorktreesPayload {
  /** Any worktree path (used as git cwd — all worktrees share the same .git store) */
  cwd: string;
  /** Left branch/ref */
  branch1: string;
  /** Right branch/ref */
  branch2: string;
  /** Optional specific file path to get the diff for (omit to get file list only) */
  filePath?: string;
  /** When true, uses merge-base (three-dot) diff range for PR-accurate comparison */
  useMergeBase?: boolean;
  /** When true, passes --ignore-all-space so whitespace-only changes are omitted */
  ignoreWhitespace?: boolean;
}
