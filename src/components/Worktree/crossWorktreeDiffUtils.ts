import type { WorktreeState } from "@shared/types";

export function sortWorktreesForComparison(worktrees: Iterable<WorktreeState>): WorktreeState[] {
  return Array.from(worktrees).sort((a, b) => {
    if (a.isMainWorktree && !b.isMainWorktree) return -1;
    if (!a.isMainWorktree && b.isMainWorktree) return 1;
    return a.name.localeCompare(b.name);
  });
}
