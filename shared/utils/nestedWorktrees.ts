import { isPathStrictlyInside } from "./path.js";

/**
 * Stable fragment of the refusal below. The renderer's outbox matches on it to
 * treat the refusal as permanent rather than retrying a deterministic failure,
 * so it is a phrase no path or git message will contain by accident.
 */
export const NESTED_WORKTREE_DELETE_MARKER = "which deleting it would destroy — delete the nested";

/**
 * The candidate paths that sit strictly inside `targetPath`, sorted so the
 * refusal reads the same every time. Spellings that fold to the same key are
 * all kept: on a case-sensitive volume they can be different directories, and
 * the caller has to check each one.
 */
export function findNestedWorktreePaths(
  targetPath: string,
  candidatePaths: Iterable<string>,
  options: { caseInsensitive: boolean }
): string[] {
  const nested = new Set<string>();
  for (const candidate of candidatePaths) {
    if (isPathStrictlyInside(candidate, targetPath, options)) nested.add(candidate);
  }
  return [...nested].sort();
}

/**
 * Deleting a worktree deletes its whole directory, so a registered worktree
 * nested inside goes with it. No consent covers that loss.
 */
export function nestedWorktreeDeleteMessage(nestedPaths: readonly string[]): string {
  if (nestedPaths.length === 1) {
    return `Worktree contains a registered worktree at ${nestedPaths[0]}, ${NESTED_WORKTREE_DELETE_MARKER} worktree first.`;
  }
  return `Worktree contains ${nestedPaths.length} registered worktrees (${nestedPaths.join(", ")}), ${NESTED_WORKTREE_DELETE_MARKER} worktrees first.`;
}
