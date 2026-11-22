import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readWorktreesLocalWork } from "../worktreeLocalWork.js";
import { readWorktreeGitObservation } from "../../mcp-server/worktreeRetirementGit.js";

// Real repositories (#18151): which checkout is the project's main one, and
// whether a worktree belongs to the project at all, is git's to say.

let root: string;
let repo: string;
let other: string;

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

function newRepo(name: string): string {
  const remote = path.join(root, `${name}-remote.git`);
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  commit(dir, "a.txt", "a\n");
  git(dir, "remote", "add", "origin", remote);
  git(dir, "push", "-q", "origin", "main");
  return dir;
}

function linkedWorktree(name: string): string {
  const dir = path.join(root, name);
  git(repo, "worktree", "add", "-q", "--no-track", "-b", name, dir, "origin/main");
  return dir;
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "local-work-")));
  repo = newRepo("repo");
  other = newRepo("other");
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("readWorktreesLocalWork", () => {
  it("reads a linked worktree's unpushed commits and changed entries, and passes over the main checkout", async () => {
    const clean = linkedWorktree("clean");
    const dirty = linkedWorktree("dirty");
    commit(dirty, "b.txt", "b\n");
    fs.writeFileSync(path.join(dirty, "untracked.txt"), "u\n");

    const work = await readWorktreesLocalWork([
      { projectPath: repo, worktreeId: clean },
      { projectPath: repo, worktreeId: dirty },
      { projectPath: repo, worktreeId: repo },
      { projectPath: repo, worktreeId: undefined },
    ]);

    expect(work).toEqual([
      { kind: "observed", unpushedCommits: 0, changedEntries: 0, hiddenFromStatus: 0 },
      { kind: "observed", unpushedCommits: 1, changedEntries: 1, hiddenFromStatus: 0 },
      { kind: "not-applicable" },
      { kind: "not-applicable" },
    ]);
  });

  it("never passes over another repository's checkout as the project's main one", async () => {
    const work = await readWorktreesLocalWork([
      { projectPath: repo, worktreeId: other },
      { projectPath: null, worktreeId: repo },
      { projectPath: repo, worktreeId: path.join(root, "gone") },
    ]);

    expect(work).toEqual([{ kind: "unreadable" }, { kind: "unreadable" }, { kind: "unreadable" }]);
  });

  it("reads a worktree several panels share once", async () => {
    const shared = linkedWorktree("shared");
    const readGit = vi.fn(readWorktreeGitObservation);

    const work = await readWorktreesLocalWork(
      [
        { projectPath: repo, worktreeId: shared },
        { projectPath: repo, worktreeId: shared },
      ],
      { readGit }
    );

    expect(readGit).toHaveBeenCalledTimes(1);
    expect(work[0]).toEqual(work[1]);
    expect(work[0]!.kind).toBe("observed");
  });

  it("reads what hasn't answered by the deadline as unreadable, and stops its git", async () => {
    const slow = linkedWorktree("slow");
    let stopped = false;
    const readGit = vi.fn(
      (_dir: string, signal?: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            stopped = true;
            reject(signal.reason);
          });
        })
    );

    const work = await readWorktreesLocalWork([{ projectPath: repo, worktreeId: slow }], {
      readGit,
      deadlineMs: 300,
    });

    expect(work).toEqual([{ kind: "unreadable" }]);
    expect(stopped).toBe(true);
  });
});
