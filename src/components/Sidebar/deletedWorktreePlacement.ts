import { DELETED_WORKTREE_GROUP_THRESHOLD, type DeletedWorktree } from "@/store/worktreeStore";

export interface DeletedWorktreePlacement {
  /** Deleted rows collapse behind one summary item instead of rendering a card each. */
  isGrouped: boolean;
  /**
   * Slot the collapsed deleted-worktree group is inserted before, or `-1` when
   * the group trails — either because no member's anchor still resolves, or
   * because the cohort is too small to group (`isGrouped` is false).
   */
  groupSlot: number;
  /**
   * Deleted rows keyed by the current index of their resolved successor anchor,
   * for the ungrouped path. The render loop inserts them before the live row at
   * that index.
   */
  byIndex: Map<number, DeletedWorktree[]>;
  /**
   * Deleted rows whose anchor is gone (or was never visible), for the ungrouped
   * path — appended after the live rows. A collapsed group renders as one item
   * from the full list at `groupSlot`, so it never consults this bucket.
   */
  trailing: DeletedWorktree[];
}

/**
 * Where a sidebar's deleted rows go (#11232, #11260).
 *
 * A deleted row records the live worktree that immediately followed it in the
 * last published sidebar order (`pinnedBeforeWorktreeId`). While that anchor is
 * still visible the row renders immediately before its current position, so the
 * terminals the user is looking for stay put; otherwise the row trails. Keying
 * off an identity rather than a raw index is what stops an unrelated worktree
 * added later from reclaiming a stale numeric slot once the list empties and
 * regrows past it (#11400).
 *
 * Placement is identity-relative, not an absolute visual slot: if the user
 * reorders the live rows, the row follows its former successor rather than
 * pinning to a fixed position. Both the grouped and ungrouped paths resolve the
 * anchor the same way and fall back to trailing together; keeping them in
 * agreement is the whole reason this is one function rather than two call sites.
 *
 * The anchor is a single successor, so if that exact neighbour is itself
 * deleted in the same burst the row trails; whether an adjacent removal trails
 * or resolves to the next survivor depends on when the visible order was last
 * republished, and either outcome is acceptable for a ghost.
 */
export function planDeletedWorktreePlacement(
  deletedList: readonly DeletedWorktree[],
  visibleWorktreeIds: readonly string[]
): DeletedWorktreePlacement {
  const indexById = new Map<string, number>();
  for (let i = 0; i < visibleWorktreeIds.length; i++) {
    // First occurrence wins; ids are unique in practice, so this just guards
    // against a duplicate leaking in without letting it shift the anchor.
    if (!indexById.has(visibleWorktreeIds[i]!)) indexById.set(visibleWorktreeIds[i]!, i);
  }

  const byIndex = new Map<number, DeletedWorktree[]>();
  const trailing: DeletedWorktree[] = [];
  for (const deleted of deletedList) {
    const slot =
      deleted.pinnedBeforeWorktreeId == null
        ? undefined
        : indexById.get(deleted.pinnedBeforeWorktreeId);
    if (slot === undefined) {
      trailing.push(deleted);
    } else {
      const bucket = byIndex.get(slot);
      if (bucket) bucket.push(deleted);
      else byIndex.set(slot, [deleted]);
    }
  }

  const isGrouped = deletedList.length >= DELETED_WORKTREE_GROUP_THRESHOLD;
  // Derived from `byIndex` rather than any raw pin, so an unresolved anchor can
  // never claim a slot the render loop won't reach — that would drop every
  // deleted row out of the sidebar instead of merely misplacing it.
  let groupSlot = -1;
  if (isGrouped) {
    for (const slot of byIndex.keys()) {
      if (groupSlot === -1 || slot < groupSlot) groupSlot = slot;
    }
  }

  return { isGrouped, groupSlot, byIndex, trailing };
}
