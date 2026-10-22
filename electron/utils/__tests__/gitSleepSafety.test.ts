import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { probeGitSleepSafety } from "../gitSleepSafety.js";

describe("probeGitSleepSafety", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "git-sleep-safety-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function mainCheckout(): string {
    const repo = path.join(root, "repo");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    return repo;
  }

  /** A linked worktree whose `.git` file points into the main repo, as `git worktree add` writes it. */
  function linkedWorktree(gitdirLine: (gitDir: string) => string): {
    worktree: string;
    gitDir: string;
  } {
    const repo = mainCheckout();
    const gitDir = path.join(repo, ".git", "worktrees", "feature");
    mkdirSync(gitDir, { recursive: true });
    const worktree = path.join(root, "feature");
    mkdirSync(worktree);
    writeFileSync(path.join(worktree, ".git"), `${gitdirLine(gitDir)}\n`);
    return { worktree, gitDir };
  }

  it("is clear for a main checkout with nothing in progress", async () => {
    expect(await probeGitSleepSafety(mainCheckout())).toEqual({ state: "clear" });
  });

  it.each([
    "MERGE_HEAD",
    "rebase-merge",
    "rebase-apply",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "index.lock",
  ])("is busy while %s is present", async (marker) => {
    const repo = mainCheckout();
    writeFileSync(path.join(repo, ".git", marker), "");
    expect(await probeGitSleepSafety(repo)).toEqual({ state: "busy", marker });
  });

  it("follows a linked worktree's .git file to its own git directory", async () => {
    const { worktree, gitDir } = linkedWorktree((dir) => `gitdir: ${dir}`);
    expect(await probeGitSleepSafety(worktree)).toEqual({ state: "clear" });

    mkdirSync(path.join(gitDir, "rebase-merge"));
    expect(await probeGitSleepSafety(worktree)).toEqual({ state: "busy", marker: "rebase-merge" });
  });

  it("resolves a relative gitdir against the worktree", async () => {
    const { worktree, gitDir } = linkedWorktree(
      (dir) => `gitdir: ${path.relative(path.join(root, "feature"), dir)}`
    );
    writeFileSync(path.join(gitDir, "MERGE_HEAD"), "");
    expect(await probeGitSleepSafety(worktree)).toEqual({ state: "busy", marker: "MERGE_HEAD" });
  });

  it("is unknown when the .git file is malformed", async () => {
    const { worktree } = linkedWorktree(() => "not a gitdir line");
    expect((await probeGitSleepSafety(worktree)).state).toBe("unknown");
  });

  it("is unknown when the .git file points nowhere", async () => {
    const { worktree } = linkedWorktree(() => `gitdir: ${path.join(root, "gone")}`);
    expect((await probeGitSleepSafety(worktree)).state).toBe("unknown");
  });

  it("is unknown when there is no .git at all", async () => {
    const folder = path.join(root, "plain");
    mkdirSync(folder);
    expect((await probeGitSleepSafety(folder)).state).toBe("unknown");
  });
});
