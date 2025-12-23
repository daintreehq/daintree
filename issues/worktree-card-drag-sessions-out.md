# Worktree: Drag Sessions Out of “Active Sessions”

## Problem
The worktree card includes an “Active Sessions” accordion list (`src/components/Worktree/WorktreeCard.tsx`), but sessions can’t be dragged from that list into the grid/dock or into another worktree. Today, DnD works primarily from grid/dock surfaces (`src/components/DragDrop/DndProvider.tsx`).

## Proposal
Make each “Active Sessions” row draggable:
- Drag from the worktree accordion list into:
  - the grid (reorder / move),
  - the dock,
  - another worktree card (move between worktrees).

## UX
- Use the existing terminal drag preview overlay.
- Add a clear affordance (handle icon or “grab” cursor) to avoid accidental drags when clicking to focus.

## Implementation Notes
- Reuse the existing DnD data model:
  - Provide `DragData { terminal, sourceLocation, sourceIndex }` on the draggable item.
  - Set `sourceLocation` based on the terminal’s current `location` (grid/dock).
  - Compute `sourceIndex` from the filtered list used for ordering in that surface.
- Ensure worktree drop targets keep working (existing `overData.type === "worktree"` path in `src/components/DragDrop/DndProvider.tsx`).

## Acceptance Criteria
- Dragging a session row into another worktree card moves the session to that worktree.
- Dragging a session row into the grid/dock behaves the same as dragging from the grid/dock.

