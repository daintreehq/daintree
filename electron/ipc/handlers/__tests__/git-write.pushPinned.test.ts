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

/** Runs once, synchronously, as the handler calls `push` — after every check. */
const pushHook = vi.hoisted(() => ({ before: null as (() => void) | null }));

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
 * Real git on both sides of the approval: the preview read and the push run
 * against the same repository, with the repository moved in between, which is
 * the only way to show what an approved push actually publishes.
 */
vi.mock("../../../utils/hardenedGit.js", () => ({
  validateCwd: vi.fn(),
  createHardenedGit: vi.fn(async (cwd: string) => hermeticSimpleGit(cwd)),
  createAuthenticatedGit: vi.fn(async (cwd: string) => withPushHook(hermeticSimpleGit(cwd))),
  createContinueGit: vi.fn(),
}));

function withPushHook<T extends { push: (...args: never[]) => unknown }>(client: T): T {
  const push = client.push.bind(client) as (...args: never[]) => unknown;
  client.push = ((...args: never[]) => {
    const hook = pushHook.before;
    pushHook.before = null;
    hook?.();
    return push(...args);
  }) as T["push"];
  return client;
}

import { registerGitWriteHandlers } from "../git-write.js";
import { _resetRateLimitQueuesForTest } from "../../utils.js";

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
  /** `topic` as the remote holds it before any push under test. */
  published: string;
  /** `topic`'s local tip: one commit ahead of `published`. */
  reviewed: string;
}

/**
 * `main` and `topic` published to `origin` and tracking it, `topic` checked
 * out and one commit ahead: a push with exactly one commit to review.
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
  git(repo, ["checkout", "-q", "-b", "topic"]);
  git(repo, ["push", "-q", "-u", "origin", "topic"]);
  const published = git(repo, ["rev-parse", "topic"]);
  const reviewed = commit(repo, "topic.txt");
  return { repo, bare, published, reviewed };
}

function getHandler(channel: string) {
  const call = ipcMainMock.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
  if (!call) throw new Error(`Handler for ${channel} not registered`);
  return call[1] as (_e: unknown, ...args: unknown[]) => Promise<unknown>;
}

const FAKE_EVENT = { sender: { id: 1 } };

interface PushPreview {
  destination: { remote: string; branch: string };
  headOid: string;
  commits: Array<{ hash: string }>;
}

/** What the confirm reads to show the approver, through the real handler. */
async function preview(cwd: string, branchName: string): Promise<PushPreview> {
  return (await getHandler("git:list-push-commits")(FAKE_EVENT, {
    cwd,
    branchName,
    limit: 20,
  })) as PushPreview;
}

/** The approval, carrying exactly what the preview put on screen. */
function approvedPush(
  cwd: string,
  branch: string,
  shown: PushPreview,
  setUpstream?: boolean
): Promise<unknown> {
  return getHandler("git:push")(FAKE_EVENT, {
    cwd,
    ...(setUpstream ? { setUpstream } : {}),
    expectedBranch: branch,
    expectedHeadOid: shown.headOid,
    expectedRemote: shown.destination.remote,
    expectedRemoteBranch: shown.destination.branch,
  });
}

function expectStale(error: string | null): void {
  expect(error).toMatch(/\[GitError\|push-review-stale\|/);
  expect(error).toMatch(/changed since this push was reviewed/);
}

function rejection(promise: Promise<unknown>): Promise<string | null> {
  return promise.then(
    () => null,
    (e: unknown) => String(e)
  );
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "push-pinned-"));
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  pushHook.before = null;
  ipcMainMock.handle.mockClear();
  _resetRateLimitQueuesForTest();
  registerGitWriteHandlers({} as never);
});

