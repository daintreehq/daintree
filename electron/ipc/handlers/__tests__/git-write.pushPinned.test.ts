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

/**
 * Each runs once, synchronously: `before` just ahead of `git commit` (after every
 * check), `after` the moment it returns, before anything reads it back.
 */
const commitHook = vi.hoisted(() => ({
  before: null as (() => void) | null,
  after: null as (() => void) | null,
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
 * Real git on both sides of the approval: the preview read and the push run
 * against the same repository, with the repository moved in between, which is
 * the only way to show what an approved push actually publishes.
 */
// The rest stays real: the commit's conflict scan reads staged blobs through
// a raw spawn that takes its env and config from here.
vi.mock("../../../utils/hardenedGit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/hardenedGit.js")>()),
  validateCwd: vi.fn(),
  createHardenedGit: vi.fn(async (cwd: string) => withCommitHook(hermeticSimpleGit(cwd))),
  createAuthenticatedGit: vi.fn(async (cwd: string) => withPushHook(hermeticSimpleGit(cwd))),
  createContinueGit: vi.fn(),
}));

function withCommitHook<T extends { commit: (...args: never[]) => unknown }>(client: T): T {
  const commit = client.commit.bind(client) as (...args: never[]) => Promise<unknown>;
  client.commit = (async (...args: never[]) => {
    const before = commitHook.before;
    commitHook.before = null;
    before?.();
    const result = await commit(...args);
    const hook = commitHook.after;
    commitHook.after = null;
    hook?.();
    return result;
  }) as T["commit"];
  return client;
}

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

// Real reads, spied so a test can show which operations never take them.
vi.mock("../../../services/git/stagedSnapshot.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../services/git/stagedSnapshot.js")>();
  return {
    readStagedSnapshot: vi.fn(real.readStagedSnapshot),
    readCommitStagedIdentity: vi.fn(real.readCommitStagedIdentity),
  };
});

import { registerGitWriteHandlers } from "../git-write.js";
import {
  readCommitStagedIdentity,
  readStagedSnapshot,
} from "../../../services/git/stagedSnapshot.js";
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
  staged?: { identity: string; paths: string[] };
}

