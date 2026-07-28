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

/** Windows-flavored absolute path (drive-letter or UNC), where `\` and `/` are
 * both separators and comparison is case-insensitive. */
function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

/**
 * Drop a trailing separator, but never reduce a value to a bare volume root
 * (`/`, `C:`, `\\`) — those aren't project directories and stripping them would
 * corrupt an exact-root rebase.
 */
function stripTrailingSep(value: string): string {
  if (value.length <= 1) return value;
  const stripped = value.replace(/[\\/]+$/, "");
  if (stripped === "" || /^[A-Za-z]:$/.test(stripped)) return value;
  return stripped;
}

/**
 * Rebase an absolute filesystem path from `oldRoot` to `newRoot`.
 *
 * Returns `value` with its `oldRoot` prefix replaced by `newRoot`, matching
 * only at a path-segment boundary so `/repo` never rewrites `/repo-copy`. On
 * Windows-flavored roots (drive/UNC) the comparison is case-insensitive and
 * treats `\` and `/` as equivalent separators; on POSIX only `/` is a separator
 * and comparison is exact — so a POSIX file literally named `project\copy` next
 * to `/old/project` is left alone. The original suffix spelling is preserved.
 *
 * `value` is returned unchanged when it is not an absolute path, or not at/under
 * `oldRoot`. The transform is deliberately conservative — a stale path is safer
 * than corrupting an unrelated project's data — so it never infers through
 * symlinks and never touches relative values.
 */
export function rebaseAbsolutePath(value: string, oldRoot: string, newRoot: string): string {
  if (typeof value !== "string" || !value || !oldRoot || !newRoot) return value;
  if (!isAbsoluteFsPath(value)) return value;

  const windows = isWindowsPath(oldRoot) || isWindowsPath(value);
  const separators = windows ? "\\/" : "/";
  const fold = (s: string): string => (windows ? s.replace(/\\/g, "/").toLowerCase() : s);

  const v = stripTrailingSep(value);
  const o = stripTrailingSep(oldRoot);
  const n = stripTrailingSep(newRoot);

  if (fold(v) === fold(o)) return n;

  // Descendant: the char immediately after the old-root prefix must be a
  // separator, and the prefix must match (case-/separator-folded on Windows).
  const boundary = v.length > o.length ? v[o.length] : undefined;
  if (
    boundary !== undefined &&
    separators.includes(boundary) &&
    fold(v.slice(0, o.length)) === fold(o)
  ) {
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
