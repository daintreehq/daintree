import { describe, it, expect, vi } from "vitest";
import { withReplayedWorktreeDetails } from "../replayedContextWorktree";

const worktrees = new Map([
  ["wt-pane", { name: "pane", path: "/repo/pane", branch: "feature/pane", isMainWorktree: false }],
]);
const lookup = (id: string) => worktrees.get(id);

describe("withReplayedWorktreeDetails (#12486)", () => {
  it("describes a worktree named by id alone from the view's store", () => {
    expect(
      withReplayedWorktreeDetails({ projectId: "p1", activeWorktreeId: "wt-pane" }, lookup)
    ).toEqual({
      projectId: "p1",
      activeWorktreeId: "wt-pane",
      activeWorktreeName: "pane",
      activeWorktreePath: "/repo/pane",
      activeWorktreeBranch: "feature/pane",
      activeWorktreeIsMain: false,
    });
  });

  it("replays a complete snapshot exactly as captured", () => {
    // A help session's provision-time snapshot (#8317) already carries its
    // worktree's description; the store must not overwrite it.
    const snapshot = {
      activeWorktreeId: "wt-pane",
      activeWorktreePath: "/captured/path",
      activeWorktreeName: "captured",
    };
    const spy = vi.fn(lookup);

    expect(withReplayedWorktreeDetails(snapshot, spy)).toBe(snapshot);
    expect(spy).not.toHaveBeenCalled();
  });

  it("leaves a worktree the store no longer knows undescribed rather than borrowing another", () => {
    const context = { activeWorktreeId: "wt-deleted" };

    expect(withReplayedWorktreeDetails(context, lookup)).toBe(context);
  });

  it("leaves a context that names no worktree alone", () => {
    const context = { projectId: "p1" };

    expect(withReplayedWorktreeDetails(context, lookup)).toBe(context);
  });
});
