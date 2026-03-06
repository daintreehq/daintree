import { describe, expect, it } from "vitest";
import type { WorktreeState } from "@shared/types";
import { sortWorktreesForComparison } from "../crossWorktreeDiffUtils";

function createWorktree(
  id: string,
  name: string,
  overrides: Partial<WorktreeState> = {}
): WorktreeState {
  return {
    id,
    worktreeId: id,
    name,
    path: `/tmp/${name}`,
    branch: name,
    isCurrent: false,
    isMainWorktree: false,
    worktreeChanges: null,
    lastActivityTimestamp: null,
    ...overrides,
  };
}

describe("sortWorktreesForComparison", () => {
  it("keeps the main worktree first and sorts the rest by name", () => {
    const worktrees = [
      createWorktree("b", "beta"),
      createWorktree("main", "main", { isMainWorktree: true }),
      createWorktree("a", "alpha"),
    ];

    expect(sortWorktreesForComparison(worktrees).map((worktree) => worktree.id)).toEqual([
      "main",
      "a",
      "b",
    ]);
  });
});