/** What the confirm reads to show the approver, through the real handler. */
async function preview(
  cwd: string,
  branchName: string,
  options: { includeStaged?: boolean } = {}
): Promise<PushPreview> {
  return (await getHandler("git:list-push-commits")(FAKE_EVENT, {
    cwd,
    branchName,
    limit: 20,
    ...options,
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
  commitHook.before = null;
  commitHook.after = null;
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

  it("refuses a switch to another branch at the same commit, going to the same destination", async () => {
    // `twin` sits on the reviewed commit and pushes to `origin/topic`, so the
    // tip and destination checks both pass: only the branch name tells them
    // apart, and a push of the reviewed commit there would publish exactly
    // what was shown, under a branch nobody approved pushing.
    const fixture = makeFixture();
    git(fixture.repo, ["config", "push.default", "upstream"]);
    const shown = await preview(fixture.repo, "topic");
    git(fixture.repo, ["checkout", "-q", "-b", "twin"]);
    git(fixture.repo, ["branch", "-q", "--set-upstream-to=origin/topic", "twin"]);
    expect(await preview(fixture.repo, "twin")).toMatchObject({
      destination: shown.destination,
      headOid: shown.headOid,
    });

    const error = await rejection(approvedPush(fixture.repo, "topic", shown));

    expectStale(error);
    expect(error).toMatch(/switched from 'topic' to 'twin'/);
    expect(remoteTip(fixture.bare, "refs/heads/topic")).toBe(fixture.published);
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

  it("runs a push with nothing to publish, and still records the tracking it establishes", async () => {
    // Untracked, so the destination is the single remote's same-name branch and
    // the push has to write tracking even though it transfers no commits.
    const fixture = makeFixture();
    git(fixture.repo, ["push", "-q", "origin", "topic"]);
    git(fixture.repo, ["branch", "-q", "--unset-upstream", "topic"]);

    const shown = await preview(fixture.repo, "topic");
    expect(shown.commits).toEqual([]);
    let pushed = false;
    pushHook.before = () => {
      pushed = true;
    };

    await approvedPush(fixture.repo, "topic", shown);

    expect(pushed).toBe(true);
    expect(remoteTip(fixture.bare, "refs/heads/topic")).toBe(fixture.reviewed);
    expect(upstreamOf(fixture.repo, "topic")).toBe("refs/remotes/origin/topic");
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
    // A second merge value, so only a replacement (not a plain set) leaves one.
    git(fixture.repo, ["config", "--add", "branch.topic.merge", "refs/heads/elsewhere"]);

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

  for (const missing of [
    "expectedBranch",
    "expectedHeadOid",
    "expectedRemote",
    "expectedRemoteBranch",
  ] as const) {
    it(`refuses a review without ${missing}, and pushes nothing`, async () => {
      const fixture = makeFixture();
      const shown = await preview(fixture.repo, "topic");
      const review: Record<string, string> = {
        expectedBranch: "topic",
        expectedHeadOid: shown.headOid,
        expectedRemote: "origin",
        expectedRemoteBranch: "topic",
      };
      delete review[missing];

      const error = await rejection(
        getHandler("git:push")(FAKE_EVENT, { cwd: fixture.repo, ...review })
      );

      expect(error).toMatch(/Invalid push review/);
      expect(remoteTip(fixture.bare, "refs/heads/topic")).toBe(fixture.published);
    });
  }

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

describe("commit then push — pinned to the commit just made (#16790)", () => {
  interface Committed {
    hash: string;
    oid: string | null;
    parentOids: string[];
  }

  function stage(repo: string, file: string): void {
    fs.writeFileSync(path.join(repo, file), file);
    git(repo, ["add", file]);
  }

  async function commitThroughHandler(repo: string, message: string): Promise<Committed> {
    return (await getHandler("git:commit")(FAKE_EVENT, { cwd: repo, message })) as Committed;
  }

  /** The push the hub runs after its commit, pinned to what the commit reported. */
  function pushCommitted(
    repo: string,
    branch: string,
    oid: string,
    destination: { remote: string; branch: string }
  ): Promise<unknown> {
    return getHandler("git:push")(FAKE_EVENT, {
      cwd: repo,
      expectedBranch: branch,
      expectedHeadOid: oid,
      expectedRemote: destination.remote,
      expectedRemoteBranch: destination.branch,
    });
  }

  it("reports the commit it made, not one an agent lands before it is read back", async () => {
    const fixture = makeFixture();
    stage(fixture.repo, "user.txt");
    let userCommit = "";
    commitHook.after = () => {
      userCommit = git(fixture.repo, ["rev-parse", "HEAD"]);
      commit(fixture.repo, "agent.txt");
    };

    const committed = await commitThroughHandler(fixture.repo, "user change");

    expect(committed.oid).toBe(userCommit);
    expect(committed.oid).not.toBe(git(fixture.repo, ["rev-parse", "HEAD"]));
    expect(committed.oid?.startsWith(committed.hash)).toBe(true);
    expect(committed.parentOids).toEqual([fixture.reviewed]);
  });

  it("reports no parent for a root commit", async () => {
    const repo = fs.mkdtempSync(path.join(tmpRoot, "root-"));
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    stage(repo, "first.txt");

    const committed = await commitThroughHandler(repo, "first");

    expect(committed.oid).toBe(git(repo, ["rev-parse", "HEAD"]));
    expect(committed.parentOids).toEqual([]);
  });

  it("reports every parent of a merge commit, the branch tip first", async () => {
    const fixture = makeFixture();
    git(fixture.repo, ["checkout", "-q", "-b", "side", fixture.published]);
    const side = commit(fixture.repo, "side.txt");
    git(fixture.repo, ["checkout", "-q", "topic"]);
    git(fixture.repo, ["merge", "-q", "--no-ff", "--no-commit", "side"]);

    const committed = await commitThroughHandler(fixture.repo, "merge side");

    expect(committed.parentOids).toEqual([fixture.reviewed, side]);
  });

  it("refuses a retry after an agent commit lands on top, and publishes nothing", async () => {
    const fixture = makeFixture();
    stage(fixture.repo, "user.txt");
    const committed = await commitThroughHandler(fixture.repo, "user change");
    const destination = { remote: "origin", branch: "topic" };

    // The first attempt fails before reaching the remote, as an outage would.
    const away = `${fixture.bare}-away`;
    fs.renameSync(fixture.bare, away);
    const failed = await rejection(
      pushCommitted(fixture.repo, "topic", committed.oid!, destination)
    );
    expect(failed).not.toBeNull();
    expect(failed).not.toMatch(/push-review-stale/);
    fs.renameSync(away, fixture.bare);

    // An agent commits while the user deals with it, then Retry runs the same push.
    commit(fixture.repo, "agent.txt");
    const error = await rejection(
      pushCommitted(fixture.repo, "topic", committed.oid!, destination)
    );

    expectStale(error);
    expect(remoteTip(fixture.bare, "refs/heads/topic")).toBe(fixture.published);
  });

  it("publishes exactly the commit it made when nothing moved", async () => {
    const fixture = makeFixture();
    stage(fixture.repo, "user.txt");
    const committed = await commitThroughHandler(fixture.repo, "user change");

    await pushCommitted(fixture.repo, "topic", committed.oid!, {
      remote: "origin",
      branch: "topic",
    });

    expect(remoteTip(fixture.bare, "refs/heads/topic")).toBe(committed.oid);
  });
});

// Review Hub's Commit & push on a branch with no commit yet (#17588): git names
// no destination before the first commit, so the commit lands first and the
// push is previewed and approved through the same handlers as any other.
describe("first commit, then its reviewed push (#17588)", () => {
  function unbornRepo(bare: string): string {
    const repo = fs.mkdtempSync(path.join(tmpRoot, "unborn-"));
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    git(repo, ["remote", "add", "origin", bare]);
    fs.writeFileSync(path.join(repo, "README.md"), "first\n");
    git(repo, ["add", "README.md"]);
    return repo;
  }

  async function commitFirst(repo: string): Promise<{ oid: string | null; parentOids: string[] }> {
    return (await getHandler("git:commit")(FAKE_EVENT, {
      cwd: repo,
      message: "Initial commit",
    })) as { oid: string | null; parentOids: string[] };
  }

  it("previews the root commit as creating the branch, and publishes exactly it", async () => {
    const bare = makeBare();
    const repo = unbornRepo(bare);

    const committed = await commitFirst(repo);
    expect(committed.parentOids).toEqual([]);
    const shown = (await preview(repo, "main")) as PushPreview & { rangeBasis: string };

    expect(shown.destination).toEqual({ remote: "origin", branch: "main" });
    expect(shown.rangeBasis).toBe("creates");
    expect(shown.headOid).toBe(committed.oid);
    expect(shown.commits.map((c) => c.hash)).toEqual([committed.oid]);

    await approvedPush(repo, "main", shown);

    expect(remoteTip(bare, "refs/heads/main")).toBe(committed.oid);
    expect(upstreamOf(repo, "main")).toBe("refs/remotes/origin/main");
  });

  it("leaves a remote branch with other history to git's own refusal", async () => {
    const bare = makeBare();
    const other = fs.mkdtempSync(path.join(tmpRoot, "other-"));
    git(other, ["init", "-q", "-b", "main"]);
    git(other, ["config", "user.email", "test@example.com"]);
    git(other, ["config", "user.name", "Test"]);
    const existing = commit(other, "theirs.txt");
    git(other, ["push", "-q", bare, "main"]);
    const repo = unbornRepo(bare);

    await commitFirst(repo);
    const shown = (await preview(repo, "main")) as PushPreview & { rangeBasis: string };

    // The remote named a tip this repository has never fetched: no claim that
    // the branch is being created, and none that it is level.
    expect(shown.rangeBasis).toBe("unverified");
    const error = await rejection(approvedPush(repo, "main", shown));

    expect(error).toMatch(/\[GitError\|push-rejected-outdated\|/);
    expect(remoteTip(bare, "refs/heads/main")).toBe(existing);
  });
});

describe("commit & push — held to the staged changes its confirm listed (#17563)", () => {
  interface ReviewedCommit {
    oid: string | null;
    parentOids: string[];
    stagedIdentity?: string | null;
  }

  function stageText(repo: string, file: string, text: string): void {
    fs.writeFileSync(path.join(repo, file), text);
    git(repo, ["add", file]);
  }

  /** The confirm's read: the push range plus what is staged on the same tip. */
  async function reviewCommit(repo: string, branch: string) {
    const shown = await preview(repo, branch, { includeStaged: true });
    if (!shown.staged) throw new Error("preview carried no staged snapshot");
    return { shown, staged: shown.staged };
  }

  function commitAsReviewed(
    repo: string,
    branch: string,
    shown: PushPreview,
    message = "user change"
  ): Promise<ReviewedCommit> {
    return getHandler("git:commit")(FAKE_EVENT, {
      cwd: repo,
      message,
      expectedBranch: branch,
      expectedHeadOid: shown.headOid,
      expectedStagedIdentity: shown.staged?.identity,
    }) as Promise<ReviewedCommit>;
  }

  /** The refusal as main throws it: its reason, and the sentence the composer shows. */
  function refusal(
    promise: Promise<unknown>
  ): Promise<{ reason?: string; message: string } | null> {
    return promise.then(
      () => null,
      (e: { reason?: string; message: string }) => ({ reason: e.reason, message: e.message })
    );
  }

  function expectCommitStale(error: { reason?: string; message: string } | null): void {
    expect(error?.reason).toBe("commit-review-stale");
    // Plain prose: the preload adds the one wire prefix the renderer strips.
    expect(error?.message).toMatch(/^This commit changed after it was reviewed: /);
    expect(error?.message).toMatch(/Nothing was committed or pushed/);
  }

  it("refuses a content-only restage under the same branch, tip and file list, and commits nothing", async () => {
    const fixture = makeFixture();
    stageText(fixture.repo, "user.txt", "reviewed text\n");
    const { shown, staged } = await reviewCommit(fixture.repo, "topic");
    expect(staged.paths).toEqual(["user.txt"]);

    // An agent restages the listed file while the confirm is open.
    stageText(fixture.repo, "user.txt", "different text\n");
    const now = await reviewCommit(fixture.repo, "topic");
    expect(now.shown.headOid).toBe(shown.headOid);
    expect(now.staged.paths).toEqual(staged.paths);
    expect(now.staged.identity).not.toBe(staged.identity);

    const error = await refusal(commitAsReviewed(fixture.repo, "topic", shown));

    expectCommitStale(error);
    expect(error?.message).toMatch(/the staged changes are different/);
    expect(git(fixture.repo, ["rev-parse", "HEAD"])).toBe(fixture.reviewed);
    expect(git(fixture.repo, ["show", ":user.txt"])).toBe("different text");
  });

  it("commits what was listed and reports the same identity back", async () => {
    const fixture = makeFixture();
    stageText(fixture.repo, "user.txt", "reviewed text\n");
    // A mode-only change and an intent-to-add file: neither may make the
    // index's identity and the commit's disagree.
    git(fixture.repo, ["update-index", "--chmod=+x", "topic.txt"]);
    fs.writeFileSync(path.join(fixture.repo, "later.txt"), "not staged");
    git(fixture.repo, ["add", "-N", "later.txt"]);
    const { shown, staged } = await reviewCommit(fixture.repo, "topic");
    expect(staged.paths).toEqual(["topic.txt", "user.txt"]);

    const committed = await commitAsReviewed(fixture.repo, "topic", shown);

    expect(committed.parentOids).toEqual([fixture.reviewed]);
    expect(committed.stagedIdentity).toBe(staged.identity);
    expect(git(fixture.repo, ["show", `${committed.oid}:user.txt`])).toBe("reviewed text");
  });

  it("reports what the commit holds when the index changes after the final check", async () => {
    const fixture = makeFixture();
    stageText(fixture.repo, "user.txt", "reviewed text\n");
    const { shown, staged } = await reviewCommit(fixture.repo, "topic");
    commitHook.before = () => stageText(fixture.repo, "user.txt", "different text\n");
    // Put the reviewed contents back in the index once the commit is made, so
    // only a read of the commit itself, never of the index, can tell them apart.
    commitHook.after = () => stageText(fixture.repo, "user.txt", "reviewed text\n");

    const committed = await commitAsReviewed(fixture.repo, "topic", shown);

    expect(git(fixture.repo, ["show", `${committed.oid}:user.txt`])).toBe("different text");
    expect(committed.parentOids).toEqual([fixture.reviewed]);
    expect(committed.stagedIdentity).toEqual(expect.any(String));
    expect(committed.stagedIdentity).not.toBe(staged.identity);
  });

  it("vouches for nothing when a replace ref hides the commit's real parent", async () => {
    const fixture = makeFixture();
    stageText(fixture.repo, "user.txt", "reviewed text\n");
    const { shown, staged } = await reviewCommit(fixture.repo, "topic");
    // After every check, an agent lands an empty commit, so the user's commit
    // sits on it with exactly the reviewed contents; then a replace ref
    // presents the reviewed tip as its parent.
    commitHook.before = () => {
      // Empty, and made without touching the index the user staged.
      const tree = git(fixture.repo, ["rev-parse", "HEAD^{tree}"]);
      const agent = git(fixture.repo, ["commit-tree", tree, "-p", "HEAD", "-m", "agent"]);
      git(fixture.repo, ["update-ref", "refs/heads/topic", agent]);
    };
    commitHook.after = () => {
      const made = git(fixture.repo, ["rev-parse", "HEAD"]);
      git(fixture.repo, ["replace", "--graft", made, fixture.reviewed]);
    };

    const committed = await commitAsReviewed(fixture.repo, "topic", shown);

    expect(committed.parentOids).toEqual([fixture.reviewed]);
    expect(git(fixture.repo, ["--no-replace-objects", "rev-parse", `${committed.oid}^`])).not.toBe(
      fixture.reviewed
    );
    expect(staged.identity).toEqual(expect.any(String));
    expect(committed.stagedIdentity).toBeNull();
  });

  it("refuses when the branch gained a commit while the confirm was open", async () => {
    const fixture = makeFixture();
    stageText(fixture.repo, "user.txt", "reviewed text\n");
    const { shown } = await reviewCommit(fixture.repo, "topic");
    // An agent commits something else, leaving the user's file staged.
    fs.writeFileSync(path.join(fixture.repo, "agent.txt"), "agent");
    git(fixture.repo, ["add", "agent.txt"]);
    git(fixture.repo, ["commit", "-q", "-m", "agent", "--", "agent.txt"]);
    const agentTip = git(fixture.repo, ["rev-parse", "HEAD"]);

    const error = await refusal(commitAsReviewed(fixture.repo, "topic", shown));

    expectCommitStale(error);
    expect(error?.message).toMatch(/'topic' moved to a different commit/);
    expect(git(fixture.repo, ["rev-parse", "HEAD"])).toBe(agentTip);
  });

  it("refuses a switch to another branch at the same commit with the same changes staged", async () => {
    const fixture = makeFixture();
    stageText(fixture.repo, "user.txt", "reviewed text\n");
    const { shown } = await reviewCommit(fixture.repo, "topic");
    git(fixture.repo, ["checkout", "-q", "-b", "twin"]);

    const error = await refusal(commitAsReviewed(fixture.repo, "topic", shown));

    expectCommitStale(error);
    expect(error?.message).toMatch(/switched from 'topic' to 'twin'/);
    expect(git(fixture.repo, ["rev-parse", "twin"])).toBe(fixture.reviewed);
  });

  it.each([
    ["the staged identity", { expectedStagedIdentity: undefined }],
    ["the branch", { expectedBranch: undefined }],
    ["the tip", { expectedHeadOid: undefined }],
    ["a well-formed staged identity", { expectedStagedIdentity: "not-an-identity" }],
    ["a lowercase staged identity", { expectedStagedIdentity: "E".repeat(64) }],
  ])("refuses a review without %s, and commits nothing", async (_label, override) => {
    const fixture = makeFixture();
    stageText(fixture.repo, "user.txt", "reviewed text\n");
    const { shown, staged } = await reviewCommit(fixture.repo, "topic");

    const error = await rejection(
      getHandler("git:commit")(FAKE_EVENT, {
        cwd: fixture.repo,
        message: "user change",
        expectedBranch: "topic",
        expectedHeadOid: shown.headOid,
        expectedStagedIdentity: staged.identity,
        ...override,
      })
    );

    expect(error).toMatch(/Invalid commit review/);
    expect(git(fixture.repo, ["rev-parse", "HEAD"])).toBe(fixture.reviewed);
  });

  it("reads nothing staged unless asked, and reports no identity for an unreviewed commit", async () => {
    const fixture = makeFixture();
    stageText(fixture.repo, "user.txt", "reviewed text\n");
    vi.mocked(readStagedSnapshot).mockClear();
    vi.mocked(readCommitStagedIdentity).mockClear();

    const shown = await preview(fixture.repo, "topic");
    const committed = (await getHandler("git:commit")(FAKE_EVENT, {
      cwd: fixture.repo,
      message: "plain commit",
    })) as ReviewedCommit;

    expect(shown.staged).toBeUndefined();
    expect("stagedIdentity" in committed).toBe(false);
    expect(readStagedSnapshot).not.toHaveBeenCalled();
    expect(readCommitStagedIdentity).not.toHaveBeenCalled();
  });

  it("won't describe another branch's index as staged on the named one", async () => {
    const fixture = makeFixture();
    git(fixture.repo, ["checkout", "-q", "-b", "twin", fixture.published]);
    vi.mocked(readStagedSnapshot).mockClear();

    const error = await refusal(preview(fixture.repo, "topic", { includeStaged: true }));

    expect(error?.reason).toBe("commit-review-stale");
    expect(error?.message).toMatch(/switched from 'topic' to 'twin'/);
    expect(readStagedSnapshot).not.toHaveBeenCalled();
  });

  it("agrees with the commit about a change inside a collapsed sparse directory", async () => {
    const fixture = makeFixture();
    fs.mkdirSync(path.join(fixture.repo, "in"));
    fs.mkdirSync(path.join(fixture.repo, "out", "deep"), { recursive: true });
    fs.writeFileSync(path.join(fixture.repo, "in", "a.txt"), "a");
    fs.writeFileSync(path.join(fixture.repo, "out", "deep", "b.txt"), "b");
    git(fixture.repo, ["add", "."]);
    git(fixture.repo, ["commit", "-q", "-m", "tree"]);
    fs.writeFileSync(path.join(fixture.repo, "out", "deep", "b.txt"), "b2");
    git(fixture.repo, ["commit", "-q", "-am", "deep change"]);
    git(fixture.repo, ["sparse-checkout", "set", "--cone", "--sparse-index", "in"]);
    // The out-of-cone change is now staged inside the index's one `out/` entry.
    git(fixture.repo, ["reset", "-q", "--soft", "HEAD^"]);
    const tip = git(fixture.repo, ["rev-parse", "HEAD"]);
    expect(git(fixture.repo, ["ls-files", "--sparse"])).toMatch(/^out\/$/m);

    const { shown, staged } = await reviewCommit(fixture.repo, "topic");
    const committed = await commitAsReviewed(fixture.repo, "topic", shown);

    expect(staged.paths).toEqual(["out/deep/b.txt"]);
    expect(committed.parentOids).toEqual([tip]);
    expect(committed.stagedIdentity).toBe(staged.identity);
  });
});
