import { describe, it, expect, vi } from "vitest";

vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => ({ panelIdsByWorktreeId: {}, panelsById: {} }) },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: { applyRendererPolicy: vi.fn(), getInstance: vi.fn() },
}));

import { planDeletedWorktreePlacement } from "../deletedWorktreePlacement";
import type { DeletedWorktree } from "@/store/worktreeStore";

function deleted(id: string, pinnedIndex: number): DeletedWorktree {
  return {
    id,
    title: id,
    path: `/repo/${id}`,
    deletedAt: 1000,
    expiresAt: null,
    holdReason: null,
    pinnedIndex,
  };
}

describe("planDeletedWorktreePlacement", () => {
  it("leaves a lone deleted row ungrouped", () => {
    const plan = planDeletedWorktreePlacement([deleted("a", 1)], 5);

    expect(plan.isGrouped).toBe(false);
    expect(plan.groupSlot).toBe(-1);
    expect(plan.byIndex.get(1)).toHaveLength(1);
  });

  it("groups from the second deleted row on", () => {
    const plan = planDeletedWorktreePlacement([deleted("a", 1), deleted("b", 3)], 5);

    expect(plan.isGrouped).toBe(true);
  });

  it("puts the group at the earliest slot any member held", () => {
    const plan = planDeletedWorktreePlacement(
      [deleted("a", 3), deleted("b", 1), deleted("c", 4)],
      5
    );

    expect(plan.groupSlot).toBe(1);
  });

  it("trails the group when no member held a visible slot", () => {
    const plan = planDeletedWorktreePlacement([deleted("a", -1), deleted("b", -1)], 5);

    expect(plan.isGrouped).toBe(true);
    expect(plan.groupSlot).toBe(-1);
    expect(plan.trailing).toHaveLength(2);
  });

  it("never claims a slot past the end of the filtered list", () => {
    // A pin recorded before a filter narrowed the list points past the end.
    // Claiming it would strand the group at an index the render loop never
    // reaches, dropping every deleted row — and its rescuable terminals —
    // out of the sidebar entirely.
    const plan = planDeletedWorktreePlacement([deleted("a", 9), deleted("b", 7)], 3);

    expect(plan.groupSlot).toBe(-1);
    expect(plan.trailing).toHaveLength(2);
    expect(plan.byIndex.size).toBe(0);
  });

  it("still uses an in-range slot when only some pins went out of range", () => {
    const plan = planDeletedWorktreePlacement([deleted("a", 9), deleted("b", 2)], 3);

    expect(plan.groupSlot).toBe(2);
    expect(plan.trailing.map((d) => d.id)).toEqual(["a"]);
  });

  it("handles an empty list without inventing a group", () => {
    const plan = planDeletedWorktreePlacement([], 3);

    expect(plan.isGrouped).toBe(false);
    expect(plan.groupSlot).toBe(-1);
    expect(plan.trailing).toHaveLength(0);
  });

  it("trails everything when the filtered list is empty", () => {
    const plan = planDeletedWorktreePlacement([deleted("a", 0), deleted("b", 1)], 0);

    expect(plan.groupSlot).toBe(-1);
    expect(plan.trailing).toHaveLength(2);
  });

  it("keeps several rows sharing one slot together in deletion order", () => {
    const plan = planDeletedWorktreePlacement([deleted("a", 2), deleted("b", 2)], 5);

    expect(plan.byIndex.get(2)?.map((d) => d.id)).toEqual(["a", "b"]);
  });
});
