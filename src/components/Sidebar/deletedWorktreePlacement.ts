import { DELETED_WORKTREE_GROUP_THRESHOLD, type DeletedWorktree } from "@/store/worktreeStore";

export interface DeletedWorktreePlacement {
  /** Deleted rows collapse behind one summary item instead of rendering a card each. */
  isGrouped: boolean;
  /**
   * Slot in the filtered worktree list the group is inserted before, or `-1`
   * when no member held a visible slot and the group trails the list.
   */
  groupSlot: number;
  /** Deleted rows keyed by the visible slot they held, for the ungrouped path. */
  byIndex: Map<number, DeletedWorktree[]>;
  /** Deleted rows with no visible slot, appended after the live rows. */
  trailing: DeletedWorktree[];
}

/**
 * Where a sidebar's deleted rows go (#11232, #11260).
 *
 * A deleted worktree holds the slot its row occupied so the terminals the user
 * is looking for stay put, but that slot is only meaningful while it still
 * addresses the current filtered list — a pin recorded before a filter narrowed
 * the list can point past the end. Both the grouped and ungrouped paths drop
 * such a pin and fall back to trailing placement; keeping them in agreement is
 * the whole reason this is one function rather than two call sites.
 */
export function planDeletedWorktreePlacement(
  deletedList: readonly DeletedWorktree[],
  visibleWorktreeCount: number
): DeletedWorktreePlacement {
  const byIndex = new Map<number, DeletedWorktree[]>();
  const trailing: DeletedWorktree[] = [];
  for (const deleted of deletedList) {
    if (deleted.pinnedIndex >= 0 && deleted.pinnedIndex < visibleWorktreeCount) {
      const bucket = byIndex.get(deleted.pinnedIndex);
      if (bucket) bucket.push(deleted);
      else byIndex.set(deleted.pinnedIndex, [deleted]);
    } else {
      trailing.push(deleted);
    }
  }

  const isGrouped = deletedList.length >= DELETED_WORKTREE_GROUP_THRESHOLD;
  // Derived from `byIndex` rather than raw `pinnedIndex`, so an out-of-range
  // pin can never claim a slot the render loop won't reach — that would drop
  // every deleted row out of the sidebar instead of merely misplacing it.
  let groupSlot = -1;
  if (isGrouped) {
    for (const slot of byIndex.keys()) {
      if (groupSlot === -1 || slot < groupSlot) groupSlot = slot;
    }
  }

  return { isGrouped, groupSlot, byIndex, trailing };
}
