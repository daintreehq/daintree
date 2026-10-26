import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ReviewPoint } from "../../../../../shared/types/reviewPoint.js";
import { captureReviewPoint } from "../captureReviewPoint.js";
import { readWorktreeIdentity, reviewPointMismatch } from "../readWorktreeIdentity.js";

// Real repositories: a mark is only refused or kept correctly if the identity
// read spells paths and branches exactly as a capture does.

let root: string;

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

function makeRepo(name: string): string {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

async function capture(cwd: string): Promise<ReviewPoint> {
  const result = await captureReviewPoint(cwd, { base: { kind: "branch", branch: "main" } });
  if (result.kind !== "captured") throw new Error(`capture failed: ${JSON.stringify(result)}`);
  return result.point;
}

async function mismatch(point: ReviewPoint, cwd: string) {
  return reviewPointMismatch(point, await readWorktreeIdentity(cwd, { timeoutMs: 10_000 }));
}

let repo: string;
let linked: string;
let other: string;

beforeAll(() => {
  // realpath: macOS hands out /var/... for a /private/var/... directory.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "review-identity-")));
  repo = makeRepo("repo");
  linked = path.join(root, "linked");
  git(repo, "worktree", "add", "-q", "-b", "topic", linked);
  other = makeRepo("other");
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("readWorktreeIdentity", () => {
  it("matches a point captured in the same worktree, main or linked", async () => {
    expect(await mismatch(await capture(repo), repo)).toBeNull();
    expect(await mismatch(await capture(linked), linked)).toBeNull();
  });

  it("matches when read from a subdirectory of the worktree", async () => {
    fs.mkdirSync(path.join(linked, "sub"), { recursive: true });
    expect(await mismatch(await capture(linked), path.join(linked, "sub"))).toBeNull();
  });

  it("refuses another worktree of the same repository", async () => {
    expect(await mismatch(await capture(repo), linked)).toBe("worktree");
  });

  it("refuses another repository", async () => {
    expect(await mismatch(await capture(repo), other)).toBe("repository");
  });

  it("refuses once the worktree is on another branch, or detached", async () => {
    const point = await capture(linked);
    git(linked, "switch", "-q", "-c", "elsewhere");
    try {
      expect(await mismatch(point, linked)).toBe("branch");
      git(linked, "switch", "-q", "--detach", "topic");
      expect(await mismatch(point, linked)).toBe("branch");
    } finally {
      git(linked, "switch", "-q", "topic");
    }
  });

  it("matches a detached point only while detached", async () => {
    git(linked, "switch", "-q", "--detach", "topic");
    try {
      const point = await capture(linked);
      expect(point.head.kind).toBe("detached");
      expect(await mismatch(point, linked)).toBeNull();
      git(linked, "switch", "-q", "topic");
      expect(await mismatch(point, linked)).toBe("branch");
    } finally {
      git(linked, "switch", "-q", "topic");
    }
  });

  it("matches an unborn branch by its name", async () => {
    const fresh = path.join(root, "fresh");
    fs.mkdirSync(fresh);
    git(fresh, "init", "-q", "-b", "start");
    const point = await capture(fresh);
    expect(point.head).toEqual({ kind: "unborn", branch: "start" });
    expect(await mismatch(point, fresh)).toBeNull();
    git(fresh, "symbolic-ref", "HEAD", "refs/heads/other");
    expect(await mismatch(point, fresh)).toBe("branch");
  });

  it("rejects a path that isn't a repository", async () => {
    const plain = path.join(root, "plain");
    fs.mkdirSync(plain);
    await expect(readWorktreeIdentity(plain, { timeoutMs: 10_000 })).rejects.toThrow();
  });
});
