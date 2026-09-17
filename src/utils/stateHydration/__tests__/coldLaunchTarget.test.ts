import { describe, expect, it } from "vitest";
import {
  findLaunchRoot,
  isFilingUnavailable,
  isSameDirectory,
  resolveColdLaunchTarget,
} from "../coldLaunchTarget";

const WORKTREES = [
  { id: "/repo", path: "/repo" },
  { id: "/worktrees/task-a", path: "/worktrees/task-a" },
  { id: "/worktrees/task-b", path: "/worktrees/task-b" },
];

describe("resolveColdLaunchTarget (#12434)", () => {
  it("retargets a pane filed under another live worktree than the one it runs in", () => {
    expect(
      resolveColdLaunchTarget({ cwd: "/repo", worktreeId: "/worktrees/task-a" }, WORKTREES)
    ).toEqual({ kind: "moved", cwd: "/worktrees/task-a", worktreeId: "/worktrees/task-a" });
  });

  it("runs in the destination's path and files under the list's own id spelling", () => {
    const worktrees = [
      { id: "/repo", path: "/repo" },
      { id: "/private/worktrees/task-a", path: "/worktrees/task-a" },
    ];
    expect(
      resolveColdLaunchTarget({ cwd: "/repo", worktreeId: "/worktrees/task-a/" }, worktrees)
    ).toEqual({ kind: "moved", cwd: "/worktrees/task-a", worktreeId: "/private/worktrees/task-a" });
  });

  it("leaves a pane that already runs in its worktree, subdirectories included", () => {
    expect(
      resolveColdLaunchTarget(
        { cwd: "/worktrees/task-a", worktreeId: "/worktrees/task-a" },
        WORKTREES
      )
    ).toEqual({ kind: "unchanged", worktreeId: "/worktrees/task-a" });
    expect(
      resolveColdLaunchTarget(
        { cwd: "/worktrees/task-a/packages/ui", worktreeId: "/worktrees/task-a" },
        WORKTREES
      )
    ).toEqual({ kind: "unchanged", worktreeId: "/worktrees/task-a" });
  });

  it("treats a nested worktree as its own launch root, not its parent's", () => {
    const worktrees = [
      { id: "/repo", path: "/repo" },
      { id: "/repo/.worktrees/task-c", path: "/repo/.worktrees/task-c" },
    ];
    expect(
      resolveColdLaunchTarget({ cwd: "/repo/.worktrees/task-c", worktreeId: "/repo" }, worktrees)
    ).toEqual({ kind: "moved", cwd: "/repo", worktreeId: "/repo" });
    expect(
      resolveColdLaunchTarget({ cwd: "/repo", worktreeId: "/repo/.worktrees/task-c" }, worktrees)
    ).toEqual({
      kind: "moved",
      cwd: "/repo/.worktrees/task-c",
      worktreeId: "/repo/.worktrees/task-c",
    });
  });

  it("never relocates a directory the user chose outside every worktree", () => {
    expect(
      resolveColdLaunchTarget({ cwd: "/scratch/notes", worktreeId: "/worktrees/task-a" }, WORKTREES)
    ).toEqual({ kind: "unchanged", worktreeId: "/worktrees/task-a" });
    // Nothing shows a move, so a missing filing is left to the existing re-home.
    expect(
      resolveColdLaunchTarget({ cwd: "/scratch/notes", worktreeId: "/worktrees/gone" }, WORKTREES)
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

  it("asks when a pane already relaunched elsewhere has lost that destination too", () => {
    expect(
      resolveColdLaunchTarget(
        { cwd: "/worktrees/gone", worktreeId: "/worktrees/gone", conversationCwd: "/repo" },
        WORKTREES
      )
    ).toEqual({ kind: "destination-unavailable" });
  });

  it("recognises the launch root's own worktree under another spelling", () => {
    expect(resolveColdLaunchTarget({ cwd: "/repo", worktreeId: "/repo/" }, WORKTREES)).toEqual({
      kind: "unchanged",
      worktreeId: "/repo",
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

  it("compares Windows paths regardless of separators and letter case", () => {
    const worktrees = [
      { id: "C:/repo", path: "C:/repo" },
      { id: "C:/repo/WT", path: "C:/repo/WT" },
      { id: "C:/worktrees/task-a", path: "C:/worktrees/task-a" },
    ];
    expect(
      resolveColdLaunchTarget(
        { cwd: "C:\\repo\\src", worktreeId: "C:/worktrees/task-a" },
        worktrees
      )
    ).toEqual({ kind: "moved", cwd: "C:/worktrees/task-a", worktreeId: "C:/worktrees/task-a" });
    // Only the casing differs: the pane already runs in its worktree.
    expect(
      resolveColdLaunchTarget({ cwd: "c:/repo/wt/src", worktreeId: "C:/repo/WT" }, worktrees)
    ).toEqual({ kind: "unchanged", worktreeId: "C:/repo/WT" });
  });

  it("keeps POSIX paths case-sensitive, even ones that start with two slashes", () => {
    const worktrees = [
      { id: "/repo", path: "/repo" },
      { id: "/repo/WT", path: "/repo/WT" },
    ];
    expect(findLaunchRoot("/repo/wt/src", worktrees)).toBe("/repo");
    expect(isSameDirectory("//repo/Task", "//repo/task")).toBe(false);
  });

  it("folds a backslash UNC path like Windows does", () => {
    expect(isSameDirectory("\\\\Server\\Share\\repo", "\\\\server\\share\\REPO\\")).toBe(true);
  });
});

describe("isFilingUnavailable", () => {
  it("is true only against an authoritative list that lacks the filing", () => {
    expect(isFilingUnavailable("/worktrees/gone", WORKTREES)).toBe(true);
    expect(isFilingUnavailable("/worktrees/task-a/", WORKTREES)).toBe(false);
    expect(isFilingUnavailable("/worktrees/gone", [])).toBe(false);
    expect(isFilingUnavailable("/worktrees/gone", null)).toBe(false);
    expect(isFilingUnavailable(undefined, WORKTREES)).toBe(false);
  });
});

describe("isSameDirectory", () => {
  it("ignores separator style, trailing slashes and Windows letter case", () => {
    expect(isSameDirectory("/repo/", "/repo")).toBe(true);
    expect(isSameDirectory("C:\\Repo", "c:/repo")).toBe(true);
    expect(isSameDirectory("/Repo", "/repo")).toBe(false);
    expect(isSameDirectory("/repo", "/worktrees/task-a")).toBe(false);
  });
});
