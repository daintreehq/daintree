import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
    getAllWindows: vi.fn(() => []),
  },
  webContents: { fromId: vi.fn(() => null) },
}));

vi.mock("../../../store.js", () => ({
  store: { get: vi.fn().mockReturnValue({ uiFeedbackSoundEnabled: false }) },
}));

vi.mock("../../../services/SoundService.js", () => ({
  soundService: { play: vi.fn() },
}));

vi.mock("../../../services/getSoundService.js", () => ({
  getSoundService: vi.fn().mockResolvedValue({ play: vi.fn() }),
}));

/**
 * Real git behind the handler, not a mocked `push()`: the bug is what git does
 * with the argv under a user's push config, which no double can show. The
 * client is hermetic so a developer's own `push.default` can't decide results.
 */
vi.mock("../../../utils/hardenedGit.js", () => ({
  validateCwd: vi.fn(),
  createHardenedGit: vi.fn(async (cwd: string) => hermeticSimpleGit(cwd)),
  createAuthenticatedGit: vi.fn(async (cwd: string) => hermeticSimpleGit(cwd)),
  createContinueGit: vi.fn(),
}));

import { registerGitWriteHandlers } from "../git-write.js";
import { _resetRateLimitQueuesForTest } from "../../utils.js";

/**
 * One environment for the fixture commands and the client under test, built
 * from nothing rather than inherited: a developer's config, a hook's `GIT_DIR`
 * or an injected `GIT_CONFIG_PARAMETERS` must not decide these results.
 */
function hermeticEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: tmpRoot,
    XDG_CONFIG_HOME: tmpRoot,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function hermeticSimpleGit(cwd: string) {
  const env = hermeticEnv();
  return simpleGit(cwd, {
    allowEnvironment: Object.keys(env),
    unsafe: { allowUnsafeConfigPaths: true },
  }).env(env);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: hermeticEnv(), encoding: "utf8" }).trim();
}

function upstreamOf(repo: string, branch: string): string {
  return git(repo, ["for-each-ref", "--format=%(upstream)", `refs/heads/${branch}`]);
}

/** The remote's tip for `ref`, or null when the remote has no such ref. */
function remoteTip(bare: string, ref: string): string | null {
  const out = git(bare, ["for-each-ref", "--format=%(objectname)", ref]);
  return out || null;
}

function commit(repo: string, file: string): string {
  fs.writeFileSync(path.join(repo, file), file);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", file]);
  return git(repo, ["rev-parse", "HEAD"]);
}

let tmpRoot: string;

function makeBare(name = "origin"): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, `${name}-`));
  git(dir, ["init", "--bare", "-q"]);
  return dir;
}

interface Fixture {
  repo: string;
  bare: string;
  /** `other`'s local tip: committed, never pushed. */
  otherLocal: string;
  /** `other` as the remote last saw it. */
  otherRemote: string;
}

/**
 * `main`, `other` and `topic` all published to `origin` and tracking it, then
 * `other` and `topic` each one commit ahead with `topic` checked out — the
 * shape the issue measured. `other`'s commit is the one a wider push leaks.
 */
function makeFixture(): Fixture {
  const bare = makeBare();
  const repo = fs.mkdtempSync(path.join(tmpRoot, "repo-"));
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  commit(repo, "base.txt");
  git(repo, ["remote", "add", "origin", bare]);
  git(repo, ["push", "-q", "-u", "origin", "main"]);
  git(repo, ["checkout", "-q", "-b", "other"]);
  git(repo, ["push", "-q", "-u", "origin", "other"]);
  git(repo, ["checkout", "-q", "-b", "topic", "main"]);
  git(repo, ["push", "-q", "-u", "origin", "topic"]);
  const otherRemote = git(repo, ["rev-parse", "other"]);

  git(repo, ["checkout", "-q", "other"]);
  const otherLocal = commit(repo, "other.txt");
  git(repo, ["checkout", "-q", "topic"]);
  commit(repo, "topic.txt");
  return { repo, bare, otherLocal, otherRemote };
}

function getHandler(channel: string) {
  const call = ipcMainMock.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
  if (!call) throw new Error(`Handler for ${channel} not registered`);
  return call[1] as (_e: unknown, ...args: unknown[]) => Promise<unknown>;
}

const FAKE_EVENT = { sender: { id: 1 } };

function push(cwd: string, setUpstream?: boolean): Promise<unknown> {
  return getHandler("git:push")(FAKE_EVENT, { cwd, ...(setUpstream ? { setUpstream } : {}) });
}

function expectOtherUnpublished(fixture: Fixture): void {
  expect(remoteTip(fixture.bare, "refs/heads/other")).toBe(fixture.otherRemote);
  expect(remoteTip(fixture.bare, "refs/heads/other")).not.toBe(fixture.otherLocal);
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "push-scope-"));
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  ipcMainMock.handle.mockClear();
  _resetRateLimitQueuesForTest();
  registerGitWriteHandlers({} as never);
});

