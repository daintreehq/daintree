/**
 * The sender project's custom worktree titles (#14022), as main holds them.
 * Main sends one to every view of the project after each change.
 */
export interface WorktreeTitlesSnapshot {
  projectId: string;
  /** Worktree id → title, normalised. Absent means the computed headline. */
  titles: Record<string, string>;
  /** Bumped on every write; a view drops a snapshot older than the one it holds. */
  revision: number;
}
