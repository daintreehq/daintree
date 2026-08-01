import type { GitStatus } from "@shared/types/git";

export interface GitStatusPresentation {
  /** Single-character marker for dense rows, where a word would not fit. */
  marker: string;
  /** The status spelled out, for accessible names and pointer tooltips. */
  name: string;
  /**
   * Semantic foreground token. Never an accent token: the accent is reserved
   * for one load-bearing signal per focus region, and status is inherently
   * multi-element. The marker letter is what carries the meaning for anyone
   * who cannot separate the hues — colour is the secondary channel here.
   */
  colorClass: string;
}

/**
 * How a git status reads across the app. Shared so the worktree change list,
 * the file browser's tree markers and its changed-files summary cannot drift
 * into three different letters for the same state.
 */
export const GIT_STATUS_PRESENTATION = {
  modified: { marker: "M", name: "Modified", colorClass: "text-status-warning" },
  added: { marker: "A", name: "Added", colorClass: "text-status-success" },
  deleted: { marker: "D", name: "Deleted", colorClass: "text-status-error" },
  untracked: { marker: "?", name: "Untracked", colorClass: "text-status-success" },
  renamed: { marker: "R", name: "Renamed", colorClass: "text-status-info" },
  copied: { marker: "C", name: "Copied", colorClass: "text-status-info" },
  ignored: { marker: "I", name: "Ignored", colorClass: "text-daintree-text/40" },
  conflicted: { marker: "!", name: "Conflicted", colorClass: "text-status-error" },
} satisfies Record<GitStatus, GitStatusPresentation>;

/**
 * Falls back rather than returning undefined: `status` arrives over IPC, so a
 * value outside the union is a runtime possibility the type system can't rule
 * out, and a row with no marker at all would read as "unchanged".
 */
export function getGitStatusPresentation(status: GitStatus): GitStatusPresentation {
  return GIT_STATUS_PRESENTATION[status] || GIT_STATUS_PRESENTATION.untracked;
}
