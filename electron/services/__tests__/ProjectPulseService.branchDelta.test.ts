import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProjectPulseService } from "../ProjectPulseService.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

function commit(cwd: string, file: string, content: string): void {
  writeFileSync(path.join(cwd, file), content);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", `edit ${file}`);
}

describe("ProjectPulseService branch delta (real git)", () => {
  let root: string;
  let local: string;
  let remoteOnly: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "pulse-delta-"));

    local = path.join(root, "local");
    git(root, "init", "-q", "-b", "develop", local);
    commit(local, "a.txt", "a\n");
    git(local, "checkout", "-q", "-b", "feature");
    commit(local, "b.txt", "b1\nb2\n");
    commit(local, "c.txt", "c\n");
    git(local, "checkout", "-q", "develop");
    commit(local, "d.txt", "d\n");
    git(local, "checkout", "-q", "feature");

    // Base exists only as origin/develop: the local develop ref is deleted.
    remoteOnly = path.join(root, "remote-only");
    git(root, "init", "-q", "-b", "develop", remoteOnly);
    commit(remoteOnly, "a.txt", "a\n");
    git(remoteOnly, "checkout", "-q", "-b", "feature");
    commit(remoteOnly, "b.txt", "b1\nb2\n");
    git(remoteOnly, "checkout", "-q", "develop");
    commit(remoteOnly, "d.txt", "d\n");
    git(remoteOnly, "update-ref", "refs/remotes/origin/develop", "develop");
    git(remoteOnly, "checkout", "-q", "feature");
    git(remoteOnly, "branch", "-D", "develop");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const pulse = (worktreePath: string) =>
    new ProjectPulseService().getPulse({
      worktreePath,
      worktreeId: path.basename(worktreePath),
      mainBranch: "develop",
      rangeDays: 60,
      includeDelta: true,
      includeRecentCommits: false,
    });

  it("reports ahead/behind and changed files against a local base", async () => {
    const result = await pulse(local);
    expect(result.deltaToMain).toMatchObject({
      baseBranch: "develop",
      headBranch: "feature",
      ahead: 2,
      behind: 1,
      filesChanged: 2,
      insertions: 3,
      deletions: 0,
    });
  });

  it("falls back to origin/<base> when the base exists only on the remote", async () => {
    const result = await pulse(remoteOnly);
    expect(result.deltaToMain).toMatchObject({
      baseBranch: "origin/develop",
      headBranch: "feature",
      ahead: 1,
      behind: 1,
      filesChanged: 1,
      insertions: 2,
      deletions: 0,
    });
  });
});
