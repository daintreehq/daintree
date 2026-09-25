import { describe, it, expect } from "vitest";
import {
  findNestedWorktreePaths,
  NESTED_WORKTREE_DELETE_MARKER,
  nestedWorktreeDeleteMessage,
} from "../nestedWorktrees.js";

describe("findNestedWorktreePaths", () => {
  it("returns only paths strictly inside the target, sorted", () => {
    expect(
      findNestedWorktreePaths(
        "/repo/wt",
        ["/repo/wt/b", "/repo/wt", "/repo/wt-other", "/repo/wt/a/deep", "/repo"],
        { caseInsensitive: false }
      )
    ).toEqual(["/repo/wt/a/deep", "/repo/wt/b"]);
  });

  it("keeps every spelling that folds together, for the caller to probe", () => {
    expect(
      findNestedWorktreePaths(
        "C:\\repo\\wt",
        ["C:\\repo\\wt\\child", "c:/REPO/wt/child", "C:\\repo\\wt\\child"],
        { caseInsensitive: true }
      )
    ).toEqual(["C:\\repo\\wt\\child", "c:/REPO/wt/child"]);
  });
});

describe("nestedWorktreeDeleteMessage", () => {
  it("names every nested path and carries the stable marker", () => {
    const one = nestedWorktreeDeleteMessage(["/repo/wt/child"]);
    expect(one).toContain(NESTED_WORKTREE_DELETE_MARKER);
    expect(one).toContain("/repo/wt/child");

    const two = nestedWorktreeDeleteMessage(["/repo/wt/a", "/repo/wt/b"]);
    expect(two).toContain(NESTED_WORKTREE_DELETE_MARKER);
    expect(two).toContain("2 registered worktrees: /repo/wt/a, /repo/wt/b");
  });
});
