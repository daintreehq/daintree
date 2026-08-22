import { describe, expect, it } from "vitest";
import { classifyLaunchRootAlignment, resolveLaunchCwd } from "../worktreeAlignment";

const WORKTREES = [
  { id: "wt-main", path: "/repo" },
  { id: "wt-feature", path: "/repo/.worktrees/feature" },
  { id: "wt-nested", path: "/repo/.worktrees/feature/nested" },
];

describe("classifyLaunchRootAlignment", () => {
  it("matches a launch from a subdirectory to its worktree", () => {
    expect(classifyLaunchRootAlignment("/repo/src/components", WORKTREES, "wt-main")).toBe(
      "aligned"
    );
  });

  it("does not let a sibling directory sharing a name prefix count as a match", () => {
    // "/repo-backup" starts with "/repo" as a string but is a different tree.
    expect(classifyLaunchRootAlignment("/repo-backup/src", WORKTREES, "wt-main")).toBe("unknown");
  });

  it("ignores a trailing slash on the launch cwd", () => {
    expect(classifyLaunchRootAlignment("/repo/.worktrees/feature/", WORKTREES, "wt-feature")).toBe(
      "aligned"
    );
  });

  it("matches across mixed Windows and POSIX separators", () => {
    const windowsWorktrees = [{ id: "wt-win", path: "C:\\repo\\.worktrees\\feature" }];
    expect(
      classifyLaunchRootAlignment("C:/repo/.worktrees/feature/src", windowsWorktrees, "wt-win")
    ).toBe("aligned");
  });

  it("picks the deepest worktree when paths nest", () => {
    // The nested worktree's path is also a child of the feature worktree's, so a
    // first-match rule would file it under the wrong parent.
    expect(
      classifyLaunchRootAlignment("/repo/.worktrees/feature/nested/pkg", WORKTREES, "wt-nested")
    ).toBe("aligned");
    expect(
      classifyLaunchRootAlignment("/repo/.worktrees/feature/nested/pkg", WORKTREES, "wt-feature")
    ).toBe("launch-root-mismatch");
  });

  it("reports a mismatch when the launch root is a different worktree", () => {
    expect(classifyLaunchRootAlignment("/repo/src", WORKTREES, "wt-feature")).toBe(
      "launch-root-mismatch"
    );
  });

  it("treats an empty cwd as unknown rather than aligned", () => {
    expect(classifyLaunchRootAlignment("", WORKTREES, "wt-main")).toBe("unknown");
    expect(classifyLaunchRootAlignment(undefined, WORKTREES, "wt-main")).toBe("unknown");
  });

  it("treats a panel with no worktree as unknown", () => {
    expect(classifyLaunchRootAlignment("/repo/src", WORKTREES, undefined)).toBe("unknown");
  });

  it("treats a cwd outside every worktree as unknown, not a mismatch", () => {
    // Unprovable, so it must not be reported as a confident "moved".
    expect(classifyLaunchRootAlignment("/tmp/scratch", WORKTREES, "wt-main")).toBe("unknown");
  });

  it("is unknown when there are no worktrees to compare against", () => {
    expect(classifyLaunchRootAlignment("/repo/src", [], "wt-main")).toBe("unknown");
    expect(classifyLaunchRootAlignment("/repo/src", undefined, "wt-main")).toBe("unknown");
  });
});

describe("resolveLaunchCwd", () => {
  it("prefers the backend value when both agree", () => {
    expect(resolveLaunchCwd("/repo", "/repo")).toBe("/repo");
  });

  it("treats separator-only and trailing-slash differences as agreement", () => {
    expect(resolveLaunchCwd("C:\\repo\\", "C:/repo")).toBe("C:/repo");
  });

  it("refuses to pick a winner when the two disagree", () => {
    // Undefined classifies as `unknown`, which asks the user.
    expect(resolveLaunchCwd("/repo", "/repo/.worktrees/feature")).toBeUndefined();
  });

  it("falls back to the panel value when the backend has nothing", () => {
    expect(resolveLaunchCwd("/repo", undefined)).toBe("/repo");
    expect(resolveLaunchCwd("/repo", "   ")).toBe("/repo");
  });

  it("uses the backend value when the panel has nothing", () => {
    expect(resolveLaunchCwd("", "/repo")).toBe("/repo");
  });

  it("is undefined when neither side knows", () => {
    expect(resolveLaunchCwd(undefined, undefined)).toBeUndefined();
  });
});