describe("git push — writes only the branch the confirm named", () => {
  it("leaves another ahead branch unpublished under push.default=matching", async () => {
    const fixture = makeFixture();
    git(fixture.repo, ["config", "push.default", "matching"]);

    await push(fixture.repo);

    expect(remoteTip(fixture.bare, "refs/heads/topic")).toBe(
      git(fixture.repo, ["rev-parse", "topic"])
    );
    expectOtherUnpublished(fixture);
  });

  it("leaves another ahead branch unpublished under a wildcard remote push refspec", async () => {
    const fixture = makeFixture();
    git(fixture.repo, ["config", "remote.origin.push", "refs/heads/*:refs/heads/*"]);

    await push(fixture.repo);

    expect(remoteTip(fixture.bare, "refs/heads/topic")).toBe(
      git(fixture.repo, ["rev-parse", "topic"])
    );
    expectOtherUnpublished(fixture);
  });

  it("leaves another ahead branch unpublished when the push also sets upstream", async () => {
    // Untracked, with a push remote git names itself and no auto-setup, so
    // the tracking can only come from the caller's explicit request.
    const fixture = makeFixture();
    git(fixture.repo, ["branch", "-q", "--unset-upstream", "topic"]);
    git(fixture.repo, ["config", "remote.pushDefault", "origin"]);
    git(fixture.repo, ["config", "push.default", "current"]);
    git(fixture.repo, ["config", "remote.origin.push", "refs/heads/*:refs/heads/*"]);
    expect(upstreamOf(fixture.repo, "topic")).toBe("");

    await push(fixture.repo, true);

    expect(remoteTip(fixture.bare, "refs/heads/topic")).toBe(
      git(fixture.repo, ["rev-parse", "topic"])
    );
    expect(upstreamOf(fixture.repo, "topic")).toBe("refs/remotes/origin/topic");
    expectOtherUnpublished(fixture);
  });

  it("refuses a mirror remote rather than mirroring every ref onto it", async () => {
    const fixture = makeFixture();
    const topicBefore = remoteTip(fixture.bare, "refs/heads/topic");
    // A remote-only branch: mirror mode would delete it, since it has no local twin.
    git(fixture.bare, ["branch", "remote-only", "main"]);
    git(fixture.repo, ["config", "remote.origin.mirror", "true"]);

    await expect(push(fixture.repo)).rejects.toThrow(/\[GitError\|push-config-unsupported\|/);

    expect(remoteTip(fixture.bare, "refs/heads/topic")).toBe(topicBefore);
    expect(remoteTip(fixture.bare, "refs/heads/remote-only")).not.toBeNull();
    expectOtherUnpublished(fixture);
  });

  it("sends no annotated tag that push.followTags would add", async () => {
    const fixture = makeFixture();
    git(fixture.repo, ["tag", "-a", "v1", "-m", "v1"]);
    git(fixture.repo, ["config", "push.followTags", "true"]);

    await push(fixture.repo);

    expect(remoteTip(fixture.bare, "refs/heads/topic")).toBe(
      git(fixture.repo, ["rev-parse", "topic"])
    );
    expect(remoteTip(fixture.bare, "refs/tags/v1")).toBeNull();
  });
});

describe("git push — destinations and recoveries keep working", () => {
  for (const pushDefault of [null, "matching"] as const) {
    it(`establishes tracking for a fresh branch with no configuration (push.default=${pushDefault ?? "unset"})`, async () => {
      const fixture = makeFixture();
      git(fixture.repo, ["checkout", "-q", "-b", "fresh"]);
      const freshTip = commit(fixture.repo, "fresh.txt");
      if (pushDefault) git(fixture.repo, ["config", "push.default", pushDefault]);
      expect(upstreamOf(fixture.repo, "fresh")).toBe("");

      await push(fixture.repo);

      expect(remoteTip(fixture.bare, "refs/heads/fresh")).toBe(freshTip);
      expect(upstreamOf(fixture.repo, "fresh")).toBe("refs/remotes/origin/fresh");
      expectOtherUnpublished(fixture);
    });
  }

  for (const autoSetupRemote of [true, false]) {
    it(`tracks a branch git names a push remote for only where push.autoSetupRemote would (${autoSetupRemote})`, async () => {
      // A bare push under these settings tracked the branch itself; the
      // explicit refspec switches git's auto-setup off.
      const fixture = makeFixture();
      git(fixture.repo, ["checkout", "-q", "-b", "fresh"]);
      const freshTip = commit(fixture.repo, "fresh.txt");
      git(fixture.repo, ["config", "remote.pushDefault", "origin"]);
      git(fixture.repo, ["config", "push.default", "current"]);
      git(fixture.repo, ["config", "push.autoSetupRemote", String(autoSetupRemote)]);
      expect(upstreamOf(fixture.repo, "fresh")).toBe("");

      await push(fixture.repo);

      expect(remoteTip(fixture.bare, "refs/heads/fresh")).toBe(freshTip);
      expect(upstreamOf(fixture.repo, "fresh")).toBe(
        autoSetupRemote ? "refs/remotes/origin/fresh" : ""
      );
      expectOtherUnpublished(fixture);
    });
  }

  it("leaves a differently-tracked branch's upstream alone under push.default=current", async () => {
    const fixture = makeFixture();
    git(fixture.repo, ["branch", "-q", "--set-upstream-to=origin/main", "topic"]);
    git(fixture.repo, ["config", "push.default", "current"]);
    git(fixture.repo, ["config", "push.autoSetupRemote", "true"]);

    await push(fixture.repo);

    expect(remoteTip(fixture.bare, "refs/heads/topic")).toBe(
      git(fixture.repo, ["rev-parse", "topic"])
    );
    expect(upstreamOf(fixture.repo, "topic")).toBe("refs/remotes/origin/main");
    expectOtherUnpublished(fixture);
  });

  it("pushes to a differently-named remote branch under push.default=upstream", async () => {
    const fixture = makeFixture();
    git(fixture.repo, ["push", "-q", "origin", "main:refs/heads/release/topic"]);
    git(fixture.repo, ["fetch", "-q", "origin"]);
    git(fixture.repo, ["branch", "-q", "--set-upstream-to=origin/release/topic", "topic"]);
    git(fixture.repo, ["config", "push.default", "upstream"]);
    const topicBefore = remoteTip(fixture.bare, "refs/heads/topic");

    await push(fixture.repo);

    expect(remoteTip(fixture.bare, "refs/heads/release/topic")).toBe(
      git(fixture.repo, ["rev-parse", "topic"])
    );
    expect(remoteTip(fixture.bare, "refs/heads/topic")).toBe(topicBefore);
    expectOtherUnpublished(fixture);
  });

  it("pushes to the branch's pushRemote in a triangular setup, and only that branch", async () => {
    const fixture = makeFixture();
    const fork = makeBare("fork");
    git(fixture.repo, ["remote", "add", "fork", fork]);
    git(fixture.repo, ["config", "branch.topic.pushRemote", "fork"]);
    git(fixture.repo, ["config", "push.default", "matching"]);
    // `other` exists on the fork too, so a matching push would carry it there.
    git(fixture.repo, ["push", "-q", "fork", `${fixture.otherRemote}:refs/heads/other`]);
    const originTopic = remoteTip(fixture.bare, "refs/heads/topic");

    await push(fixture.repo);

    expect(remoteTip(fork, "refs/heads/topic")).toBe(git(fixture.repo, ["rev-parse", "topic"]));
    expect(remoteTip(fork, "refs/heads/other")).toBe(fixture.otherRemote);
    expect(remoteTip(fixture.bare, "refs/heads/topic")).toBe(originTopic);
    // Still pulls from where it did: the push must not re-track it to the fork.
    expect(upstreamOf(fixture.repo, "topic")).toBe("refs/remotes/origin/topic");
  });

  it("repairs a branch whose upstream names another branch, in the same push", async () => {
    const fixture = makeFixture();
    git(fixture.repo, ["checkout", "-q", "-b", "wt", "--track", "origin/main"]);
    const wtTip = commit(fixture.repo, "wt.txt");

    await push(fixture.repo);

    expect(remoteTip(fixture.bare, "refs/heads/wt")).toBe(wtTip);
    expect(remoteTip(fixture.bare, "refs/heads/main")).not.toBe(wtTip);
    expect(upstreamOf(fixture.repo, "wt")).toBe("refs/remotes/origin/wt");
  });

  it("leases against the destination that rejected the push, and force-pushes only it", async () => {
    const fixture = makeFixture();
    git(fixture.repo, ["push", "-q", "origin", "topic"]);
    const published = git(fixture.repo, ["rev-parse", "refs/remotes/origin/topic"]);
    git(fixture.repo, ["commit", "-q", "--amend", "-m", "rewritten"]);
    git(fixture.repo, ["config", "push.default", "matching"]);

    const error = await push(fixture.repo).then(
      () => null,
      (e: unknown) => e
    );

    expect(String(error)).toMatch(/\[GitError\|push-rejected-outdated\|/);
    const lease = /\[GitError\|[^|]*\|([^|]*)\|/.exec(String(error))?.[1];
    expect(lease).toBe(published);
    expect(remoteTip(fixture.bare, "refs/heads/topic")).toBe(published);
    expectOtherUnpublished(fixture);

    await getHandler("git:force-push-with-lease")(FAKE_EVENT, {
      cwd: fixture.repo,
      branchName: "topic",
      leaseSha: lease,
    });

    expect(remoteTip(fixture.bare, "refs/heads/topic")).toBe(
      git(fixture.repo, ["rev-parse", "topic"])
    );
    expectOtherUnpublished(fixture);
  });
});
