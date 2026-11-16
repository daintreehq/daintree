import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import childProcess, { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StagingStatus } from "../../../../shared/types/git.js";

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

// A git dir read that never settles, as on a stalled network mount.
const stallGitDirRead = vi.hoisted(() => ({ on: false }));

vi.mock("../../../utils/gitUtils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../utils/gitUtils.js")>();
  return {
    ...actual,
    resolveGitDirFromFs: (cwd: string) =>
      stallGitDirRead.on ? new Promise<never>(() => {}) : actual.resolveGitDirFromFs(cwd),
  };
});

// Real git: what these handlers cost is the processes they start, which only a
// real repository and the real spawn can show. simple-git binds `spawn` by name.
const spawned: string[][] = [];
const originalSpawn = childProcess.spawn;

/** The git subcommand, past the `-c key=value` pairs every hardened call leads with. */
function subcommand(args: readonly string[]): string | undefined {
  let i = 0;
  while (args[i] === "-c") i += 2;
  return args[i];
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.test",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.test",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
}

let tmp: string;
let repo: string;
let home: string;
const savedEnv: Record<string, string | undefined> = {};
let CHANNELS: typeof import("../../channels.js").CHANNELS;
let resetRateLimits: () => void;

function handler(channel: string) {
  const call = ipcMainMock.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
  if (!call) throw new Error(`Handler for ${channel} not registered`);
  return call[1] as (_e: unknown, ...args: unknown[]) => Promise<unknown>;
}

const stage = (filePath: string) => handler(CHANNELS.GIT_STAGE_FILE)(null, { cwd: repo, filePath });
const unstage = (filePath: string) =>
  handler(CHANNELS.GIT_UNSTAGE_FILE)(null, { cwd: repo, filePath });
const stagingStatus = () =>
  handler(CHANNELS.GIT_GET_STAGING_STATUS)(null, repo) as Promise<StagingStatus>;

function spawnedSince(mark: number): string[][] {
  return spawned.slice(mark);
}

beforeAll(async () => {
  // The handlers' git reads the user's global config, which the hardened env
  // can't redirect: give it a home of the test's own and no system file.
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "git-write-staging-home-")));
  for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "GIT_CONFIG_NOSYSTEM"]) {
    savedEnv[key] = process.env[key];
  }
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  (childProcess as { spawn: typeof originalSpawn }).spawn = ((...args: unknown[]) => {
    if (Array.isArray(args[1])) spawned.push(args[1] as string[]);
    return (originalSpawn as (...a: unknown[]) => ReturnType<typeof originalSpawn>)(...args);
  }) as typeof originalSpawn;
  syncBuiltinESMExports();

  ({ CHANNELS } = await import("../../channels.js"));
  ({ _resetRateLimitQueuesForTest: resetRateLimits } = await import("../../utils.js"));
  const { registerGitWriteHandlers } = await import("../git-write.js");
  registerGitWriteHandlers({} as never);
});

afterAll(() => {
  (childProcess as { spawn: typeof originalSpawn }).spawn = originalSpawn;
  syncBuiltinESMExports();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  resetRateLimits();
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "git-write-staging-")));
  repo = path.join(tmp, "repo");
  git(tmp, "init", "-q", "-b", "main", repo);
  return () => fs.rmSync(tmp, { recursive: true, force: true });
});

function commitFiles(files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    fs.writeFileSync(path.join(repo, name), content);
  }
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
}

