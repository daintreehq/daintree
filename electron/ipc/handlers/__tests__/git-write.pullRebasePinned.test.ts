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

/**
 * One-shot interleavings, each run synchronously inside a real git call: the
 * preview's first `log` returning, and the pull's upstream lookup. They stand
 * in for an agent acting in the worktree mid-read, which is the race the pins
 * exist for.
 */
const hooks = vi.hoisted(() => ({
  afterPreviewLog: null as (() => void) | null,
  duringPullUpstreamLookup: null as (() => void) | null,
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
 * Real git on both sides of the approval (#17188): the preview read and the
 * pull run against the same repository, with the repository moved in between,
 * which is the only way to show what an approved pull actually rebases.
 */
vi.mock("../../../utils/hardenedGit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/hardenedGit.js")>()),
  validateCwd: vi.fn(),
  createHardenedGit: vi.fn(async (cwd: string) => withPreviewLogHook(hermeticSimpleGit(cwd))),
  createAuthenticatedGit: vi.fn(async (cwd: string) =>
    withUpstreamLookupHook(hermeticSimpleGit(cwd))
  ),
  createContinueGit: vi.fn(),
}));

function withPreviewLogHook<T extends { log: (...args: never[]) => unknown }>(client: T): T {
  const log = client.log.bind(client) as (...args: never[]) => Promise<unknown>;
  client.log = (async (...args: never[]) => {
    const result = await log(...args);
    const hook = hooks.afterPreviewLog;
    hooks.afterPreviewLog = null;
    hook?.();
    return result;
  }) as T["log"];
  return client;
}

function withUpstreamLookupHook<T extends { raw: (...args: never[]) => unknown }>(client: T): T {
  const raw = client.raw.bind(client) as (...args: never[]) => Promise<unknown>;
  client.raw = (async (...args: never[]) => {
    const argv = args[0] as unknown;
    if (Array.isArray(argv) && argv[0] === "for-each-ref" && hooks.duringPullUpstreamLookup) {
      const hook = hooks.duringPullUpstreamLookup;
      hooks.duringPullUpstreamLookup = null;
      hook();
    }
    return raw(...args);
  }) as T["raw"];
  return client;
}

import { registerGitWriteHandlers } from "../git-write.js";
import { _resetRateLimitQueuesForTest } from "../../utils.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";

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

function configureIdentity(repo: string): void {
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
}

function commit(repo: string, file: string): string {
  fs.writeFileSync(path.join(repo, file), file);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", file]);
  return git(repo, ["rev-parse", "HEAD"]);
}

let tmpRoot: string;

interface Fixture {
  repo: string;
  /** The commit another clone published to `origin/topic`, already fetched here. */
  incoming: string;
  /** `topic`'s local tip, which a rebase would replay onto `incoming`. */
  local: string;
}

/**
 * `topic` tracking `origin/topic`, one commit ahead of it and one behind: a pull
 * and rebase with exactly one commit to bring in and one to replay.
 */
function makeFixture(): Fixture {
  const bare = fs.mkdtempSync(path.join(tmpRoot, "origin-"));
  git(bare, ["init", "--bare", "-q"]);

  const repo = fs.mkdtempSync(path.join(tmpRoot, "repo-"));
  git(repo, ["init", "-q", "-b", "main"]);
  configureIdentity(repo);
  commit(repo, "base.txt");
  git(repo, ["remote", "add", "origin", bare]);
  git(repo, ["push", "-q", "-u", "origin", "main"]);
  git(repo, ["checkout", "-q", "-b", "topic"]);
  git(repo, ["push", "-q", "-u", "origin", "topic"]);

  const other = fs.mkdtempSync(path.join(tmpRoot, "other-"));
  git(tmpRoot, ["clone", "-q", "-b", "topic", bare, other]);
  configureIdentity(other);
  const incoming = commit(other, "incoming.txt");
  git(other, ["push", "-q", "origin", "topic"]);

  const local = commit(repo, "local.txt");
  git(repo, ["fetch", "-q", "origin"]);
  return { repo, incoming, local };
}

function getHandler(channel: string) {
  const call = ipcMainMock.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
  if (!call) throw new Error(`Handler for ${channel} not registered`);
  return call[1] as (_e: unknown, ...args: unknown[]) => Promise<unknown>;
}

const FAKE_EVENT = { sender: { id: 1 } };

interface RebasePreview {
  headOid: string | null;
  commits: Array<{ hash: string }>;
  behind: number;
}

/** What the confirm reads to show the approver, through the real handler. */
async function preview(cwd: string, branchName: string): Promise<RebasePreview> {
  return (await getHandler("git:list-rebase-commits")(FAKE_EVENT, {
    cwd,
    branchName,
    limit: 20,
  })) as RebasePreview;
}

function pull(cwd: string, pins: Record<string, unknown> = {}): Promise<unknown> {
  return getHandler("git:pull-rebase")(FAKE_EVENT, { cwd, ...pins });
}

async function rejection(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return formatErrorMessage(error, "rejected without a message");
  }
}

