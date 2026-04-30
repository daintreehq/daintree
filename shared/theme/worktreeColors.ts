/**
 * Per-worktree color identity system.
 *
 * Assigns each active worktree a unique accent color from a CVD-safe subset of
 * the existing category-* OKLCH theme tokens. Colors are assigned by
 * sorted-index (worktrees sorted by path) so assignment is deterministic for a
 * given set of worktrees.
 */

/**
 * 8-color CVD-safe palette ordered for maximum adjacent perceptual distance.
 * Skips: green (status-success conflict), slate (too neutral), rose (status-danger conflict).
 */
export const WORKTREE_COLOR_PALETTE = [
  "category-blue",
  "category-orange",
  "category-teal",
  "category-pink",
  "category-amber",
  "category-violet",
  "category-indigo",
  "category-cyan",
] as const;

export type WorktreeColorToken = (typeof WORKTREE_COLOR_PALETTE)[number];

/**
 * Compute a mapping from worktree ID to its CSS variable color string.
 * Worktrees are sorted by path for deterministic assignment.
 * Returns null when there are 0 or 1 worktrees (single-worktree suppression).
 */
export function computeWorktreeColorMap(
  worktrees: ReadonlyMap<string, { path: string }>
): Record<string, string> | null {
  if (worktrees.size <= 1) return null;

  const sorted = Array.from(worktrees.entries()).sort((a, b) => a[1].path.localeCompare(b[1].path));

  const map: Record<string, string> = {};
  for (const [i, entry] of sorted.entries()) {
    const token = WORKTREE_COLOR_PALETTE[i % WORKTREE_COLOR_PALETTE.length]!;
    map[entry[0]] = `var(--theme-${token})`;
  }
  return map;
}
