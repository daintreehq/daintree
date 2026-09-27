import type { WorktreeSnapshot } from "@shared/types";

export function sortWorktreesForComparison(
  worktrees: Iterable<WorktreeSnapshot>
): WorktreeSnapshot[] {
  return Array.from(worktrees).sort((a, b) => {
    if (a.isMainWorktree && !b.isMainWorktree) return -1;
    if (!a.isMainWorktree && b.isMainWorktree) return 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * The comparison is branch against branch, so the branch is what an option
 * names. A detached worktree has none to compare and is offered disabled
 * rather than accepted and silently ignored.
 */
export function worktreeOptionLabel(wt: WorktreeSnapshot): string {
  if (!wt.branch) return `${wt.name} (detached)`;
  return wt.isMainWorktree ? `${wt.branch} (main worktree)` : wt.branch;
}
