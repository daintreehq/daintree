import type { WorktreeDiskUsage } from "@/hooks/useWorktreeDiskUsage";

/**
 * Largest first. Worktrees without a figure yet — still measuring, or unknown —
 * follow the measured ones in the order they came in, so a row that turns
 * from pending to unknown doesn't move, and equal sizes keep their order.
 *
 * Worktrees from outside the project stay below everything the project owns,
 * as in every other order (#11434): size orders within each side.
 */
export function orderWorktreesBySize<T extends { id: string; isExternal?: boolean }>(
  worktrees: readonly T[],
  usage: ReadonlyMap<string, WorktreeDiskUsage>
): T[] {
  const bytesOf = (id: string): number | null => {
    const entry = usage.get(id);
    return entry?.status === "measured" ? entry.bytes : null;
  };
  return [...worktrees].sort((a, b) => {
    const aExternal = a.isExternal === true;
    const bExternal = b.isExternal === true;
    if (aExternal !== bExternal) return aExternal ? 1 : -1;
    const sizeA = bytesOf(a.id);
    const sizeB = bytesOf(b.id);
    if (sizeA === null || sizeB === null) {
      if (sizeA === sizeB) return 0;
      return sizeA === null ? 1 : -1;
    }
    return sizeB - sizeA;
  });
}
