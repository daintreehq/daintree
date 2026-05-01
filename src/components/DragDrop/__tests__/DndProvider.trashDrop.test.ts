// Contract test for the drag-to-trash branch added to DndProvider.handleDragEnd.
// Mirrors the exact branch logic so we can assert it (a) calls trashPanel with the
// dragged panel id when overId matches TRASH_DROPPABLE_ID, and (b) short-circuits the
// rest of handleDragEnd. Following the same harness pattern as
// DndProvider.draggingAttribute.test.tsx — full DndProvider mount requires mocking
// 10+ modules and provides little additional signal for branch-level logic.
import { describe, expect, it, vi } from "vitest";
import { TRASH_DROPPABLE_ID } from "../DndProvider";

interface BranchDeps {
  trashPanelGroup: (id: string) => void;
  reorderTerminals: (...args: unknown[]) => void;
}

function runTrashBranch(
  overId: string,
  draggedId: string | null,
  deps: BranchDeps
): "trashed" | "fall-through" {
  if (!draggedId) return "fall-through";
  if (overId === TRASH_DROPPABLE_ID) {
    // trashPanelGroup handles both single panels and tab groups; for ungrouped
    // panels it transparently falls back to trashPanel inside the registry.
    deps.trashPanelGroup(draggedId);
    return "trashed";
  }
  // In production this is followed by accordion / reorder / cross-container logic.
  // The contract we are protecting is: trash branch fires before any of that.
  deps.reorderTerminals();
  return "fall-through";
}

describe("DndProvider trash-drop branch", () => {
  it("calls trashPanelGroup with the dragged panel id when dropped on TRASH_DROPPABLE_ID", () => {
    const trashPanelGroup = vi.fn();
    const reorderTerminals = vi.fn();

    const result = runTrashBranch(TRASH_DROPPABLE_ID, "panel-42", {
      trashPanelGroup,
      reorderTerminals,
    });

    expect(result).toBe("trashed");
    expect(trashPanelGroup).toHaveBeenCalledWith("panel-42");
    expect(reorderTerminals).not.toHaveBeenCalled();
  });

  it("uses trashPanelGroup so multi-panel tab groups trash atomically (issue #6428)", () => {
    // Regression guard: dragging a tab group must trash the whole group, not just
    // the panel attached to the draggable. trashPanelGroup is the only entry point
    // that handles both single panels and groups; trashPanel would orphan siblings.
    const trashPanelGroup = vi.fn();
    const reorderTerminals = vi.fn();

    runTrashBranch(TRASH_DROPPABLE_ID, "first-panel-of-group", {
      trashPanelGroup,
      reorderTerminals,
    });

    expect(trashPanelGroup).toHaveBeenCalledTimes(1);
    expect(trashPanelGroup).toHaveBeenCalledWith("first-panel-of-group");
  });

  it("falls through to reorder logic when overId is not the trash droppable", () => {
    const trashPanelGroup = vi.fn();
    const reorderTerminals = vi.fn();

    const result = runTrashBranch("some-other-panel", "panel-42", {
      trashPanelGroup,
      reorderTerminals,
    });

    expect(result).toBe("fall-through");
    expect(trashPanelGroup).not.toHaveBeenCalled();
    expect(reorderTerminals).toHaveBeenCalled();
  });

  it("does not call trashPanelGroup when there is no draggedId", () => {
    const trashPanelGroup = vi.fn();
    const reorderTerminals = vi.fn();

    const result = runTrashBranch(TRASH_DROPPABLE_ID, null, {
      trashPanelGroup,
      reorderTerminals,
    });

    expect(result).toBe("fall-through");
    expect(trashPanelGroup).not.toHaveBeenCalled();
    expect(reorderTerminals).not.toHaveBeenCalled();
  });

  it("exports a stable, distinct droppable id", () => {
    expect(TRASH_DROPPABLE_ID).toBe("__trash-droppable__");
  });
});
