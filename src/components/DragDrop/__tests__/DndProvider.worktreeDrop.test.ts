import { describe, expect, it } from "vitest";
import { resolveCardDropWorktreeId } from "../DndProvider";
import { getWorktreeSortDragId } from "../SortableWorktreeCard";

// The sidebar card lights up over either of its two stacked droppables, so a
// panel or tab group released over either must move to that worktree (#14962).
describe("resolveCardDropWorktreeId", () => {
  it("reads the card's drop target", () => {
    expect(
      resolveCardDropWorktreeId({ type: "worktree", worktreeId: "wt-b" }, "worktree-drop-wt-b")
    ).toBe("wt-b");
  });

  it("reads the row's sortable, which pointerWithin can resolve instead", () => {
    expect(
      resolveCardDropWorktreeId(
        { sortable: { containerId: "worktree-list", index: 2 } },
        getWorktreeSortDragId("wt-b")
      )
    ).toBe("wt-b");
  });

  it("is null for a panel or container target", () => {
    expect(resolveCardDropWorktreeId({ container: "grid" }, "grid-container")).toBeNull();
    expect(
      resolveCardDropWorktreeId(
        { sortable: { containerId: "grid-container", index: 0 } },
        "panel-1"
      )
    ).toBeNull();
    expect(resolveCardDropWorktreeId({ type: "worktree" }, "worktree-drop-")).toBeNull();
  });
});