describe("git-write staging handlers (real git)", () => {
  it("unstages a file without asking git whether HEAD exists", async () => {
    commitFiles({ "a.txt": "one\n" });
    fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
    await stage("a.txt");
    expect(git(repo, "diff", "--cached", "--name-only")).toBe("a.txt\n");

    const mark = spawned.length;
    await unstage("a.txt");
    expect(git(repo, "diff", "--cached", "--name-only")).toBe("");
    expect(spawnedSince(mark).map(subcommand)).toEqual(["reset"]);
  });

  it("unstages from a packed HEAD and a linked worktree's HEAD the same way", async () => {
    commitFiles({ "a.txt": "one\n" });
    git(repo, "pack-refs", "--all");
    git(repo, "worktree", "add", "-q", "-b", "side", path.join(tmp, "linked"));
    for (const cwd of [repo, path.join(tmp, "linked")]) {
      fs.writeFileSync(path.join(cwd, "a.txt"), `${cwd}\n`);
      git(cwd, "add", "a.txt");
      const mark = spawned.length;
      await handler(CHANNELS.GIT_UNSTAGE_FILE)(null, { cwd, filePath: "a.txt" });
      expect(git(cwd, "diff", "--cached", "--name-only")).toBe("");
      expect(spawnedSince(mark).map(subcommand)).toEqual(["reset"]);
    }
  });

  it("unstages several files, and everything, without asking git whether HEAD exists", async () => {
    commitFiles({ "a.txt": "one\n", "b.txt": "one\n" });
    for (const name of ["a.txt", "b.txt"]) fs.writeFileSync(path.join(repo, name), "two\n");
    git(repo, "add", ".");

    let mark = spawned.length;
    await handler(CHANNELS.GIT_UNSTAGE_FILES)(null, { cwd: repo, filePaths: ["a.txt", "b.txt"] });
    expect(git(repo, "diff", "--cached", "--name-only")).toBe("");
    expect(spawnedSince(mark).map(subcommand)).toEqual(["reset"]);

    git(repo, "add", ".");
    mark = spawned.length;
    await handler(CHANNELS.GIT_UNSTAGE_ALL)(null, repo);
    expect(git(repo, "diff", "--cached", "--name-only")).toBe("");
    expect(spawnedSince(mark).map(subcommand)).toEqual(["reset"]);
  });

  it("asks git once reading HEAD from the git dir stalls", async () => {
    commitFiles({ "a.txt": "one\n" });
    fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
    git(repo, "add", "a.txt");

    stallGitDirRead.on = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const mark = spawned.length;
      const run = unstage("a.txt");
      await vi.advanceTimersByTimeAsync(5_000);
      vi.useRealTimers();
      await run;
      expect(git(repo, "diff", "--cached", "--name-only")).toBe("");
      expect(spawnedSince(mark).map(subcommand)).toEqual(["rev-parse", "reset"]);
    } finally {
      vi.useRealTimers();
      stallGitDirRead.on = false;
    }
  });

  it("unstages several files, and everything, on an unborn branch", async () => {
    for (const name of ["a.txt", "b.txt"]) fs.writeFileSync(path.join(repo, name), `${name}\n`);
    git(repo, "add", ".");
    await handler(CHANNELS.GIT_UNSTAGE_FILES)(null, { cwd: repo, filePaths: ["a.txt"] });
    expect(git(repo, "ls-files")).toBe("b.txt\n");

    await handler(CHANNELS.GIT_UNSTAGE_ALL)(null, repo);
    expect(git(repo, "ls-files")).toBe("");
    expect(
      fs
        .readdirSync(repo)
        .filter((name) => name !== ".git")
        .sort()
    ).toEqual(["a.txt", "b.txt"]);
  });

  it("unstages the first file of an unborn branch and leaves it on disk", async () => {
    fs.writeFileSync(path.join(repo, "first.txt"), "first\n");
    await stage("first.txt");
    expect(git(repo, "ls-files")).toBe("first.txt\n");

    await unstage("first.txt");
    expect(git(repo, "ls-files")).toBe("");
    expect(fs.readFileSync(path.join(repo, "first.txt"), "utf8")).toBe("first\n");
  });

  it("reads churn by exact path, with no root probe and no config read", async () => {
    commitFiles({ "é space.txt": "a\nb\n", "sub/ünïcode.txt": "x\n" });
    git(repo, "remote", "add", "origin", path.join(tmp, "origin.git"));
    git(repo, "checkout", "-q", "-b", "topic");
    git(repo, "config", "push.default", "current");
    git(repo, "config", "push.autoSetupRemote", "true");
    fs.writeFileSync(path.join(repo, "é space.txt"), "a\nb\nc\n");
    git(repo, "add", "é space.txt");
    fs.writeFileSync(path.join(repo, "é space.txt"), "a\nc\nd\ne\n");
    fs.writeFileSync(path.join(repo, "sub/ünïcode.txt"), "y\n");

    const mark = spawned.length;
    const status = await stagingStatus();

    expect(status.staged).toEqual([
      { path: "é space.txt", status: "modified", insertions: 1, deletions: 0 },
    ]);
    expect(status.unstaged).toEqual(
      expect.arrayContaining([
        { path: "é space.txt", status: "modified", insertions: 2, deletions: 1 },
        { path: "sub/ünïcode.txt", status: "modified", insertions: 1, deletions: 1 },
      ])
    );
    expect(status.pushDestination).toEqual({ remote: "origin", branch: "topic" });
    const commands = spawnedSince(mark);
    expect(commands.filter((args) => args.includes("--show-toplevel"))).toEqual([]);
    expect(commands.filter((args) => subcommand(args) === "config")).toEqual([]);
  });
});
