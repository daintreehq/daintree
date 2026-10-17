import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkBranchAgainstRemote } from "../branchCheck.js";
import { commit, git, makeBare, makeRepo, tempRoot, testGit } from "./gitFixtures.js";

let root: string;

beforeAll(() => {
  root = tempRoot("pah-branch-");
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function check(dir: string) {
  const git = await testGit.local(dir);
  const remotes = (await git.raw(["remote", "-v"]))
    .split("\n")
    .filter((line) => line.endsWith("(fetch)"))
    .map((line) => {
      const [name, url] = line.split(/\s+/);
      return { name: name!, url: url! };
    });
  return checkBranchAgainstRemote({ git, networkGit: git, remotes });
}

function pushedRepo(name: string): { dir: string; bare: string } {
  const bare = makeBare(root, `${name}-bare`);
  const dir = makeRepo(root, name, bare);
  git(dir, ["checkout", "-q", "-b", "feature/host-chip"]);
  commit(dir, "work");
  git(dir, ["push", "-q", "-u", "origin", "feature/host-chip"]);
  return { dir, bare };
}

describe("checkBranchAgainstRemote", () => {
  it("sees the same tip on the remote", async () => {
    const { dir } = pushedRepo("same");
    const result = await check(dir);
    expect(result.check).toEqual({
      kind: "same-tip",
      remote: "origin",
      sha: git(dir, ["rev-parse", "HEAD"]),
    });
    expect(result.branch).toBe("feature/host-chip");
    expect(result.remoteBranch).toBe("feature/host-chip");
  });

  it("counts unpushed commits", async () => {
    const { dir } = pushedRepo("ahead");
    commit(dir, "one");
    commit(dir, "two");
    expect((await check(dir)).check).toEqual({ kind: "ahead", remote: "origin", ahead: 2 });
  });

  it("fetches a tip it hasn't seen and reports the remote as ahead of it", async () => {
    const { dir, bare } = pushedRepo("behind");
    const other = path.join(root, "behind-other");
    git(root, ["clone", "-q", "-b", "feature/host-chip", bare, other]);
    commit(other, "elsewhere");
    git(other, ["push", "-q", "origin", "feature/host-chip"]);
    const result = await check(dir);
    expect(result.check).toMatchObject({ kind: "behind", remote: "origin", behind: 1 });
  });

  it("sees divergence when both sides have their own commits", async () => {
    const { dir, bare } = pushedRepo("diverged");
    const other = path.join(root, "diverged-other");
    git(root, ["clone", "-q", "-b", "feature/host-chip", bare, other]);
    commit(other, "theirs");
    git(other, ["push", "-q", "origin", "feature/host-chip"]);
    commit(dir, "mine");
    expect((await check(dir)).check).toEqual({ kind: "diverged", remote: "origin" });
  });

  it("names the upstream it found when the remote lacks the branch", async () => {
    const bare = makeBare(root, "missing-bare");
    const dir = makeRepo(root, "missing", bare);
    git(dir, ["checkout", "-q", "-b", "topic"]);
    git(dir, ["config", "branch.topic.remote", "origin"]);
    git(dir, ["config", "branch.topic.merge", "refs/heads/renamed-topic"]);
    const result = await check(dir);
    expect(result.check).toEqual({
      kind: "not-on-remote",
      remote: "origin",
      upstream: "origin/renamed-topic",
    });
    // Checked, and pushed, under its own name only.
    expect(result.remoteBranch).toBe("topic");
    expect(result.pushDestination).toBeNull();
  });

  it("never takes a base-tracking topic's upstream as its remote branch", async () => {
    const bare = makeBare(root, "base-tracking-bare");
    const dir = makeRepo(root, "base-tracking", bare);
    git(dir, ["push", "-q", "origin", "main"]);
    git(dir, ["fetch", "-q", "origin"]);
    git(dir, ["checkout", "-q", "-b", "topic", "origin/main"]);
    commit(dir, "topic work");
    const result = await check(dir);
    expect(result.remoteBranch).toBe("topic");
    expect(result.check).toEqual({
      kind: "not-on-remote",
      remote: "origin",
      upstream: "origin/main",
    });
    // push.default=simple refuses a differently named upstream: no push is offered.
    expect(result.pushDestination).toBeNull();
    expect(result.headSha).toBe(git(dir, ["rev-parse", "HEAD"]));
  });

  it("refuses a push.default=upstream destination that is another branch", async () => {
    const bare = makeBare(root, "upstream-mode-bare");
    const dir = makeRepo(root, "upstream-mode", bare);
    git(dir, ["push", "-q", "origin", "main"]);
    git(dir, ["fetch", "-q", "origin"]);
    git(dir, ["checkout", "-q", "-b", "topic", "origin/main"]);
    git(dir, ["config", "push.default", "upstream"]);
    commit(dir, "topic work");
    const result = await check(dir);
    expect(result.pushDestination).toBeNull();
    expect(result.remoteBranch).toBe("topic");
  });

  it("refuses a base-tracking topic even when push.default=current would push it", async () => {
    const bare = makeBare(root, "current-mode-bare");
    const dir = makeRepo(root, "current-mode", bare);
    git(dir, ["push", "-q", "origin", "main"]);
    git(dir, ["fetch", "-q", "origin"]);
    git(dir, ["checkout", "-q", "-b", "topic", "origin/main"]);
    git(dir, ["config", "push.default", "current"]);
    commit(dir, "topic work");
    expect((await check(dir)).pushDestination).toBeNull();
  });

  it("offers the same-named branch on the only remote for an untracked topic", async () => {
    const bare = makeBare(root, "untracked-bare");
    const dir = makeRepo(root, "untracked", bare);
    git(dir, ["push", "-q", "origin", "main"]);
    git(dir, ["checkout", "-q", "-b", "topic"]);
    commit(dir, "topic work");
    const result = await check(dir);
    expect(result.pushDestination).toEqual({ remote: "origin", branch: "topic" });
    expect(result.check).toEqual({ kind: "not-on-remote", remote: "origin", upstream: null });
  });

  it("follows pushRemote to the fork the branch pushes to", async () => {
    const originBare = makeBare(root, "triangle-origin-bare");
    const forkBare = makeBare(root, "triangle-fork-bare");
    const dir = makeRepo(root, "triangle", originBare);
    git(dir, ["remote", "add", "fork", forkBare]);
    git(dir, ["checkout", "-q", "-b", "topic"]);
    commit(dir, "topic work");
    git(dir, ["config", "branch.topic.pushRemote", "fork"]);
    git(dir, ["config", "push.default", "current"]);
    const result = await check(dir);
    expect(result.pushDestination).toEqual({ remote: "fork", branch: "topic" });
    expect(result.check).toMatchObject({ kind: "not-on-remote", remote: "fork" });
  });

  it("offers no push when several remotes leave the destination ambiguous", async () => {
    const originBare = makeBare(root, "ambiguous-origin-bare");
    const otherBare = makeBare(root, "ambiguous-other-bare");
    const dir = makeRepo(root, "ambiguous", originBare);
    git(dir, ["remote", "add", "other", otherBare]);
    git(dir, ["checkout", "-q", "-b", "topic"]);
    commit(dir, "topic work");
    const result = await check(dir);
    expect(result.pushDestination).toBeNull();
  });

  it("offers no push when push.default=nothing or a push refspec redirects it", async () => {
    const bare = makeBare(root, "configured-away-bare");
    const dir = makeRepo(root, "configured-away", bare);
    git(dir, ["checkout", "-q", "-b", "topic"]);
    commit(dir, "topic work");
    git(dir, ["config", "push.default", "nothing"]);
    expect((await check(dir)).pushDestination).toBeNull();
    git(dir, ["config", "--unset", "push.default"]);
    git(dir, ["config", "remote.origin.push", "refs/heads/topic:refs/for/topic"]);
    expect((await check(dir)).pushDestination).toBeNull();
  });

  it("reports both tips when the branch is ahead", async () => {
    const { dir } = pushedRepo("tips");
    const remoteTip = git(dir, ["rev-parse", "HEAD"]);
    const head = commit(dir, "more");
    const result = await check(dir);
    expect(result.remoteTip).toBe(remoteTip);
    expect(result.headSha).toBe(head);
    expect(result.pushDestination).toEqual({ remote: "origin", branch: "feature/host-chip" });
  });

  it("follows the branch's own remote when it isn't origin", async () => {
    const originBare = makeBare(root, "fork-bare");
    const upstreamBare = makeBare(root, "upstream-bare");
    const dir = makeRepo(root, "fork", originBare);
    git(dir, ["remote", "add", "upstream", upstreamBare]);
    git(dir, ["checkout", "-q", "-b", "fix"]);
    commit(dir, "fix");
    git(dir, ["push", "-q", "-u", "upstream", "fix"]);
    const result = await check(dir);
    expect(result.remote).toBe("upstream");
    expect(result.check).toMatchObject({ kind: "same-tip", remote: "upstream" });
  });

  it("reports an unreachable remote rather than guessing", async () => {
    const dir = makeRepo(root, "unreachable", path.join(root, "does-not-exist.git"));
    git(dir, ["checkout", "-q", "-b", "topic"]);
    expect((await check(dir)).check).toEqual({
      kind: "remote-unreachable",
      remote: "origin",
      detail: null,
    });
  });

  it("has no remote to name for a local-only repository", async () => {
    const dir = makeRepo(root, "local-only");
    expect((await check(dir)).check).toEqual({
      kind: "not-on-remote",
      remote: null,
      upstream: null,
    });
  });

  it("says detached when no branch is checked out", async () => {
    const { dir } = pushedRepo("detached");
    git(dir, ["checkout", "-q", "--detach"]);
    expect((await check(dir)).check).toEqual({ kind: "detached" });
  });
});
