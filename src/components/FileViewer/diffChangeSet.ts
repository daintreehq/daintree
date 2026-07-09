import type { GitStatus } from "@shared/types";

/**
 * One file of the changeset a diff modal was opened from. Leaf module (no
 * component imports) so the sidebar, the modal, and its openers can all share
 * the shape without creating an import cycle through FileDiffModal.
 */
export interface DiffChangeSetEntry {
  /** Repo-relative path */
  path: string;
  status: GitStatus;
  insertions?: number | null;
  deletions?: number | null;
  /**
   * Caller-owned key for the viewed-marker store (scoped per worktree).
   * Callers keep their existing conventions: `staged:{path}` /
   * `unstaged:{path}` (Review Hub), `{status}:{path}` (change list),
   * `base:{path}` (base-branch review).
   */
  viewedKey: string;
}

export const DIFF_STATUS_CONFIG: Record<GitStatus, { label: string; color: string }> = {
  modified: { label: "M", color: "text-status-warning" },
  added: { label: "A", color: "text-status-success" },
  deleted: { label: "D", color: "text-status-error" },
  untracked: { label: "?", color: "text-status-success" },
  renamed: { label: "R", color: "text-status-info" },
  copied: { label: "C", color: "text-status-info" },
  ignored: { label: "I", color: "text-daintree-text/40" },
  conflicted: { label: "!", color: "text-status-error" },
};

export function summarizeChangeSet(files: DiffChangeSetEntry[]): {
  insertions: number;
  deletions: number;
} {
  let insertions = 0;
  let deletions = 0;
  for (const file of files) {
    insertions += file.insertions ?? 0;
    deletions += file.deletions ?? 0;
  }
  return { insertions, deletions };
}
