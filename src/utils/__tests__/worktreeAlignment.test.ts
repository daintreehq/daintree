import { describe, expect, it } from "vitest";
import {
  classifyLaunchRootAlignment,
  deriveWorktreeDivergence,
  resolveLaunchCwd,
} from "../worktreeAlignment";

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

describe("deriveWorktreeDivergence", () => {
  const divergedWorktrees = [
    { id: "wt-main", path: "/repo", name: "main", headOid: "aaa" },
    { id: "wt-feature", path: "/repo/.worktrees/feature", name: "feature" },
  ];

  const optOut = {
    acknowledgedCwd: "/repo",
    acknowledgedWorktreeId: "wt-feature",
    launchWorktreeId: "wt-main",
    sourceHeadOid: "aaa",
    at: 1,
  };

  it("reports divergence for a consented panel still filed away from its launch root", () => {
    const result = deriveWorktreeDivergence(
      { cwd: "/repo", worktreeId: "wt-feature", worktreeMoveOptOut: optOut },
      divergedWorktrees
    );
    expect(result).toEqual({ kind: "diverged", launchLabel: "main", headDrifted: false });
  });

  it("reports nothing without recorded consent", () => {
    expect(
      deriveWorktreeDivergence({ cwd: "/repo", worktreeId: "wt-feature" }, divergedWorktrees).kind
    ).toBe("none");
  });

  it("drops consent once the panel relaunches somewhere else", () => {
    // A restart that re-anchors the launch root ends the divergence the consent
    // was given for, so the marker must not outlive it.
    expect(
      deriveWorktreeDivergence(
        {
          cwd: "/repo/.worktrees/feature",
          worktreeId: "wt-feature",
          worktreeMoveOptOut: optOut,
        },
        divergedWorktrees
      ).kind
    ).toBe("none");
  });

  it("drops consent when the panel is filed somewhere it was not consented for", () => {
    expect(
      deriveWorktreeDivergence(
        { cwd: "/repo", worktreeId: "wt-main", worktreeMoveOptOut: optOut },
        divergedWorktrees
      ).kind
    ).toBe("none");
  });

  it("flags drift once the launch root's HEAD moves past the recorded baseline", () => {
    const result = deriveWorktreeDivergence(
      { cwd: "/repo", worktreeId: "wt-feature", worktreeMoveOptOut: optOut },
      [{ ...divergedWorktrees[0]!, headOid: "bbb" }, divergedWorktrees[1]!]
    );
    expect(result.kind === "diverged" && result.headDrifted).toBe(true);
  });

  it("does not claim drift when either side of the comparison is unknown", () => {
    const noCurrentHead = deriveWorktreeDivergence(
      { cwd: "/repo", worktreeId: "wt-feature", worktreeMoveOptOut: optOut },
      [{ id: "wt-main", path: "/repo", name: "main" }, divergedWorktrees[1]!]
    );
    expect(noCurrentHead.kind === "diverged" && noCurrentHead.headDrifted).toBe(false);

    const noBaseline = deriveWorktreeDivergence(
      {
        cwd: "/repo",
        worktreeId: "wt-feature",
        worktreeMoveOptOut: { ...optOut, sourceHeadOid: undefined },
      },
      [{ ...divergedWorktrees[0]!, headOid: "bbb" }, divergedWorktrees[1]!]
    );
    expect(noBaseline.kind === "diverged" && noBaseline.headDrifted).toBe(false);
  });

  it("falls back to the launch cwd when the launch root maps to no worktree", () => {
    const result = deriveWorktreeDivergence(
      {
        cwd: "/tmp/scratch",
        worktreeId: "wt-feature",
        worktreeMoveOptOut: {
          ...optOut,
          acknowledgedCwd: "/tmp/scratch",
          launchWorktreeId: undefined,
          sourceHeadOid: undefined,
        },
      },
      divergedWorktrees
    );
    // "/tmp/scratch" is under no worktree, so alignment is `unknown`, not a
    // mismatch — nothing to mark.
    expect(result.kind).toBe("none");
  });
});
