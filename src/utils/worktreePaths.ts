// Normalizes separators (backslash → forward slash) and trims trailing slashes
// so cwd and worktree paths compare apples-to-apples on Windows, where node-pty
// returns backslashes but simple-git returns forward slashes.
function normalizeForComparison(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * Infer a worktreeId from a terminal's cwd by longest-prefix matching against the
 * worktrees list. Returns undefined when no worktree's path is a prefix of cwd.
 * Uses segment-aware matching after normalizing separators on both sides, so
 * mixed POSIX/Windows separators between cwd and worktree paths still match.
 */
export function inferWorktreeIdFromCwd(
  cwd: string | undefined,
  worktrees: ReadonlyArray<{ id: string; path: string }> | undefined
): string | undefined {
  if (!cwd || !worktrees || worktrees.length === 0) return undefined;
  const normalizedCwd = normalizeForComparison(cwd);
  let best: { id: string; normalizedLength: number } | undefined;
  for (const wt of worktrees) {
    if (!wt.path) continue;
    const normalizedWtPath = normalizeForComparison(wt.path);
    if (normalizedCwd === normalizedWtPath || normalizedCwd.startsWith(normalizedWtPath + "/")) {
      if (!best || normalizedWtPath.length > best.normalizedLength) {
        best = { id: wt.id, normalizedLength: normalizedWtPath.length };
      }
    }
  }
  return best?.id;
}
