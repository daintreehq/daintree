import type { WorktreeDiskUsage } from "@/hooks/useWorktreeDiskUsage";

/**
 * Largest first. Worktrees without a figure yet — still measuring, or unknown —
 * follow the measured ones in the order they came in, so a row that turns
 * from pending to unknown doesn't move, and equal sizes keep their order.
 */
export function orderWorktreesBySize<T extends { id: string }>(
  worktrees: readonly T[],
  usage: ReadonlyMap<string, WorktreeDiskUsage>
): T[] {
  const bytesOf = (id: string): number | null => {
    const entry = usage.get(id);
    return entry?.status === "measured" ? entry.bytes : null;
  };
  return [...worktrees].sort((a, b) => {
    const sizeA = bytesOf(a.id);
    const sizeB = bytesOf(b.id);
    if (sizeA === null || sizeB === null) {
      if (sizeA === sizeB) return 0;
      return sizeA === null ? 1 : -1;
    }
    return sizeB - sizeA;
  });
}
