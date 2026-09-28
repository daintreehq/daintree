import { describe, expect, it } from "vitest";
import { findWorktreeForBranch } from "../worktreeUtils.js";

const PORCELAIN = [
  "worktree /repo",
  "HEAD 1111111111111111111111111111111111111111",
  "branch refs/heads/main",
  "",
  "worktree /repo-worktrees/feature-host-chip",
  "HEAD 2222222222222222222222222222222222222222",
  "branch refs/heads/feature/host-chip",
  "",
  "worktree /repo-worktrees/detached",
  "HEAD 3333333333333333333333333333333333333333",
  "detached",
  "",
  "worktree /gone",
  "HEAD 4444444444444444444444444444444444444444",
  "branch refs/heads/stale",
  "prunable gitdir file points to non-existent location",
  "",
].join("\n");

describe("findWorktreeForBranch", () => {
  it("finds the working tree that has the branch checked out", () => {
    expect(findWorktreeForBranch(PORCELAIN, "feature/host-chip")).toBe(
      "/repo-worktrees/feature-host-chip"
    );
    expect(findWorktreeForBranch(PORCELAIN, "refs/heads/main")).toBe("/repo");
  });

  it("finds nothing for a branch no working tree has, and skips prunable records", () => {
    expect(findWorktreeForBranch(PORCELAIN, "feature/host")).toBeNull();
    expect(findWorktreeForBranch(PORCELAIN, "stale")).toBeNull();
    expect(findWorktreeForBranch("", "main")).toBeNull();
  });

  it("never treats a bare record as a working tree", () => {
    expect(
      findWorktreeForBranch("worktree /bare.git\nbare\nbranch refs/heads/main\n", "main")
    ).toBeNull();
  });
});
