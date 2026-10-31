import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readWorktreeGitObservation } from "../worktreeRetirementGit.js";

// Real repositories (#15737): "pushed" has to hold for a topic branch created
// `--no-track` and pushed under its own name, which no mock of git can show.

let root: string;
let remote: string;
let repo: string;

function fixtureEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, "xdg"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "T",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "T",
    GIT_COMMITTER_EMAIL: "t@example.com",
    LC_ALL: "C",
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: fixtureEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function commit(cwd: string, file: string, content: string): void {
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", `edit ${file}`);
}

/** A linked worktree on a new `--no-track` branch from the pushed main, as Daintree creates one. */
function linkedWorktree(name: string): string {
  const dir = path.join(root, name);
  git(repo, "worktree", "add", "-q", "--no-track", "-b", name, dir, "origin/main");
  return dir;
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "retire-git-")));
  remote = path.join(root, "remote.git");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  commit(repo, "a.txt", "a\n");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("readWorktreeGitObservation", () => {
  it("reads a fresh topic branch with nothing past its pushed base as clean and pushed", async () => {
    const dir = linkedWorktree("fresh");

    const observation = await readWorktreeGitObservation(dir);

    expect(observation).toEqual({
      headOid: git(dir, "rev-parse", "HEAD").trim(),
      branch: "fresh",
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
      hiddenFromStatus: 0,
      unpushedCommits: 0,
    });
  });

  it("counts a commit no remote holds, then none once the branch is pushed with no upstream", async () => {
    const dir = linkedWorktree("topic");
    commit(dir, "b.txt", "b\n");

    expect((await readWorktreeGitObservation(dir)).unpushedCommits).toBe(1);

    git(dir, "push", "-q", "origin", "topic");
    expect(() => git(dir, "rev-parse", "--abbrev-ref", "topic@{upstream}")).toThrow();
    expect((await readWorktreeGitObservation(dir)).unpushedCommits).toBe(0);
  });

  it("counts a commit only a second remote holds as pushed", async () => {
    const mirror = path.join(root, "mirror.git");
    git(root, "init", "-q", "--bare", "-b", "main", mirror);
    git(repo, "remote", "add", "mirror", mirror);
    const dir = linkedWorktree("mirrored");
    commit(dir, "m.txt", "m\n");

    git(dir, "push", "-q", "mirror", "mirrored");

    expect((await readWorktreeGitObservation(dir)).unpushedCommits).toBe(0);
  });

  it("counts staged, unstaged and untracked work separately", async () => {
    const dir = linkedWorktree("dirty");
    fs.writeFileSync(path.join(dir, "a.txt"), "changed\n");
    for (const name of ["s1.txt", "s2.txt"]) {
      fs.writeFileSync(path.join(dir, name), "s\n");
      git(dir, "add", name);
    }
    fs.mkdirSync(path.join(dir, "scratch"));
    fs.writeFileSync(path.join(dir, "scratch", "one.txt"), "1\n");
    fs.writeFileSync(path.join(dir, "scratch", "two.txt"), "2\n");

    expect(await readWorktreeGitObservation(dir)).toMatchObject({
      staged: 2,
      unstaged: 1,
      // The untracked directory is one entry, however many files it holds.
      untracked: 1,
      conflicted: 0,
    });
  });

  it("counts an edit hidden behind assume-unchanged, which status never reports", async () => {
    const dir = linkedWorktree("assumed");
    git(dir, "update-index", "--assume-unchanged", "a.txt");
    fs.writeFileSync(path.join(dir, "a.txt"), "hidden edit\n");

    expect(await readWorktreeGitObservation(dir)).toMatchObject({
      unstaged: 0,
      hiddenFromStatus: 1,
    });
  });

  it("counts a skip-worktree file only while it is present", async () => {
    const dir = linkedWorktree("skipped");
    git(dir, "update-index", "--skip-worktree", "a.txt");
    fs.writeFileSync(path.join(dir, "a.txt"), "hidden edit\n");
    expect((await readWorktreeGitObservation(dir)).hiddenFromStatus).toBe(1);

    // As a sparse checkout leaves it: nothing on disk to lose.
    fs.rmSync(path.join(dir, "a.txt"));
    expect((await readWorktreeGitObservation(dir)).hiddenFromStatus).toBe(0);
  });

  it("counts a conflicted path", async () => {
    const dir = linkedWorktree("conflict");
    commit(dir, "a.txt", "ours\n");
    git(repo, "checkout", "-q", "-b", "theirs", "origin/main");
    commit(repo, "a.txt", "theirs\n");
    git(repo, "checkout", "-q", "main");
    expect(() => git(dir, "merge", "-q", "theirs")).toThrow();

    expect((await readWorktreeGitObservation(dir)).conflicted).toBe(1);
  });

  it("reads a detached HEAD by its commit, with no branch", async () => {
    const dir = linkedWorktree("detached");
    git(dir, "checkout", "-q", "--detach");

    const observation = await readWorktreeGitObservation(dir);

    expect(observation.branch).toBeNull();
    expect(observation.unpushedCommits).toBe(0);
  });

  it("reports no commit to ask about on an unborn branch", async () => {
    const dir = path.join(root, "unborn");
    fs.mkdirSync(dir);
    git(dir, "init", "-q", "-b", "main");

    expect(await readWorktreeGitObservation(dir)).toMatchObject({
      headOid: null,
      unpushedCommits: null,
    });
  });

  it("rejects for a directory that is not its repository's top level", async () => {
    const nested = path.join(repo, "nested");
    fs.mkdirSync(nested, { recursive: true });

    await expect(readWorktreeGitObservation(nested)).rejects.toThrow(/other than the worktree/);
  });

  it("rejects for a directory git cannot read", async () => {
    await expect(readWorktreeGitObservation(path.join(root, "missing"))).rejects.toThrow();
  });
});
