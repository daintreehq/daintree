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
    expect(result.remoteBranch).toBe("renamed-topic");
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
