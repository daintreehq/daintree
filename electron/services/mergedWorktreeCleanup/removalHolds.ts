/**
 * Projects whose workspace host is removing a merged worktree for main's rule
 * (#17321). The host pool keeps a host it holds through its dormant grace, so
 * a host started with no window open isn't reclaimed under the removal.
 */
const held = new Map<string, number>();

export function holdHostForMergedWorktreeRemoval(projectId: string): () => void {
  held.set(projectId, (held.get(projectId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (held.get(projectId) ?? 1) - 1;
    if (count > 0) held.set(projectId, count);
    else held.delete(projectId);
  };
}

export function isHostHeldForMergedWorktreeRemoval(projectId: string): boolean {
  return held.has(projectId);
}
