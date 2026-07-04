import { describe, expect, it } from "vitest";
import { resolveResumeLaunchTarget } from "../resumeLaunch";

describe("resolveResumeLaunchTarget", () => {
  const fallback = { defaultTerminalCwd: "/active/cwd", activeWorktreeId: "wt-active" };

  it("uses the session's own cwd and worktree when recorded", () => {
    const target = resolveResumeLaunchTarget(
      { cwd: "/repo/worktree-a", worktreeId: "wt-a" },
      fallback
    );
    expect(target).toEqual({ cwd: "/repo/worktree-a", worktreeId: "wt-a" });
  });

  it("does not launch into the active worktree when the session belongs elsewhere", () => {
    // The whole point of #4781: a session captured in worktree A must resume in
    // A even while worktree B is the one currently active in the UI.
    const target = resolveResumeLaunchTarget(
      { cwd: "/repo/worktree-a", worktreeId: "wt-a" },
      { defaultTerminalCwd: "/repo/worktree-b", activeWorktreeId: "wt-b" }
    );
    expect(target.cwd).toBe("/repo/worktree-a");
    expect(target.worktreeId).toBe("wt-a");
  });

  it("falls back to the active worktree defaults when the record predates cwd/worktree", () => {
    const target = resolveResumeLaunchTarget({ cwd: undefined, worktreeId: null }, fallback);
    expect(target).toEqual({ cwd: "/active/cwd", worktreeId: "wt-active" });
  });

  it("falls back cwd independently of worktree", () => {
    const target = resolveResumeLaunchTarget({ cwd: "/repo/wt-a", worktreeId: null }, fallback);
    expect(target.cwd).toBe("/repo/wt-a");
    expect(target.worktreeId).toBe("wt-active");
  });

  it("yields an undefined worktreeId when neither record nor active worktree is set", () => {
    const target = resolveResumeLaunchTarget(
      { cwd: undefined, worktreeId: null },
      { defaultTerminalCwd: "/active/cwd", activeWorktreeId: null }
    );
    expect(target.worktreeId).toBeUndefined();
    expect(target.cwd).toBe("/active/cwd");
  });

  it("re-homes a null-worktree record onto the live worktree containing its cwd", () => {
    // The record was journaled before worktree selection settled, but its cwd
    // pins it to worktree A — launch there, not into the active worktree.
    const target = resolveResumeLaunchTarget(
      { cwd: "/repo/wt-a/src", worktreeId: null },
      fallback,
      [
        { id: "wt-a", path: "/repo/wt-a" },
        { id: "wt-b", path: "/repo/wt-b" },
      ]
    );
    expect(target.cwd).toBe("/repo/wt-a/src");
    expect(target.worktreeId).toBe("wt-a");
  });

  it("prefers the recorded worktree over cwd inference", () => {
    const target = resolveResumeLaunchTarget(
      { cwd: "/repo/wt-a", worktreeId: "wt-recorded" },
      fallback,
      [{ id: "wt-a", path: "/repo/wt-a" }]
    );
    expect(target.worktreeId).toBe("wt-recorded");
  });

  it("falls back to the active worktree when cwd resolves to no live worktree", () => {
    const target = resolveResumeLaunchTarget(
      { cwd: "/tmp/elsewhere", worktreeId: null },
      fallback,
      [{ id: "wt-a", path: "/repo/wt-a" }]
    );
    expect(target.worktreeId).toBe("wt-active");
  });
});
