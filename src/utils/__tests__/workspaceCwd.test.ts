import { describe, it, expect } from "vitest";
import { resolveWorkspaceCwd } from "../workspaceCwd";

describe("resolveWorkspaceCwd", () => {
  it("prefers the worktree over every other workspace path", () => {
    expect(
      resolveWorkspaceCwd({
        worktreePath: "/repo-worktrees/feature",
        projectPath: "/repo",
        scratchPath: "/scratches/s1",
        homeDir: "/home/user",
      })
    ).toBe("/repo-worktrees/feature");
  });

  it("falls back to the project when there is no worktree", () => {
    expect(
      resolveWorkspaceCwd({ projectPath: "/repo", scratchPath: "/scratches/s1", homeDir: "/home" })
    ).toBe("/repo");
  });

  // #11076: a scratch is an active workspace with no worktree. Skipping it here
  // is what stranded `terminal.new` and dock launches in the home dir.
  it("resolves to the scratch when it is the only active workspace", () => {
    expect(resolveWorkspaceCwd({ scratchPath: "/scratches/s1", homeDir: "/home" })).toBe(
      "/scratches/s1"
    );
  });

  it("falls back to the home dir when no workspace is active", () => {
    expect(resolveWorkspaceCwd({ homeDir: "/home/user" })).toBe("/home/user");
  });

  it("yields an empty string only when nothing resolves", () => {
    expect(resolveWorkspaceCwd({})).toBe("");
  });

  it("treats absent paths as absent rather than skipping the rest of the chain", () => {
    expect(
      resolveWorkspaceCwd({ worktreePath: null, projectPath: undefined, scratchPath: "/scratches" })
    ).toBe("/scratches");
  });
});
