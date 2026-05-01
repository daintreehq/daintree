import { arrayMove } from "@dnd-kit/sortable";

/**
 * Reorder a worktree within the visible (filtered) subset, then merge that
 * reordering back into the persisted full-order array so positions of
 * worktrees hidden by filters are preserved.
 *
 * Used by both the drag-end handler in DndProvider and the keyboard-accessible
 * "Move up" / "Move down" menu items, so behaviour stays in lockstep.
 *
 * Out-of-range indices, single-element subsets, and no-op moves return
 * `fullOrder` unchanged. Visible IDs missing from `fullOrder` are appended
 * after the merge so a first-ever drag still produces a complete order.
 */
export function applyManualWorktreeReorder(
  fullOrder: readonly string[],
  visibleIds: readonly string[],
  fromIndex: number,
  toIndex: number
): string[] {
  if (visibleIds.length < 2) return fullOrder.slice();
  if (fromIndex === toIndex) return fullOrder.slice();
  if (fromIndex < 0 || fromIndex >= visibleIds.length) return fullOrder.slice();
  if (toIndex < 0 || toIndex >= visibleIds.length) return fullOrder.slice();

  const reorderedSubset = arrayMove(visibleIds.slice(), fromIndex, toIndex);
  const subsetSet = new Set(reorderedSubset);
  const merged: string[] = [];
  let subsetIdx = 0;

  for (const id of fullOrder) {
    if (subsetSet.has(id)) {
      merged.push(reorderedSubset[subsetIdx++]!);
    } else {
      merged.push(id);
    }
  }
  while (subsetIdx < reorderedSubset.length) {
    merged.push(reorderedSubset[subsetIdx++]!);
  }
  return merged;
}
