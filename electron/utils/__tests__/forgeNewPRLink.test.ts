import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import { deriveNewPRLink, type NewPRLinkInput } from "../forgeNewPRLink.js";

/**
 * Real git, as in `gitPushDestination.test.ts`: which ref git keeps, what a
 * remote answers and how a push config resolves are git's to say, and a double
 * would only restate this file's idea of them.
 */
const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
}

function client(repo: string) {
  return simpleGit(repo, {
    allowEnvironment: Object.keys(GIT_ENV),
    unsafe: { allowUnsafeConfigPaths: true },
  }).env(GIT_ENV);
}

let tmpRoot: string;
let counter = 0;

function makeBare(): string {
  const dir = path.join(tmpRoot, `bare-${++counter}.git`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "--bare", "-q", "-b", "main"]);
  return dir;
}

/** A repo with `main` and `develop` on `origin`, standing on an unpushed `topic`. */
function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "repo-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(dir, "f.txt"), "x");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  git(dir, ["branch", "develop"]);
  git(dir, ["remote", "add", "origin", makeBare()]);
  git(dir, ["push", "-q", "origin", "main", "develop"]);
  git(dir, ["checkout", "-q", "-b", "topic"]);
  return dir;
}

function derive(repo: string, overrides: Partial<NewPRLinkInput> = {}) {
  const buildUrl = vi.fn(
    (refs: { base: string; head: string }): string | null =>
      `https://forge.test/compare/${refs.base}...${refs.head}`
  );
  const openNetworkGit = vi.fn(async () => client(repo));
  const answer = deriveNewPRLink({
    git: client(repo),
    openNetworkGit,
    forgeRemote: "origin",
    head: "topic",
    baseRef: "origin/develop",
    isMainWorktree: false,
    buildUrl,
    ...overrides,
  });
  return { answer, buildUrl, openNetworkGit };
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forge-new-pr-link-"));
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("deriveNewPRLink", () => {
  describe("whether the branch is pushed", () => {
    it("links a pushed branch from its tracking ref, without asking the network", async () => {
      const repo = makeRepo();
      git(repo, ["push", "-q", "-u", "origin", "topic"]);

      const { answer, buildUrl, openNetworkGit } = derive(repo);

      await expect(answer).resolves.toEqual({
        state: "ready",
        url: "https://forge.test/compare/develop...topic",
      });
      expect(buildUrl).toHaveBeenCalledWith({ base: "develop", head: "topic" });
      expect(openNetworkGit).not.toHaveBeenCalled();
    });

    it("links a branch the remote has even when no local ref records it", async () => {
      const repo = makeRepo();
      git(repo, ["push", "-q", "origin", "topic"]);
      git(repo, ["update-ref", "-d", "refs/remotes/origin/topic"]);

      const { answer, openNetworkGit } = derive(repo);

      await expect(answer).resolves.toMatchObject({ state: "ready" });
      expect(openNetworkGit).toHaveBeenCalledTimes(1);
    });

    it("says unpushed once the remote answers that it has no such branch", async () => {
      const { answer, buildUrl } = derive(makeRepo());

      await expect(answer).resolves.toEqual({ state: "unpushed" });
      expect(buildUrl).not.toHaveBeenCalled();
    });

    it("says unpushed for a branch that only tracks a remote which has since lost it", async () => {
      const repo = makeRepo();
      git(repo, ["push", "-q", "-u", "origin", "topic"]);
      git(repo, ["push", "-q", "origin", "--delete", "topic"]);

      // `push --delete` drops the tracking ref too, which leaves only the config.
      await expect(derive(repo).answer).resolves.toEqual({ state: "unpushed" });
    });

    it("never reads an unreachable remote as unpushed", async () => {
      const repo = makeRepo();
      git(repo, ["remote", "set-url", "origin", path.join(tmpRoot, "gone.git")]);

      await expect(derive(repo).answer).resolves.toEqual({ state: "unavailable" });
    });

    it("has nothing to offer for a branch git has no record of", async () => {
      await expect(derive(makeRepo(), { head: "never-created" }).answer).resolves.toEqual({
        state: "unavailable",
      });
    });
  });

  describe("which branch the link names as its head", () => {
    it("uses the branch's name on the remote when a push config renames it", async () => {
      const repo = makeRepo();
      git(repo, ["push", "-q", "origin", "topic:renamed"]);
      git(repo, ["config", "push.default", "upstream"]);
      git(repo, ["branch", "--set-upstream-to=origin/renamed", "topic"]);

      const { answer, buildUrl } = derive(repo);

      await expect(answer).resolves.toMatchObject({ state: "ready" });
      expect(buildUrl).toHaveBeenCalledWith({ base: "develop", head: "renamed" });
    });

    it("asks the forge's remote about a fresh branch in a repo with several remotes", async () => {
      const repo = makeRepo();
      git(repo, ["remote", "add", "fork", makeBare()]);

      await expect(derive(repo).answer).resolves.toEqual({ state: "unpushed" });

      git(repo, ["push", "-q", "origin", "topic"]);
      await expect(derive(repo).answer).resolves.toMatchObject({ state: "ready" });
    });

    it("won't call a branch unpushed when a ref shows it went to another remote", async () => {
      const repo = makeRepo();
      git(repo, ["remote", "add", "fork", makeBare()]);
      git(repo, ["push", "-q", "fork", "topic"]);

      const { answer, openNetworkGit } = derive(repo);

      await expect(answer).resolves.toEqual({ state: "unavailable" });
      expect(openNetworkGit).not.toHaveBeenCalled();
    });

    it("offers nothing for a branch that pushes to a different repository", async () => {
      const repo = makeRepo();
      git(repo, ["remote", "add", "fork", makeBare()]);
      git(repo, ["push", "-q", "-u", "fork", "topic"]);

      const { answer, buildUrl } = derive(repo);

      await expect(answer).resolves.toEqual({ state: "unavailable" });
      expect(buildUrl).not.toHaveBeenCalled();
    });
  });

  describe("which branch the link targets", () => {
    function pushedRepo(): string {
      const repo = makeRepo();
      git(repo, ["push", "-q", "-u", "origin", "topic"]);
      return repo;
    }

    it("targets the base the worktree measured itself against", async () => {
      const { answer, buildUrl } = derive(pushedRepo(), { baseRef: "origin/develop" });

      await expect(answer).resolves.toMatchObject({ state: "ready" });
      expect(buildUrl).toHaveBeenCalledWith({ base: "develop", head: "topic" });
    });

    it("uses the base's name on the remote, not a local name for it", async () => {
      const { answer, buildUrl } = derive(pushedRepo(), { baseRef: "origin/release/1.0" });

      await expect(answer).resolves.toMatchObject({ state: "ready" });
      expect(buildUrl).toHaveBeenCalledWith({ base: "release/1.0", head: "topic" });
    });

    it("offers nothing when the base was only found locally", async () => {
      const { answer, buildUrl } = derive(pushedRepo(), { baseRef: "develop" });

      await expect(answer).resolves.toEqual({ state: "unavailable" });
      expect(buildUrl).not.toHaveBeenCalled();
    });

    it("offers nothing when the base was measured on another repository", async () => {
      const repo = pushedRepo();
      git(repo, ["remote", "add", "upstream", makeBare()]);

      const { answer, buildUrl } = derive(repo, { baseRef: "upstream/develop" });

      await expect(answer).resolves.toEqual({ state: "unavailable" });
      expect(buildUrl).not.toHaveBeenCalled();
    });

    it("targets the remote's own default branch from the main worktree", async () => {
      const repo = pushedRepo();
      git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);

      const { answer, buildUrl } = derive(repo, { baseRef: null, isMainWorktree: true });

      await expect(answer).resolves.toMatchObject({ state: "ready" });
      expect(buildUrl).toHaveBeenCalledWith({ base: "main", head: "topic" });
    });

    it("never falls back to the default on a linked worktree whose base failed", async () => {
      const repo = pushedRepo();
      git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);

      const { answer, buildUrl } = derive(repo, { baseRef: null, isMainWorktree: false });

      await expect(answer).resolves.toEqual({ state: "unavailable" });
      expect(buildUrl).not.toHaveBeenCalled();
    });

    it("never guesses a target when git has no record of the remote's default", async () => {
      const { answer, buildUrl } = derive(pushedRepo(), { baseRef: null, isMainWorktree: true });

      await expect(answer).resolves.toEqual({ state: "unavailable" });
      expect(buildUrl).not.toHaveBeenCalled();
    });

    it("offers nothing on the base branch itself", async () => {
      const repo = makeRepo();
      git(repo, ["checkout", "-q", "main"]);
      git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);

      const { answer, buildUrl } = derive(repo, {
        head: "main",
        baseRef: null,
        isMainWorktree: true,
      });

      await expect(answer).resolves.toEqual({ state: "unavailable" });
      expect(buildUrl).not.toHaveBeenCalled();
    });

    it("offers nothing when the provider can't build a URL it may open", async () => {
      const { answer } = derive(pushedRepo(), { buildUrl: () => null });

      await expect(answer).resolves.toEqual({ state: "unavailable" });
    });
  });
});
