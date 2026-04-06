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