describe("approved push — publishes what was reviewed or nothing", () => {
  it("pushes the previewed commit when nothing moved", async () => {
    const fixture = makeFixture();

    const shown = await preview(fixture.repo, "topic");
    expect(shown.headOid).toBe(fixture.reviewed);
    expect(shown.commits.map((c) => c.hash)).toEqual([fixture.reviewed]);

    await approvedPush(fixture.repo, "topic", shown);

    expect(remoteTip(fixture.bare, "refs/heads/topic")).toBe(fixture.reviewed);
    // The remote-tracking ref follows, so the next preview starts from here.
    expect(git(fixture.repo, ["rev-parse", "refs/remotes/origin/topic"])).toBe(fixture.reviewed);
  });

  it("refuses when the branch gained a commit after the preview, and sends nothing", async () => {
    const fixture = makeFixture();

    const shown = await preview(fixture.repo, "topic");
    commit(fixture.repo, "agent.txt");

    const error = await rejection(approvedPush(fixture.repo, "topic", shown));

    expectStale(error);
    expect(remoteTip(fixture.bare, "refs/heads/topic")).toBe(fixture.published);
  });

  it("refuses when another branch was checked out after the preview", async () => {
    const fixture = makeFixture();
    git(fixture.repo, ["checkout", "-q", "-b", "elsewhere"]);
    commit(fixture.repo, "elsewhere.txt");
    git(fixture.repo, ["checkout", "-q", "topic"]);

    const shown = await preview(fixture.repo, "topic");
    git(fixture.repo, ["checkout", "-q", "elsewhere"]);

    const error = await rejection(approvedPush(fixture.repo, "topic", shown));

    expectStale(error);
    expect(remoteTip(fixture.bare, "refs/heads/topic")).toBe(fixture.published);
    expect(remoteTip(fixture.bare, "refs/heads/elsewhere")).toBeNull();
  });

  it("refuses when the branch now pushes to a different destination", async () => {
    const fixture = makeFixture();
    const fork = makeBare("fork");
    git(fixture.repo, ["remote", "add", "fork", fork]);
    // `current` so a pushRemote names a same-name destination git resolves.
    git(fixture.repo, ["config", "push.default", "current"]);

    const shown = await preview(fixture.repo, "topic");
    expect(shown.destination).toEqual({ remote: "origin", branch: "topic" });
    git(fixture.repo, ["config", "branch.topic.pushRemote", "fork"]);

    const error = await rejection(approvedPush(fixture.repo, "topic", shown));

    expectStale(error);
    expect(remoteTip(fork, "refs/heads/topic")).toBeNull();
    expect(remoteTip(fixture.bare, "refs/heads/topic")).toBe(fixture.published);
  });

  it("refuses a switch to another branch sitting on the same commit", async () => {
    // Every OID check passes here; only the branch name tells them apart.
    const fixture = makeFixture();
    const shown = await preview(fixture.repo, "topic");
    git(fixture.repo, ["checkout", "-q", "-b", "twin"]);

    const error = await rejection(approvedPush(fixture.repo, "topic", shown));

    expectStale(error);
    expect(remoteTip(fixture.bare, "refs/heads/topic")).toBe(fixture.published);
    expect(remoteTip(fixture.bare, "refs/heads/twin")).toBeNull();
  });

  it("refuses when the branch was rewritten to a different commit", async () => {
    const fixture = makeFixture();
    const shown = await preview(fixture.repo, "topic");
    git(fixture.repo, ["commit", "-q", "--amend", "-m", "rewritten"]);

    const error = await rejection(approvedPush(fixture.repo, "topic", shown));

    expectStale(error);
    expect(remoteTip(fixture.bare, "refs/heads/topic")).toBe(fixture.published);
  });

  it("refuses when the destination is now another branch on the same remote", async () => {
    const fixture = makeFixture();
    git(fixture.repo, ["push", "-q", "origin", "main:refs/heads/release/topic"]);
    git(fixture.repo, ["fetch", "-q", "origin"]);
    git(fixture.repo, ["config", "push.default", "upstream"]);

    const shown = await preview(fixture.repo, "topic");
    expect(shown.destination).toEqual({ remote: "origin", branch: "topic" });
    git(fixture.repo, ["branch", "-q", "--set-upstream-to=origin/release/topic", "topic"]);
    const releaseBefore = remoteTip(fixture.bare, "refs/heads/release/topic");

    const error = await rejection(approvedPush(fixture.repo, "topic", shown));

    expectStale(error);
    expect(remoteTip(fixture.bare, "refs/heads/release/topic")).toBe(releaseBefore);
    expect(remoteTip(fixture.bare, "refs/heads/topic")).toBe(fixture.published);
  });

  it("refuses when the destination no longer resolves at all", async () => {
    const fixture = makeFixture();
    const shown = await preview(fixture.repo, "topic");
    git(fixture.repo, ["config", "push.default", "nothing"]);

    const error = await rejection(approvedPush(fixture.repo, "topic", shown));

    expectStale(error);
    expect(remoteTip(fixture.bare, "refs/heads/topic")).toBe(fixture.published);
  });

  it("publishes only the reviewed commit when one lands after the final check", async () => {
    const fixture = makeFixture();
    const shown = await preview(fixture.repo, "topic");
    let late: string | null = null;
    pushHook.before = () => {
      late = commit(fixture.repo, "late.txt");
    };

    await approvedPush(fixture.repo, "topic", shown);

    expect(late).not.toBeNull();
    expect(remoteTip(fixture.bare, "refs/heads/topic")).toBe(fixture.reviewed);
    expect(git(fixture.repo, ["rev-parse", "topic"])).toBe(late);
  });

  it("succeeds with nothing to publish when the destination already has the commit", async () => {
    const fixture = makeFixture();
    git(fixture.repo, ["push", "-q", "origin", "topic"]);

    const shown = await preview(fixture.repo, "topic");
    expect(shown.commits).toEqual([]);

    await approvedPush(fixture.repo, "topic", shown);

    expect(remoteTip(fixture.bare, "refs/heads/topic")).toBe(fixture.reviewed);
  });

  it("leaves a remote that advanced to git's own rejection, with the lease captured", async () => {
    const fixture = makeFixture();
    const shown = await preview(fixture.repo, "topic");

    // Someone else publishes to the destination while the dialog is open.
    const other = fs.mkdtempSync(path.join(tmpRoot, "other-"));
    git(other, ["clone", "-q", "-b", "topic", fixture.bare, "."]);
    git(other, ["config", "user.email", "o@example.com"]);
    git(other, ["config", "user.name", "Other"]);
    const theirs = commit(other, "theirs.txt");
    git(other, ["push", "-q", "origin", "topic"]);
    git(fixture.repo, ["fetch", "-q", "origin"]);

    const error = await rejection(approvedPush(fixture.repo, "topic", shown));

    expect(error).toMatch(/\[GitError\|push-rejected-outdated\|/);
    expect(/\[GitError\|[^|]*\|([^|]*)\|/.exec(error ?? "")?.[1]).toBe(theirs);
    expect(remoteTip(fixture.bare, "refs/heads/topic")).toBe(theirs);
  });

  it("leaves a remote that advanced unseen to git's own rejection", async () => {
    // No fetch: the local tracking ref still shows the old tip, so the
    // preview has nothing to warn about and git is the one that notices.
    const fixture = makeFixture();
    const shown = await preview(fixture.repo, "topic");
    const other = fs.mkdtempSync(path.join(tmpRoot, "other-"));
    git(other, ["clone", "-q", "-b", "topic", fixture.bare, "."]);
    git(other, ["config", "user.email", "o@example.com"]);
    git(other, ["config", "user.name", "Other"]);
    const theirs = commit(other, "theirs.txt");
    git(other, ["push", "-q", "origin", "topic"]);

    const error = await rejection(approvedPush(fixture.repo, "topic", shown));

    expect(error).toMatch(/\[GitError\|push-rejected-outdated\|/);
    expect(remoteTip(fixture.bare, "refs/heads/topic")).toBe(theirs);
  });

  it("still establishes tracking for a fresh branch it pushes as a commit", async () => {
    const fixture = makeFixture();
    git(fixture.repo, ["checkout", "-q", "-b", "fresh"]);
    const freshTip = commit(fixture.repo, "fresh.txt");
    expect(upstreamOf(fixture.repo, "fresh")).toBe("");

    const shown = await preview(fixture.repo, "fresh");
    await approvedPush(fixture.repo, "fresh", shown);

    expect(remoteTip(fixture.bare, "refs/heads/fresh")).toBe(freshTip);
    expect(upstreamOf(fixture.repo, "fresh")).toBe("refs/remotes/origin/fresh");
  });

  it("still repairs an upstream that names another branch", async () => {
    const fixture = makeFixture();
    git(fixture.repo, ["checkout", "-q", "-b", "wt", "--track", "origin/main"]);
    const wtTip = commit(fixture.repo, "wt.txt");

    const shown = await preview(fixture.repo, "wt");
    await approvedPush(fixture.repo, "wt", shown);

    expect(remoteTip(fixture.bare, "refs/heads/wt")).toBe(wtTip);
    expect(remoteTip(fixture.bare, "refs/heads/main")).not.toBe(wtTip);
    expect(upstreamOf(fixture.repo, "wt")).toBe("refs/remotes/origin/wt");
  });

  it("replaces an existing upstream when the caller asks for one", async () => {
    const fixture = makeFixture();
    git(fixture.repo, ["push", "-q", "origin", "main:refs/heads/release/topic"]);
    git(fixture.repo, ["fetch", "-q", "origin"]);
    git(fixture.repo, ["config", "push.default", "current"]);
    git(fixture.repo, ["branch", "-q", "--set-upstream-to=origin/release/topic", "topic"]);

    const shown = await preview(fixture.repo, "topic");
    expect(shown.destination).toEqual({ remote: "origin", branch: "topic" });
    await approvedPush(fixture.repo, "topic", shown, true);

    expect(remoteTip(fixture.bare, "refs/heads/topic")).toBe(fixture.reviewed);
    expect(upstreamOf(fixture.repo, "topic")).toBe("refs/remotes/origin/topic");
    expect(git(fixture.repo, ["config", "--get-all", "branch.topic.merge"])).toBe(
      "refs/heads/topic"
    );
  });

  for (const [autoSetupRebase, expected] of [
    ["remote", "true"],
    ["always", "true"],
    ["local", ""],
    [null, ""],
  ] as const) {
    it(`records rebase-on-pull with new tracking as git would (branch.autoSetupRebase=${autoSetupRebase ?? "unset"})`, async () => {
      const fixture = makeFixture();
      git(fixture.repo, ["checkout", "-q", "-b", "fresh"]);
      commit(fixture.repo, "fresh.txt");
      if (autoSetupRebase) git(fixture.repo, ["config", "branch.autoSetupRebase", autoSetupRebase]);

      const shown = await preview(fixture.repo, "fresh");
      await approvedPush(fixture.repo, "fresh", shown);

      expect(upstreamOf(fixture.repo, "fresh")).toBe("refs/remotes/origin/fresh");
      let rebase = "";
      try {
        rebase = git(fixture.repo, ["config", "--get", "branch.fresh.rebase"]);
      } catch {
        // Unset.
      }
      expect(rebase).toBe(expected);
    });
  }

  it("refuses a review missing one of its fields, and pushes nothing", async () => {
    const fixture = makeFixture();
    const shown = await preview(fixture.repo, "topic");

    const error = await rejection(
      getHandler("git:push")(FAKE_EVENT, {
        cwd: fixture.repo,
        expectedBranch: "topic",
        expectedHeadOid: shown.headOid,
        expectedRemote: "origin",
      })
    );

    expect(error).toMatch(/Invalid push review/);
    expect(remoteTip(fixture.bare, "refs/heads/topic")).toBe(fixture.published);
  });

  it("pushes nothing and refuses when a pinned field is malformed", async () => {
    const fixture = makeFixture();

    const error = await rejection(
      getHandler("git:push")(FAKE_EVENT, {
        cwd: fixture.repo,
        expectedBranch: "topic",
        expectedHeadOid: "--force",
        expectedRemote: "origin",
        expectedRemoteBranch: "topic",
      })
    );

    expect(error).toMatch(/Invalid push review/);
    expect(remoteTip(fixture.bare, "refs/heads/topic")).toBe(fixture.published);
  });
});
