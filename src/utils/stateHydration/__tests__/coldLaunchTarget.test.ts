import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findLaunchRoot,
  isFilingUnavailable,
  isSameDirectory,
  rereadWorktreeList,
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

  it("won't start a pane outside its filing while the list isn't ready (#18009)", () => {
    // Only the list can tell a move from a directory the user chose, so this is
    // neither relocated nor started where it was saved.
    const saved = { cwd: "/repo", worktreeId: "/worktrees/task-a" };
    for (const unknown of [[], null, undefined]) {
      expect(resolveColdLaunchTarget(saved, unknown)).toEqual({
        kind: "unconfirmed",
        holdIfUnknown: true,
      });
    }
    // A sibling sharing the name's prefix is another directory.
    expect(
      resolveColdLaunchTarget({ cwd: "/worktrees/task-ab", worktreeId: "/worktrees/task-a" }, null)
    ).toEqual({ kind: "unconfirmed", holdIfUnknown: true });
  });

  it("looks again for a subdirectory of the filing, but never holds it for want of a list", () => {
    // It may be a nested worktree the pane was moved out of, which only the list shows.
    for (const unknown of [[], null, undefined]) {
      expect(
        resolveColdLaunchTarget({ cwd: "/repo/.worktrees/task-c", worktreeId: "/repo" }, unknown)
      ).toEqual({ kind: "unconfirmed", holdIfUnknown: false });
    }
    // With the list, the nested worktree is the launch root and the move shows.
    expect(
      resolveColdLaunchTarget({ cwd: "/repo/.worktrees/task-c", worktreeId: "/repo" }, [
        { id: "/repo", path: "/repo" },
        { id: "/repo/.worktrees/task-c", path: "/repo/.worktrees/task-c" },
      ])
    ).toEqual({ kind: "moved", cwd: "/repo", worktreeId: "/repo" });
  });

  it("needs no list for a pane that runs at the root it is filed under (#11234)", () => {
    for (const unknown of [[], null, undefined]) {
      for (const cwd of ["/worktrees/task-a", "/worktrees/task-a/"]) {
        expect(resolveColdLaunchTarget({ cwd, worktreeId: "/worktrees/task-a" }, unknown)).toEqual({
          kind: "unchanged",
        });
      }
    }
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

describe("rereadWorktreeList (#18009)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers with the first list that comes, waiting before each read", async () => {
    vi.useFakeTimers();
    const read = vi
      .fn()
      .mockResolvedValueOnce({ worktrees: [] })
      .mockResolvedValueOnce({ worktrees: [{ id: "/repo" }] });
    const result = rereadWorktreeList(read, [100, 200, 400]);

    await vi.advanceTimersByTimeAsync(99);
    expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    await expect(result).resolves.toEqual([{ id: "/repo" }]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("stops waiting on a read that outlasts the budget", async () => {
    vi.useFakeTimers();
    // A host that never answers.
    const read = vi.fn(() => new Promise<{ worktrees: { id: string }[] }>(() => {}));
    const result = rereadWorktreeList(read, [100, 200, 400], 1000);

    await vi.advanceTimersByTimeAsync(999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives up with null once its attempts are spent, failed reads included", async () => {
    vi.useFakeTimers();
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("host not ready"))
      .mockResolvedValue({ worktrees: [] });
    const result = rereadWorktreeList(read, [100, 200]);

    await vi.advanceTimersByTimeAsync(300);
    await expect(result).resolves.toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
    // Nothing is left scheduled once it has answered.
    expect(vi.getTimerCount()).toBe(0);
  });
});
