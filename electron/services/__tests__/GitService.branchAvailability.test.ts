import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitService } from "../GitService.js";
import { GitOperationError } from "../../utils/errorTypes.js";

/**
 * Real-git coverage for #15663: the New Worktree dialog's branch-name check
 * reads local branch names only, never the remote-tracking refs `listBranches()`
 * enumerates, and must answer the same as before on every case it covered.
 */

function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], {
    cwd,
    stdio: "pipe",
    timeout: 10_000,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_SYSTEM: os.devNull,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

describe("GitService.findAvailableBranchName (real git)", () => {
  let tempRoot: string;
  let repoDir: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-branch-availability-"));
    repoDir = path.join(tempRoot, "repo");
    fs.mkdirSync(repoDir);
    git(repoDir, ["init", "-q", "-b", "main"]);
    git(repoDir, ["commit", "-q", "--allow-empty", "-m", "init"]);
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const branch = (...names: string[]) => names.forEach((name) => git(repoDir, ["branch", name]));
  const remoteRef = (...names: string[]) =>
    names.forEach((name) => git(repoDir, ["update-ref", `refs/remotes/${name}`, "HEAD"]));

  it("answers the oracle cases: free, taken locally, remote-only, and suffixed", async () => {
    branch(
      "bench/taken",
      "bench/suffixed",
      "bench/suffixed-2",
      "bench/suffixed-7",
      "bench/suffixed-9-old",
      "bench/suffixed-11/nested"
    );
    remoteRef("origin/bench/remote-only", "origin/bench/suffixed-30", "origin/bench/taken-5");
    const service = new GitService(repoDir);

    expect(await service.findAvailableBranchName("bench/free-name")).toBe("bench/free-name");
    expect(await service.findAvailableBranchName("bench/taken")).toBe("bench/taken-2");
    expect(await service.findAvailableBranchName("bench/remote-only")).toBe("bench/remote-only");
    expect(await service.findAvailableBranchName("bench/suffixed")).toBe("bench/suffixed-8");
  });

  it("reads leading-zero suffixes numerically and ignores suffixes without the base", async () => {
    branch("topic", "topic-0", "topic-07", "orphan-5");
    const service = new GitService(repoDir);

    expect(await service.findAvailableBranchName("topic")).toBe("topic-8");
    expect(await service.findAvailableBranchName("orphan")).toBe("orphan");
  });

  it("treats regex metacharacters in the base literally", async () => {
    branch("feature/foo+bar", "feature/foo+bar-2", "feature/foooobar-9");
    const service = new GitService(repoDir);

    expect(await service.findAvailableBranchName("feature/foo+bar")).toBe("feature/foo+bar-3");
  });

  it("sees packed refs and loose refs created after packing", async () => {
    branch("packed", "packed-3");
    git(repoDir, ["pack-refs", "--all"]);
    branch("packed-4");
    const service = new GitService(repoDir);

    expect(await service.findAvailableBranchName("packed")).toBe("packed-5");
  });

  it("counts a local branch whose name starts with remotes/ as local", async () => {
    branch("remotes/local-topic");
    const service = new GitService(repoDir);

    expect(await service.findAvailableBranchName("remotes/local-topic")).toBe(
      "remotes/local-topic-2"
    );
  });

  it("does not treat a detached HEAD's tag as a branch", async () => {
    git(repoDir, ["tag", "v1.0"]);
    git(repoDir, ["checkout", "-q", "--detach", "v1.0"]);
    const service = new GitService(repoDir);

    expect(await service.findAvailableBranchName("v1.0")).toBe("v1.0");
  });

  it("returns names git would never hold unchanged", async () => {
    branch("plain");
    const service = new GitService(repoDir);

    for (const name of ["-plain", "--output=/tmp/x", "plain*", "pl[ai]n", "../plain"]) {
      expect(await service.findAvailableBranchName(name)).toBe(name);
    }
  });

  it("answers in a repository with no commits yet", async () => {
    const unborn = path.join(tempRoot, "unborn");
    fs.mkdirSync(unborn);
    git(unborn, ["init", "-q", "-b", "main"]);
    const service = new GitService(unborn);

    expect(await service.findAvailableBranchName("main")).toBe("main");
  });

  it("stays advisory: worktree creation still rejects a branch created after the check", async () => {
    const service = new GitService(repoDir);
    const name = await service.findAvailableBranchName("racer");
    expect(name).toBe("racer");

    branch("racer");

    await expect(
      service.createWorktree({
        baseBranch: "main",
        newBranch: name,
        path: path.join(tempRoot, "racer-worktree"),
      })
    ).rejects.toThrow(/already exists/);
  });

  it("throws a classified GitOperationError outside a repository", async () => {
    const plain = path.join(tempRoot, "not-a-repo");
    fs.mkdirSync(plain);
    const service = new GitService(plain);

    const caught = await service.findAvailableBranchName("anything").then(
      () => null,
      (error: unknown) => error
    );

    expect(caught).toBeInstanceOf(GitOperationError);
    expect((caught as GitOperationError).reason).toBe("not-a-repository");
  });
});
