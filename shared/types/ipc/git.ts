import type { GitStatus } from "../git.js";

/** Pre-agent file snapshot info */
export interface SnapshotInfo {
  worktreeId: string;
  stashRef: string;
  createdAt: number;
  hasChanges: boolean;
}

/** Result of reverting to a pre-agent snapshot */
export interface SnapshotRevertResult {
  success: boolean;
  hasConflicts: boolean;
  message: string;
}

/** Get file diff payload */
export interface GitGetFileDiffPayload {
  /** Working directory (worktree path) */
  cwd: string;
  /** Path to the file relative to worktree root */
  filePath: string;
  /** Git status of the file */
  status: GitStatus;
}

/** Single file entry in a cross-worktree comparison */
export interface CrossWorktreeFile {
  /** File path (new path for renames) */
  path: string;
  /** Original path before rename (only set for renamed files) */
  oldPath?: string;
  /** Change status: A=added, D=deleted, M=modified, R=renamed, C=copied, U=unmerged */
  status: "A" | "D" | "M" | "R" | "C" | "U" | string;
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
}
