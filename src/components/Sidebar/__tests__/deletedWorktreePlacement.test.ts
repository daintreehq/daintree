import { describe, it, expect, vi } from "vitest";

vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => ({ panelIdsByWorktreeId: {}, panelsById: {} }) },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: { applyRendererPolicy: vi.fn(), getInstance: vi.fn() },
}));

import { planDeletedWorktreePlacement } from "../deletedWorktreePlacement";
import type { DeletedWorktree } from "@/store/worktreeStore";

function deleted(id: string, pinnedBeforeWorktreeId: string | null): DeletedWorktree {
  return {
    id,
    title: id,
    path: `/repo/${id}`,
    deletedAt: 1000,
    expiresAt: null,
    holdReason: null,
    pinnedBeforeWorktreeId,
  };
}

describe("planDeletedWorktreePlacement", () => {
  it("leaves a lone deleted row ungrouped at its resolved anchor slot", () => {
    const plan = planDeletedWorktreePlacement([deleted("a", "b")], ["x", "b", "c"]);

    expect(plan.isGrouped).toBe(false);
    expect(plan.groupSlot).toBe(-1);
    expect(plan.byIndex.get(1)).toHaveLength(1);
  });

  it("resolves an anchor that sits at index 0", () => {
    // Slot 0 must be treated as a resolved slot, not a falsy miss.
    const plan = planDeletedWorktreePlacement([deleted("a", "b")], ["b"]);

    expect(plan.byIndex.get(0)?.map((d) => d.id)).toEqual(["a"]);
    expect(plan.trailing).toHaveLength(0);
  });

  it("groups from the second deleted row on", () => {
    const plan = planDeletedWorktreePlacement(
      [deleted("a", "b"), deleted("b", "d")],
      ["x", "b", "y", "d"]
    );

    expect(plan.isGrouped).toBe(true);
  });

  it("puts the group at the earliest slot any member's anchor resolves to", () => {
    const plan = planDeletedWorktreePlacement(
      [deleted("a", "d"), deleted("b", "b"), deleted("c", "e")],
      ["b", "c", "d", "e"]
    );

    // anchors resolve to: d→2, b→0, e→3; earliest is 0.
    expect(plan.groupSlot).toBe(0);
  });

  it("trails the group when no member's anchor is visible", () => {
    const plan = planDeletedWorktreePlacement([deleted("a", null), deleted("b", null)], ["x", "y"]);

    expect(plan.isGrouped).toBe(true);
    expect(plan.groupSlot).toBe(-1);
    expect(plan.trailing).toHaveLength(2);
  });

  it("trails a row whose anchor was filtered out even when the list is non-empty", () => {
    // The anchor is a real id, just not currently in the visible order — so the
    // row cannot claim a slot; it trails rather than reclaiming a coincidental
    // index.
    const plan = planDeletedWorktreePlacement([deleted("a", "gone")], ["x", "y", "z"]);

    expect(plan.byIndex.size).toBe(0);
    expect(plan.trailing.map((d) => d.id)).toEqual(["a"]);
  });

  it("keeps a mixed group at the resolved slot with the unresolved member trailing", () => {
    const plan = planDeletedWorktreePlacement(
      [deleted("a", "gone"), deleted("b", "c")],
      ["x", "c", "y"]
    );

    expect(plan.isGrouped).toBe(true);
    expect(plan.groupSlot).toBe(1);
    expect(plan.trailing.map((d) => d.id)).toEqual(["a"]);
  });

  it("handles an empty list without inventing a group", () => {
    const plan = planDeletedWorktreePlacement([], ["x", "y", "z"]);

    expect(plan.isGrouped).toBe(false);
    expect(plan.groupSlot).toBe(-1);
    expect(plan.trailing).toHaveLength(0);
  });

  it("trails everything when the visible list is empty", () => {
    const plan = planDeletedWorktreePlacement([deleted("a", "b"), deleted("b", "c")], []);

    expect(plan.groupSlot).toBe(-1);
    expect(plan.trailing).toHaveLength(2);
    expect(plan.byIndex.size).toBe(0);
  });

  it("keeps several rows sharing one anchor together in deletion order", () => {
    const plan = planDeletedWorktreePlacement(
      [deleted("a", "c"), deleted("b", "c")],
      ["x", "c", "y"]
    );

    expect(plan.byIndex.get(1)?.map((d) => d.id)).toEqual(["a", "b"]);
  });

  it("re-resolves an anchor once it returns to the visible order", () => {
    const ghosts = [deleted("a", "b")];

    // Filtered out: the anchor "b" is absent, so the row trails.
    expect(planDeletedWorktreePlacement(ghosts, ["x", "y"]).trailing.map((d) => d.id)).toEqual([
      "a",
    ]);

    // Filter cleared: "b" is visible again, so the row reclaims its slot.
    const restored = planDeletedWorktreePlacement(ghosts, ["x", "b", "y"]);
    expect(restored.trailing).toHaveLength(0);
    expect(restored.byIndex.get(1)?.map((d) => d.id)).toEqual(["a"]);
  });

  it("follows its anchor when the live rows are reordered (identity, not fixed slot)", () => {
    const ghosts = [deleted("a", "c")];

    // Anchor "c" at index 1 → ghost sits at slot 1 (before "c").
    expect(planDeletedWorktreePlacement(ghosts, ["b", "c"]).byIndex.get(1)?.map((d) => d.id)).toEqual(
      ["a"]
    );

    // User reorders live rows; the ghost tracks "c" to its new index 0.
    const reordered = planDeletedWorktreePlacement(ghosts, ["c", "b"]);
    expect(reordered.byIndex.get(0)?.map((d) => d.id)).toEqual(["a"]);
    expect(reordered.byIndex.get(1)).toBeUndefined();
  });

  it("keeps a null-anchored ungrouped ghost behind a freshly created worktree (#11400)", () => {
    // A single last-row deletion (no successor) must never jump ahead of a new
    // worktree that later takes index 0.
    const plan = planDeletedWorktreePlacement([deleted("old", null)], ["new"]);

    expect(plan.byIndex.size).toBe(0);
    expect(plan.trailing.map((d) => d.id)).toEqual(["old"]);
  });

  it("keeps a grouped deleted cohort behind a freshly created worktree (#11400)", () => {
    // Bulk-delete all worktrees, then create one: the stale top-of-list pin used
    // to reclaim slot 0 and bump the new worktree to second position. Anchored
    // to now-gone ids, the whole cohort trails instead.
    const ghosts = [deleted("old-a", "old-b"), deleted("old-b", null)];

    // While the list is empty, the cohort trails.
    expect(planDeletedWorktreePlacement(ghosts, []).groupSlot).toBe(-1);

    // After a new, unrelated worktree is created it stays at index 0.
    const afterCreate = planDeletedWorktreePlacement(ghosts, ["new"]);
    expect(afterCreate.groupSlot).toBe(-1);
    expect(afterCreate.byIndex.size).toBe(0);
    expect(afterCreate.trailing.map((d) => d.id)).toEqual(["old-a", "old-b"]);
  });
});
