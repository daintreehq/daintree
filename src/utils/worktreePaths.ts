import { isHostWindows, isRemoteWindow } from "@/hooks/useHostPlatform";

// Normalizes separators (backslash → forward slash) and trims trailing slashes
// so cwd and worktree paths compare apples-to-apples on Windows, where node-pty
// returns backslashes but simple-git returns forward slashes. A Windows host
// also compares case-insensitively (`c:\repo` and `C:\Repo` are one directory);
// elsewhere case is significant.
function normalizeForComparison(p: string, caseInsensitive: boolean): string {
  const normalized = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

/**
 * The absolute path of a file git reported relative to a worktree, spelled by
 * the host's rules. Git separates with "/" everywhere, so on a POSIX host a
 * backslash belongs to a name (`a\b.txt` is not `a/b.txt`) and survives. A
 * Windows host can't name a file with one and takes either separator.
 * Remote hosts are macOS or Linux, so a remote window is POSIX even before
 * its platform arrives, when `isHostWindows` would answer for this machine.
 */
export function joinWorktreeFilePath(worktreePath: string, relativePath: string): string {
  const windows = !isRemoteWindow() && isHostWindows();
  const base = windows ? worktreePath.replace(/\\/g, "/") : worktreePath;
  const tail = windows ? relativePath.replace(/\\/g, "/") : relativePath;
  return `${base.replace(/\/+$/, "")}/${tail.replace(/^\/+/, "")}`;
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
  const caseInsensitive = isHostWindows();
  const normalizedCwd = normalizeForComparison(cwd, caseInsensitive);
  let best: { id: string; normalizedLength: number } | undefined;
  for (const wt of worktrees) {
    if (!wt.path) continue;
    const normalizedWtPath = normalizeForComparison(wt.path, caseInsensitive);
    if (normalizedCwd === normalizedWtPath || normalizedCwd.startsWith(normalizedWtPath + "/")) {
      if (!best || normalizedWtPath.length > best.normalizedLength) {
        best = { id: wt.id, normalizedLength: normalizedWtPath.length };
      }
    }
  }
  return best?.id;
}
