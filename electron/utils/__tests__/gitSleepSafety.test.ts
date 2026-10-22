import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { probeRepositorySleepSafety } from "../gitSleepSafety.js";

describe("probeRepositorySleepSafety", () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "git-sleep-safety-"));
    repo = path.join(root, "repo");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A linked worktree laid out as `git worktree add` leaves it, including `commondir`. */
  function linkedWorktree(name: string, gitdirLine?: (gitDir: string) => string) {
    const gitDir = path.join(repo, ".git", "worktrees", name);
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(path.join(gitDir, "commondir"), "../..\n");
    const worktree = path.join(root, name);
    mkdirSync(worktree);
    writeFileSync(
      path.join(worktree, ".git"),
      `${gitdirLine ? gitdirLine(gitDir) : `gitdir: ${gitDir}`}\n`
    );
    return { worktree, gitDir };
  }

  it("is clear for a repository with nothing in progress", async () => {
    linkedWorktree("feature");
    expect(await probeRepositorySleepSafety([repo])).toEqual({ state: "clear" });
  });

  it.each([
    "MERGE_HEAD",
    "rebase-merge",
    "rebase-apply",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "index.lock",
  ])("is busy while %s is present", async (marker) => {
    writeFileSync(path.join(repo, ".git", marker), "");
    expect(await probeRepositorySleepSafety([repo])).toEqual({ state: "busy", marker });
  });

  it("finds an operation in a linked worktree it was never told about", async () => {
    // Created outside Daintree: only the repository's own worktrees directory knows it.
    const { gitDir } = linkedWorktree("elsewhere");
    mkdirSync(path.join(gitDir, "rebase-merge"));
    expect(await probeRepositorySleepSafety([repo])).toEqual({
      state: "busy",
      marker: "rebase-merge",
    });
  });

  it("finds an operation paused inside an absorbed submodule", async () => {
    // Nested name, as `git submodule absorbgitdirs` lays out `libs/vendor`.
    const moduleDir = path.join(repo, ".git", "modules", "libs", "vendor");
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(path.join(moduleDir, "HEAD"), "ref: refs/heads/main\n");
    expect(await probeRepositorySleepSafety([repo])).toEqual({ state: "clear" });

    mkdirSync(path.join(moduleDir, "rebase-merge"));
    expect(await probeRepositorySleepSafety([repo])).toEqual({
      state: "busy",
      marker: "rebase-merge",
    });
  });

  it("follows a linked worktree's .git file and commondir back to the main repository", async () => {
    const { worktree } = linkedWorktree("feature");
    writeFileSync(path.join(repo, ".git", "MERGE_HEAD"), "");
    expect(await probeRepositorySleepSafety([worktree])).toEqual({
      state: "busy",
      marker: "MERGE_HEAD",
    });
  });

  it("resolves a relative gitdir against the worktree", async () => {
    const { worktree, gitDir } = linkedWorktree(
      "feature",
      (dir) => `gitdir: ${path.relative(path.join(root, "feature"), dir)}`
    );
    writeFileSync(path.join(gitDir, "index.lock"), "");
    expect(await probeRepositorySleepSafety([worktree])).toEqual({
      state: "busy",
      marker: "index.lock",
    });
  });

  it("is unknown when a .git file is malformed", async () => {
    const { worktree } = linkedWorktree("feature", () => "not a gitdir line");
    expect((await probeRepositorySleepSafety([repo, worktree])).state).toBe("unknown");
  });

  it("is unknown when a .git file points nowhere", async () => {
    const { worktree } = linkedWorktree("feature", () => `gitdir: ${path.join(root, "gone")}`);
    expect((await probeRepositorySleepSafety([worktree])).state).toBe("unknown");
  });

  it("is unknown for a folder with no .git unless it is known not to be a repository", async () => {
    const folder = path.join(root, "plain");
    mkdirSync(folder);
    expect((await probeRepositorySleepSafety([folder])).state).toBe("unknown");
    expect(await probeRepositorySleepSafety([folder], { missingRepoIsClear: true })).toEqual({
      state: "clear",
    });
  });
});
