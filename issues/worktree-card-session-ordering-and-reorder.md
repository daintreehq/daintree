# Worktree: Session Summary Ordering + Reorder

## Problem
The worktree “Active Sessions” list is currently **computed-sorted** (agent first, then state priority, then title) in `src/components/Worktree/WorktreeCard.tsx`. This can diverge from the user’s layout ordering in the grid/dock, and it’s not directly reorderable.

## Proposal
1. Default the accordion list ordering to match the persisted session ordering for that worktree+location (same ordering used by the grid/dock).
2. Allow reordering directly in the accordion (drag within the list):
   - Updates the underlying ordering so the grid/dock reflects it.
3. Optional: add a toggle “Sort by status” for the computed ordering as an alternate view.

## Implementation Notes
- The store already supports reordering (`reorderTerminals`, `moveTerminalToPosition` in `src/store/slices/terminalRegistrySlice.ts`).
- The DnD stack is already in place; add a sortable context for the accordion list using the same IDs.
- Be careful with worktree scoping: reorder only within the current worktree, and within the current container (grid vs dock) unless explicitly moving.

## Acceptance Criteria
- Reordering items in the worktree accordion updates the grid layout ordering for that worktree.
- The default list ordering matches the grid/dock ordering (no surprising resorting).

