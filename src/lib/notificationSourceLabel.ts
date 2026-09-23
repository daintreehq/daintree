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

/** Joins the resolved parts with the separator the row's metadata line uses. */
export function formatNotificationSource(project?: string, worktree?: string): string | null {
  const parts = [project, worktree].filter((p): p is string => !!p && p.trim().length > 0);
  return parts.length > 0 ? parts.join(" · ") : null;
}
