import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { refreshWorktreeIndex } from "../indexRefresh.js";

// #16679 against real git: the refresh heals a linked worktree's index and
// changes nothing a user could see in it.

const roots: string[] = [];
let home: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      // The reads below would otherwise write the refresh back themselves.
      GIT_OPTIONAL_LOCKS: "0",
      LC_ALL: "C",
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function tryGit(cwd: string, ...args: string[]): void {
  try {
    git(cwd, ...args);
  } catch {
    // The conflicting merge fails on purpose.
  }
}

/** A repository with five committed files and a linked worktree on its own branch. */
function makeLinkedWorktree(): { repo: string; worktree: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "daintree-index-refresh-")));
  roots.push(root);
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "repo@example.com");
  git(repo, "config", "user.name", "Repo Owner");
  git(repo, "config", "commit.gpgsign", "false");
  for (const name of ["a", "b", "c", "d", "e"]) {
    fs.writeFileSync(path.join(repo, `${name}.txt`), `${name}\n`);
  }
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  const worktree = path.join(root, "worktree");
  git(repo, "worktree", "add", "-q", "-b", "topic", worktree);
  return { repo, worktree };
}

function indexPath(worktree: string): string {
  return path.join(git(worktree, "rev-parse", "--absolute-git-dir").trim(), "index");
}

function visibleState(worktree: string): Record<string, string> {
  return {
    status: git(worktree, "status", "--porcelain=v1", "--untracked-files=all"),
    staged: git(worktree, "diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv"),
    unstaged: git(worktree, "diff", "--binary", "--no-ext-diff", "--no-textconv"),
    stages: git(worktree, "ls-files", "--stage"),
  };
}

/** Each index entry's cached mtime, in whole seconds. */
function entryMtimes(worktree: string): number[] {
  return [...git(worktree, "ls-files", "--debug").matchAll(/^\s+mtime: (\d+):\d+$/gm)].map(
    (match) => Number(match[1])
  );
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "daintree-index-refresh-home-")));
  roots.push(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", path.join(home, ".config"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("refreshWorktreeIndex against real git", () => {
  it("leaves staged, unstaged, partly staged, deleted, and untracked files as they were", async () => {
    const { worktree } = makeLinkedWorktree();
    fs.writeFileSync(path.join(worktree, "a.txt"), "a unstaged\n");
    fs.writeFileSync(path.join(worktree, "b.txt"), "b staged\n");
    git(worktree, "add", "b.txt");
    fs.writeFileSync(path.join(worktree, "c.txt"), "c staged\n");
    git(worktree, "add", "c.txt");
    fs.writeFileSync(path.join(worktree, "c.txt"), "c staged, then edited\n");
    fs.rmSync(path.join(worktree, "d.txt"));
    fs.writeFileSync(path.join(worktree, "new.txt"), "untracked\n");
    const before = visibleState(worktree);

    await refreshWorktreeIndex(worktree, undefined, () => true);

    expect(visibleState(worktree)).toEqual(before);
    expect(before.status).toContain("?? new.txt");
    expect(before.status).toContain("MM c.txt");
  });

  /**
   * A racily clean index, built the way a checkout leaves one: every entry's
   * cached stat matches its file, and the index is no newer than the entries.
   */
  function makeRacyIndex(worktree: string): { index: string; stamp: number } {
    const index = indexPath(worktree);
    // Even, so a filesystem with 2 s timestamps stores it as given.
    const now = Math.floor(Date.now() / 1000) - 60;
    const stamp = now - (now % 2);
    for (const name of ["a", "b", "c", "d", "e"]) {
      fs.utimesSync(path.join(worktree, `${name}.txt`), stamp, stamp);
    }
    git(worktree, "update-index", "--refresh");
    fs.utimesSync(index, stamp, stamp);
    return { index, stamp };
  }

  it("rewrites a racily clean index that status under GIT_OPTIONAL_LOCKS=0 leaves alone", async () => {
    const { worktree } = makeLinkedWorktree();
    const { index, stamp } = makeRacyIndex(worktree);
    expect(entryMtimes(worktree)).toEqual([stamp, stamp, stamp, stamp, stamp]);
    const racyIndex = fs.readFileSync(index);

    git(worktree, "status", "--porcelain");
    expect(fs.readFileSync(index).equals(racyIndex)).toBe(true);
    expect(Math.floor(fs.statSync(index).mtimeMs / 1000)).toBe(stamp);

    await refreshWorktreeIndex(worktree, undefined, () => true);

    expect(Math.floor(fs.statSync(index).mtimeMs / 1000)).toBeGreaterThan(stamp);
    expect(entryMtimes(worktree)).toEqual([stamp, stamp, stamp, stamp, stamp]);
    expect(git(worktree, "status", "--porcelain")).toBe("");
  });

  it("starts no git when it is no longer wanted by the time the factory is ready", async () => {
    const { worktree } = makeLinkedWorktree();
    const { index } = makeRacyIndex(worktree);
    const racyIndex = fs.readFileSync(index);

    await refreshWorktreeIndex(worktree, undefined, () => false);

    expect(fs.readFileSync(index).equals(racyIndex)).toBe(true);
  });

  it("rejects when another git holds index.lock, and leaves the lock and the index alone", async () => {
    const { worktree } = makeLinkedWorktree();
    const index = indexPath(worktree);
    const lock = `${index}.lock`;
    fs.writeFileSync(lock, "held by an agent");
    const indexBefore = fs.readFileSync(index);

    await expect(refreshWorktreeIndex(worktree, undefined, () => true)).rejects.toThrow(
      /index\.lock/
    );

    expect(fs.readFileSync(lock, "utf8")).toBe("held by an agent");
    expect(fs.readFileSync(index).equals(indexBefore)).toBe(true);
  });

  it("resolves through unmerged entries without resolving them", async () => {
    const { repo, worktree } = makeLinkedWorktree();
    fs.writeFileSync(path.join(repo, "a.txt"), "a on main\n");
    git(repo, "commit", "-q", "-am", "main side");
    fs.writeFileSync(path.join(worktree, "a.txt"), "a on topic\n");
    git(worktree, "commit", "-q", "-am", "topic side");
    tryGit(worktree, "merge", "-q", "main");
    const before = visibleState(worktree);
    expect(before.status).toContain("UU a.txt");

    await refreshWorktreeIndex(worktree, undefined, () => true);

    expect(visibleState(worktree)).toEqual(before);
  });
});
