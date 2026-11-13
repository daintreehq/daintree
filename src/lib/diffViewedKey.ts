/**
 * Namespace of the one Viewed mark a working-tree file carries. Every surface
 * that shows a worktree's uncommitted changes (the Review Hub's staged and
 * unstaged rows, the change list, `worktree.openChanges`) builds its key here,
 * so a file checked off in one reads as reviewed in the others, and moving it
 * between the staging sections leaves the mark where it is (#16897).
 */
export const WORKING_TREE_VIEWED_SECTION = "working-tree";

/**
 * The Viewed key for a working-tree file, from its forward-slash
 * worktree-relative path: git's own spelling, which the change list's
 * `relativePath` already normalises to. Taken verbatim, since a backslash is a
 * legal filename character on POSIX.
 */
export function workingTreeViewedKey(relativePath: string): string {
  return `${WORKING_TREE_VIEWED_SECTION}:${relativePath}`;
}
