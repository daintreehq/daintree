import { isPathStrictlyInside } from "./path.js";

/**
 * Stable fragment of the refusal below. The renderer's outbox matches on it to
 * treat the refusal as permanent rather than retrying a deterministic failure.
 */
export const NESTED_WORKTREE_DELETE_MARKER = "registered worktree";

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
    return `Worktree contains a ${NESTED_WORKTREE_DELETE_MARKER} at ${nestedPaths[0]}. Deleting it would delete that worktree too — delete it first.`;
  }
  return `Worktree contains ${nestedPaths.length} ${NESTED_WORKTREE_DELETE_MARKER}s: ${nestedPaths.join(", ")}. Deleting it would delete them too — delete them first.`;
}
