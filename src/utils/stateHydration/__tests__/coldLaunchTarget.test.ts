import { describe, expect, it } from "vitest";
import { isSameDirectory, resolveColdLaunchTarget } from "../coldLaunchTarget";

const WORKTREES = [
  { id: "/repo", path: "/repo" },
  { id: "/worktrees/task-a", path: "/worktrees/task-a" },
  { id: "/worktrees/task-b", path: "/worktrees/task-b" },
];

describe("resolveColdLaunchTarget (#12434)", () => {
  it("retargets a pane filed under another live worktree than the one it runs in", () => {
    expect(
      resolveColdLaunchTarget({ cwd: "/repo", worktreeId: "/worktrees/task-a" }, WORKTREES)
    ).toEqual({ kind: "moved", cwd: "/worktrees/task-a" });
  });

  it("uses the destination's path, not its id spelling", () => {
    const worktrees = [
      { id: "/repo", path: "/repo" },
      { id: "/private/worktrees/task-a", path: "/worktrees/task-a" },
    ];
    expect(
      resolveColdLaunchTarget({ cwd: "/repo", worktreeId: "/private/worktrees/task-a" }, worktrees)
    ).toEqual({ kind: "moved", cwd: "/worktrees/task-a" });
  });

  it("leaves a pane that already runs in its worktree, subdirectories included", () => {
    expect(
      resolveColdLaunchTarget(
        { cwd: "/worktrees/task-a", worktreeId: "/worktrees/task-a" },
        WORKTREES
      )
    ).toEqual({ kind: "unchanged" });
    expect(
      resolveColdLaunchTarget(
        { cwd: "/worktrees/task-a/packages/ui", worktreeId: "/worktrees/task-a" },
        WORKTREES
      )
    ).toEqual({ kind: "unchanged" });
  });

  it("treats a nested worktree as its own launch root, not its parent's", () => {
    const worktrees = [
      { id: "/repo", path: "/repo" },
      { id: "/repo/.worktrees/task-c", path: "/repo/.worktrees/task-c" },
    ];
    expect(
      resolveColdLaunchTarget({ cwd: "/repo/.worktrees/task-c", worktreeId: "/repo" }, worktrees)
    ).toEqual({ kind: "moved", cwd: "/repo" });
    expect(
      resolveColdLaunchTarget({ cwd: "/repo", worktreeId: "/repo/.worktrees/task-c" }, worktrees)
    ).toEqual({ kind: "moved", cwd: "/repo/.worktrees/task-c" });
  });

  it("never relocates a directory the user chose outside every worktree", () => {
    expect(
      resolveColdLaunchTarget({ cwd: "/scratch/notes", worktreeId: "/worktrees/task-a" }, WORKTREES)
    ).toEqual({ kind: "unchanged" });
  });

  it("asks rather than guesses when the filing names a worktree this project lacks", () => {
    expect(
      resolveColdLaunchTarget({ cwd: "/repo", worktreeId: "/worktrees/deleted" }, WORKTREES)
    ).toEqual({ kind: "destination-unavailable" });
    // Another project's worktree is just as absent from this project's list.
    expect(
      resolveColdLaunchTarget({ cwd: "/repo", worktreeId: "/elsewhere/other-project" }, WORKTREES)
    ).toEqual({ kind: "destination-unavailable" });
  });

  it("recognises the launch root's own worktree under a trailing-slash spelling", () => {
    expect(resolveColdLaunchTarget({ cwd: "/repo", worktreeId: "/repo/" }, WORKTREES)).toEqual({
      kind: "unchanged",
    });
  });

  it("trusts nothing while the worktree list isn't ready (#11234)", () => {
    const saved = { cwd: "/repo", worktreeId: "/worktrees/task-a" };
    expect(resolveColdLaunchTarget(saved, [])).toEqual({ kind: "unchanged" });
    expect(resolveColdLaunchTarget(saved, null)).toEqual({ kind: "unchanged" });
    expect(resolveColdLaunchTarget(saved, undefined)).toEqual({ kind: "unchanged" });
  });

  it("leaves a pane with no filing or no directory alone", () => {
    expect(resolveColdLaunchTarget({ cwd: "/repo" }, WORKTREES)).toEqual({ kind: "unchanged" });
    expect(resolveColdLaunchTarget({ worktreeId: "/worktrees/task-a" }, WORKTREES)).toEqual({
      kind: "unchanged",
    });
  });

  it("compares Windows-style separators like the rest of the worktree path helpers", () => {
    const worktrees = [
      { id: "C:/repo", path: "C:/repo" },
      { id: "C:/worktrees/task-a", path: "C:/worktrees/task-a" },
    ];
    expect(
      resolveColdLaunchTarget(
        { cwd: "C:\\repo\\src", worktreeId: "C:/worktrees/task-a" },
        worktrees
      )
    ).toEqual({ kind: "moved", cwd: "C:/worktrees/task-a" });
  });
});

describe("isSameDirectory", () => {
  it("ignores separator style and trailing slashes", () => {
    expect(isSameDirectory("/repo/", "/repo")).toBe(true);
    expect(isSameDirectory("C:\\repo", "C:/repo")).toBe(true);
    expect(isSameDirectory("/repo", "/worktrees/task-a")).toBe(false);
  });
});
