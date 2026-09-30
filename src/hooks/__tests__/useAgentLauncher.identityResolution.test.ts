// @vitest-environment node
/**
 * Tests buildLaunchIdentity from useAgentLauncher.ts — the identity every
 * successful launch now reports so a caller driving parallel launches can map a
 * terminal back to its worktree without re-resolving the target (#11547). The
 * hook itself is store-coupled and untestable in isolation, so the construction
 * is extracted here and the four return points share it.
 */
import { describe, expect, it } from "vitest";
import { buildLaunchIdentity } from "../useAgentLauncher";

const SENSITIVE = { caseInsensitive: false };
const INSENSITIVE = { caseInsensitive: true };

describe("buildLaunchIdentity", () => {
  it("reports the resolved worktree's path and branch", () => {
    expect(
      buildLaunchIdentity(
        "wt-1",
        { path: "/repo/wt-1", branch: "feature/x" },
        "/repo/wt-1",
        SENSITIVE
      )
    ).toEqual({
      worktreeId: "wt-1",
      worktreePath: "/repo/wt-1",
      branch: "feature/x",
      cwd: "/repo/wt-1",
      cwdOutsideWorktree: false,
    });
  });

  it("reports a detached worktree with a null branch but a real path", () => {
    // `Worktree.branch` is optional — undefined in detached HEAD. The launch
    // still landed somewhere, so path and id must survive.
    const identity = buildLaunchIdentity("wt-2", { path: "/repo/wt-2" }, "/repo/wt-2", SENSITIVE);
    expect(identity.branch).toBeNull();
    expect(identity.worktreePath).toBe("/repo/wt-2");
  });

  it("keeps the requested worktree id when the worktree could not be looked up", () => {
    // resolveLaunchWorktree returns null before the map initializes. The panel
    // is still created with the requested id, so reporting it is accurate —
    // path and branch stay null because neither is known yet.
    expect(buildLaunchIdentity("wt-3", null, "/repo", SENSITIVE)).toEqual({
      worktreeId: "wt-3",
      worktreePath: null,
      branch: null,
      cwd: "/repo",
      cwdOutsideWorktree: null,
    });
  });

  it("reports a worktree-less launch with only a cwd", () => {
    // A scratch or bare-project launch: the cwd is the only locator there is.
    expect(buildLaunchIdentity(null, null, "/home/user/scratch", SENSITIVE)).toEqual({
      worktreeId: null,
      worktreePath: null,
      branch: null,
      cwd: "/home/user/scratch",
      cwdOutsideWorktree: null,
    });
  });

  it("normalizes an unresolved cwd to null rather than an empty string", () => {
    // resolveWorkspaceCwd returns "" when nothing resolves, and main reads a
    // falsy cwd as "use the home dir" — reporting "" would name a directory the
    // process never runs in.
    const identity = buildLaunchIdentity(null, { path: "/repo/wt-1" }, "", SENSITIVE);
    expect(identity.cwd).toBeNull();
    expect(identity.cwdOutsideWorktree).toBeNull();
  });

  it("treats an empty worktree id as absent", () => {
    // Mirrors the `targetWorktreeId || undefined` the panel options use, so the
    // reported id can never disagree with the panel's own.
    expect(buildLaunchIdentity("", null, "/repo", SENSITIVE).worktreeId).toBeNull();
    expect(buildLaunchIdentity(undefined, null, "/repo", SENSITIVE).worktreeId).toBeNull();
  });

  describe("cwdOutsideWorktree (#13130)", () => {
    const outside = (cwd: string, worktreePath: string, options = SENSITIVE) =>
      buildLaunchIdentity("wt", { path: worktreePath }, cwd, options).cwdOutsideWorktree;

    it("flags a cwd in another repo while the pane files under the worktree", () => {
      expect(outside("/work/siteorigin-panels", "/work/so-widgets-bundle-trackb")).toBe(true);
    });

    it("does not flag a cwd nested inside the worktree", () => {
      expect(outside("/repo/wt-1/packages/app", "/repo/wt-1")).toBe(false);
    });

    it("flags a sibling that only shares the worktree path as a string prefix", () => {
      expect(outside("/repo/wt-1-other", "/repo/wt-1")).toBe(true);
    });

    it("flags the parent of a nested worktree, which contains it rather than sits in it", () => {
      expect(outside("/repo", "/repo/.worktrees/feature")).toBe(true);
    });

    it("ignores trailing slashes and separator spelling", () => {
      expect(outside("/repo/wt-1/", "/repo/wt-1")).toBe(false);
      expect(outside("C:\\repo\\wt-1\\src", "C:/repo/wt-1", INSENSITIVE)).toBe(false);
    });

    it("folds letter case only when the platform compares paths case-insensitively", () => {
      expect(outside("/Repo/WT-1/src", "/repo/wt-1", INSENSITIVE)).toBe(false);
      expect(outside("/Repo/WT-1/src", "/repo/wt-1", SENSITIVE)).toBe(true);
    });
  });
});
