// Pure naming helpers shared by every surface that says where a notification
// came from. No store imports, so hooks and tests can use them freely.

/**
 * A worktree id is its path, so an id this view can't resolve (another
 * project's worktree) still has a readable last segment. Everything before it
 * is where the user keeps their checkouts, not which checkout it was.
 */
export function worktreeNameFromId(worktreeId: string): string {
  const segments = worktreeId.split(/[\\/]+/).filter(Boolean);
  return segments[segments.length - 1] ?? worktreeId;
}

/**
 * What a project id that names no registered project is called. The store holds
 * every registered project, so this is a project since removed — said plainly
 * rather than printed as the sha256 it is, and never dropped, because a row
 * with no source reads as belonging to the project you're looking at.
 */
export const UNKNOWN_PROJECT_LABEL = "Another project";

/**
 * Joins the resolved parts with the separator the row's metadata line uses. A
 * main worktree is named after the folder, which is usually the project's own
 * name, so it isn't repeated.
 */
export function formatNotificationSource(project?: string, worktree?: string): string | null {
  const p = project?.trim();
  const w = worktree?.trim();
  const parts = [p, w && w !== p ? w : undefined].filter((x): x is string => !!x);
  return parts.length > 0 ? parts.join(" · ") : null;
}