function expectStale(error: string | null): void {
  expect(error).toMatch(/\[GitError\|pull-rebase-review-stale\|/);
}

/** Whether `ancestor` is in `HEAD`'s history: the pull brought it in. */
function contains(repo: string, ancestor: string): boolean {
  try {
    git(repo, ["merge-base", "--is-ancestor", ancestor, "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

beforeAll(() => {
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "daintree-pull-pinned-")));
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  hooks.afterPreviewLog = null;
  hooks.duringPullUpstreamLookup = null;
  ipcMainMock.handle.mockClear();
  _resetRateLimitQueuesForTest();
  registerGitWriteHandlers({} as never);
});

describe("git pull --rebase pinned to its preview (#17188)", () => {
  it("previews the commit the branch is on, and rebases it when nothing moved", async () => {
    const { repo, incoming, local } = makeFixture();

    const shown = await preview(repo, "topic");
    expect(shown.headOid).toBe(local);
    expect(shown.behind).toBe(1);

    await pull(repo, { expectedBranch: "topic", expectedHeadOid: shown.headOid });

    expect(contains(repo, incoming)).toBe(true);
    // Replayed, so the local commit sits on top of the incoming one under a new hash.
    expect(git(repo, ["rev-parse", "HEAD"])).not.toBe(local);
    expect(git(repo, ["log", "-1", "--format=%s"])).toBe("local.txt");
  });

  it("refuses when the branch gained a commit after the preview, and rebases nothing", async () => {
    const { repo, incoming } = makeFixture();
    const shown = await preview(repo, "topic");

    // An agent committing into the worktree while the confirm sits open.
    const landed = commit(repo, "agent.txt");

    const error = await rejection(
      pull(repo, { expectedBranch: "topic", expectedHeadOid: shown.headOid })
    );

    expectStale(error);
    expect(error).toMatch(/'topic' moved to a different commit/);
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(landed);
    expect(contains(repo, incoming)).toBe(false);
  });

  it("refuses when the worktree switched to another branch on the same commit", async () => {
    // Every OID check passes here: only the branch name tells the two apart.
    const { repo, local } = makeFixture();
    const shown = await preview(repo, "topic");
    git(repo, ["checkout", "-q", "-b", "elsewhere"]);
    git(repo, ["branch", "-q", "--set-upstream-to=origin/topic"]);

    const error = await rejection(
      pull(repo, { expectedBranch: "topic", expectedHeadOid: shown.headOid })
    );

    expectStale(error);
    expect(error).toMatch(/switched from 'topic' to 'elsewhere'/);
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(local);
  });

  it("reports a switch to a detached HEAD as the switch, not as a missing upstream", async () => {
    const { repo } = makeFixture();
    const shown = await preview(repo, "topic");
    git(repo, ["checkout", "-q", "--detach"]);

    const error = await rejection(
      pull(repo, { expectedBranch: "topic", expectedHeadOid: shown.headOid })
    );

    expectStale(error);
    expect(error).toMatch(/detached HEAD, not 'topic'/);
  });

  it("pins the commit its rows were measured from when the branch moves mid-preview", async () => {
    // Read last, the pin would be the commit that landed mid-read: rows of one
    // commit approved under the name of another, and a pull that passes.
    const { repo, local } = makeFixture();
    let landed = "";
    hooks.afterPreviewLog = () => {
      landed = commit(repo, "agent.txt");
    };

    const shown = await preview(repo, "topic");

    expect(landed).not.toBe("");
    expect(shown.headOid).toBe(local);
    expect(shown.commits.map((c) => c.hash)).not.toContain(landed);
    const error = await rejection(
      pull(repo, { expectedBranch: "topic", expectedHeadOid: shown.headOid })
    );
    expectStale(error);
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(landed);
  });

  it("refuses a switch to another branch on the same commit during the pull's own checks", async () => {
    // Passes the branch check at the start and every commit comparison at the
    // end, so only re-reading the branch beside the commit catches it.
    const { repo, local, incoming } = makeFixture();
    const shown = await preview(repo, "topic");
    hooks.duringPullUpstreamLookup = () => {
      git(repo, ["checkout", "-q", "-b", "elsewhere"]);
    };

    const error = await rejection(
      pull(repo, { expectedBranch: "topic", expectedHeadOid: shown.headOid })
    );

    expectStale(error);
    expect(error).toMatch(/switched from 'topic' to 'elsewhere'/);
    expect(git(repo, ["rev-parse", "elsewhere"])).toBe(local);
    expect(contains(repo, incoming)).toBe(false);
  });

  it("knows the branch when a tag shares its name", async () => {
    // `rev-parse --abbrev-ref HEAD` answers `heads/topic` here, which no
    // preview spells that way: compared as-is it would refuse every time.
    const { repo, incoming } = makeFixture();
    git(repo, ["tag", "topic"]);
    const shown = await preview(repo, "topic");

    await pull(repo, { expectedBranch: "topic", expectedHeadOid: shown.headOid });

    expect(contains(repo, incoming)).toBe(true);
  });

  it("accepts the commit in any case, as it compares the commit rather than the spelling", async () => {
    const { repo, incoming } = makeFixture();
    const shown = await preview(repo, "topic");

    await pull(repo, { expectedBranch: "topic", expectedHeadOid: shown.headOid!.toUpperCase() });

    expect(contains(repo, incoming)).toBe(true);
  });

  it("refuses a half pin rather than enforcing only the half it got", async () => {
    const { repo, incoming, local } = makeFixture();

    for (const pins of [{ expectedBranch: "topic" }, { expectedHeadOid: local }]) {
      const error = await rejection(pull(repo, pins));
      expect(error).toMatch(/Invalid pull and rebase review/);
    }
    expect(contains(repo, incoming)).toBe(false);
  });

  it("refuses a malformed commit rather than reading it as no pin", async () => {
    const { repo, incoming } = makeFixture();

    for (const expectedHeadOid of ["", "abc123", 42]) {
      const error = await rejection(pull(repo, { expectedBranch: "topic", expectedHeadOid }));
      expect(error).toMatch(/Invalid pull and rebase review/);
    }
    expect(contains(repo, incoming)).toBe(false);
  });

  it("still pulls unpinned for a caller no confirm previewed", async () => {
    const { repo, incoming } = makeFixture();
    commit(repo, "agent.txt");

    await pull(repo);

    expect(contains(repo, incoming)).toBe(true);
  });
});
