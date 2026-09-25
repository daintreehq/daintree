import { isPathStrictlyInside, pathComparisonKey } from "./path.js";

/**
 * Stable fragment of the refusal below. The renderer's outbox matches on it to
 * treat the refusal as permanent rather than retrying a deterministic failure.
 */
export const NESTED_WORKTREE_DELETE_MARKER = "contains a registered worktree";

/**
 * The candidate paths that sit strictly inside `targetPath`, one per directory
 * however often it was listed, sorted so the refusal reads the same every time.
 */
export function findNestedWorktreePaths(
  targetPath: string,
  candidatePaths: Iterable<string>,
  options: { caseInsensitive: boolean }
): string[] {
  const nested = new Map<string, string>();
  for (const candidate of candidatePaths) {
    if (!isPathStrictlyInside(candidate, targetPath, options)) continue;
    const key = pathComparisonKey(candidate, options);
    if (!nested.has(key)) nested.set(key, candidate);
  }
  return [...nested.values()].sort();
}

/**
 * Deleting a worktree deletes its whole directory, so a registered worktree
 * nested inside goes with it. No consent covers that loss.
 */
export function nestedWorktreeDeleteMessage(nestedPaths: readonly string[]): string {
  if (nestedPaths.length === 1) {
    return `Worktree ${NESTED_WORKTREE_DELETE_MARKER} at ${nestedPaths[0]}. Deleting it would delete that worktree too — delete it first.`;
  }
  return `Worktree ${NESTED_WORKTREE_DELETE_MARKER} at each of ${nestedPaths.join(", ")}. Deleting it would delete them too — delete them first.`;
}
