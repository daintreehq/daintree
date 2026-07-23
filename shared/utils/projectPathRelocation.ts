/**
 * Path rebasing for project folder moves/renames (#11282, phase 2).
 *
 * A same-volume project-folder rename re-prefixes every absolute path at or
 * below the old root. `Worktree.id` is itself a normalized absolute path, so a
 * single conservative prefix substitution rewrites worktree ids, panel cwds,
 * file-panel paths and session-history entries alike.
 *
 * Pure string ops (no node `path`) so this is safe to import from renderer code
 * as well as main.
 */

/**
 * True for an absolute filesystem path: POSIX (`/...`), Windows drive
 * (`C:\...` / `C:/...`) or UNC (`\\server\...`). Anything else — a relative
 * path, a URL, an opaque id — is left untouched by {@link rebaseAbsolutePath}.
 */
export function isAbsoluteFsPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function stripTrailingSep(p: string): string {
  return p.length > 1 && (p.endsWith("/") || p.endsWith("\\")) ? p.replace(/[\\/]+$/, "") : p;
}

/**
 * Rebase an absolute filesystem path from `oldRoot` to `newRoot`.
 *
 * Returns `value` with its `oldRoot` prefix replaced by `newRoot`, matching
 * only at a path-segment boundary so `/repo` never rewrites `/repo-copy`.
 * `value` is returned unchanged when it is not an absolute path, or not at/under
 * `oldRoot`. The transform is deliberately conservative — a stale path is safer
 * than corrupting an unrelated project's data — so it never infers through
 * symlinks and never touches relative values.
 */
export function rebaseAbsolutePath(value: string, oldRoot: string, newRoot: string): string {
  if (typeof value !== "string" || !value || !oldRoot || !newRoot) return value;
  if (!isAbsoluteFsPath(value)) return value;

  const v = stripTrailingSep(value);
  const o = stripTrailingSep(oldRoot);
  const n = stripTrailingSep(newRoot);

  if (v === o) return n;

  // Segment boundary against either separator — a path can carry mixed ones.
  if (v.startsWith(`${o}/`) || v.startsWith(`${o}\\`)) {
    return n + v.slice(o.length);
  }
  return value;
}

/**
 * Rebase a quick-switcher MRU entry. Entries are `worktree:<absolute-path>` or
 * `terminal:<id>`; only the worktree suffix is a filesystem path, so `terminal:`
 * entries pass through untouched.
 */
export function rebaseMruEntry(entry: string, oldRoot: string, newRoot: string): string {
  const prefix = "worktree:";
  if (!entry.startsWith(prefix)) return entry;
  const p = entry.slice(prefix.length);
  const rebased = rebaseAbsolutePath(p, oldRoot, newRoot);
  return rebased === p ? entry : `${prefix}${rebased}`;
}
