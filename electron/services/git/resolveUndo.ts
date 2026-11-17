/**
 * Run from the worktree root, as the staging handler does: git lists only the
 * current directory's subtree, and the hardened environment's literal
 * pathspecs rule out the `:/` that would widen it. `-z` is load-bearing for the
 * same reason as in `porcelainConflicts.ts`: without it git C-quotes paths
 * containing a tab, double quote, newline or backslash.
 */
export const RESOLVE_UNDO_ARGS = ["ls-files", "--resolve-undo", "-z"];

// "<mode> <object name> <stage>\t<path>", one record per stage git still holds.
const RESOLVE_UNDO_HEADER = /^[0-7]{6} (?:[0-9a-f]{40}|[0-9a-f]{64}) [123]$/;

/**
 * The paths whose conflict the index still remembers resolving: the ones
 * `git add` or `git rm` took out of the unmerged state since the last commit.
 * A path git merged cleanly never conflicted and has no record.
 *
 * `null` when the output is not the grammar above, so the caller reports
 * nothing rather than a classification built on a partial read.
 */
export function parseResolveUndoPaths(raw: string): string[] | null {
  if (raw === "") return [];
  if (!raw.endsWith("\0")) return null;
  const paths = new Set<string>();
  for (const record of raw.slice(0, -1).split("\0")) {
    const tab = record.indexOf("\t");
    if (tab === -1 || tab === record.length - 1) return null;
    if (!RESOLVE_UNDO_HEADER.test(record.slice(0, tab))) return null;
    paths.add(record.slice(tab + 1));
  }
  return [...paths];
}
