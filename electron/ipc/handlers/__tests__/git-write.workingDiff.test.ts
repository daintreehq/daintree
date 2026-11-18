import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import childProcess, { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

// Real git: an unborn branch is a state of the repository, and what the
// handler costs is the processes it starts. simple-git binds `spawn` by name.
const spawned: string[][] = [];
const originalSpawn = childProcess.spawn;

/** The git subcommand, past the `-c key=value` pairs every hardened call leads with. */
function subcommand(args: readonly string[]): string | undefined {
  let i = 0;
  while (args[i] === "-c") i += 2;
  return args[i];
}

// The fixture's own git: nothing inherited from the runner (a hook's
// GIT_INDEX_FILE, a default hash or ref format) may reach the repositories, and
// its messages read as the handler's do. Windows matches env names in any case.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))
  ),
  LC_ALL: "C",
  LANGUAGE: "",
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

/** What git itself says when `git diff HEAD --` fails here, first line. */
function headDiffFailure(cwd: string): string {
  try {
    git(cwd, "diff", "--no-ext-diff", "--no-textconv", "HEAD", "--");
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
    if (stderr) return stderr.split(/\r?\n/)[0];
  }
  throw new Error("expected git diff HEAD to fail with an error");
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

const headDiff = (cwd = repo) =>
  handler(CHANNELS.GIT_GET_WORKING_DIFF)(null, { cwd, type: "head" }) as Promise<string>;

function write(name: string, content: string, cwd = repo): void {
  fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
  fs.writeFileSync(path.join(cwd, name), content);
}

function initRepo(...extra: string[]): void {
  git(tmp, "init", "-q", "-b", "main", ...extra, repo);
}

/** Leaves HEAD's ref in place and takes away the commit it names. */
function deleteHeadCommitObject(): void {
  const oid = git(repo, "rev-parse", "HEAD").trim();
  const object = path.join(repo, ".git", "objects", oid.slice(0, 2), oid.slice(2));
  // Loose objects are read-only, which Windows won't unlink.
  fs.chmodSync(object, 0o644);
  fs.rmSync(object);
}

beforeAll(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "git-write-diff-home-")));
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
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "git-write-diff-")));
  repo = path.join(tmp, "repo");
  return () => fs.rmSync(tmp, { recursive: true, force: true });
});

describe("@diff:head working diff (real git)", () => {
  it("diffs a staged file with further unstaged edits against nothing before the first commit", async () => {
    initRepo();
    write("a.txt", "one\n");
    git(repo, "add", "a.txt");
    write("a.txt", "one\ntwo\n");
    write("untracked.txt", "not in the index\n");

    const diff = await headDiff();

    expect(diff).toContain("diff --git a/a.txt b/a.txt\nnew file mode 100644\n");
    expect(diff).toContain("--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n");
    expect(diff).not.toContain("untracked.txt");
  });

  it("answers no changes when an unborn branch tracks nothing", async () => {
    initRepo();
    write("untracked.txt", "x\n");

    await expect(headDiff()).resolves.toBe("");
  });

  it("diffs against the SHA-256 empty tree in a SHA-256 repository", async () => {
    initRepo("--object-format=sha256");
    write("b.txt", "first\n");
    git(repo, "add", "b.txt");

    const diff = await headDiff();

    expect(diff).toContain("--- /dev/null\n+++ b/b.txt\n@@ -0,0 +1 @@\n+first\n");
  });

  it("diffs a linked worktree's unborn branch against nothing", async () => {
    initRepo();
    write("base.txt", "base\n");
    git(repo, "add", "base.txt");
    git(repo, "commit", "-q", "-m", "base");
    const linked = path.join(tmp, "linked");
    git(repo, "worktree", "add", "-q", "--detach", linked);
    git(linked, "switch", "-q", "--orphan", "fresh");
    write("c.txt", "orphan\n", linked);
    git(linked, "add", "c.txt");

    const diff = await headDiff(linked);

    expect(diff).toContain("--- /dev/null\n+++ b/c.txt\n");
    expect(diff).not.toContain("base.txt");
  });

  it("caps a first commit's diff like any other", async () => {
    initRepo();
    write("big.txt", Array.from({ length: 600 }, (_, i) => `line ${i}\n`).join(""));
    git(repo, "add", "big.txt");

    const diff = await headDiff();

    expect(diff).toContain("--- /dev/null\n+++ b/big.txt\n@@ -0,0 +1,600 @@\n+line 0\n");
    const lines = diff.split("\n");
    expect(lines).toHaveLength(501);
    expect(lines[500]).toMatch(/^\[Diff truncated — showing first 500 of \d+ lines\]$/);
  });

  it("reads a tracked file named HEAD as a path, never as the revision", async () => {
    initRepo();
    write("HEAD", "a file\n");
    git(repo, "add", "HEAD");

    expect(await headDiff()).toContain("--- /dev/null\n+++ b/HEAD\n");

    git(repo, "commit", "-q", "-m", "base");
    write("HEAD", "a file\nedited\n");
    const diff = await headDiff();
    expect(diff).toContain("--- a/HEAD\n+++ b/HEAD\n");
    expect(diff).toContain("+edited\n");
  });

  it("diffs staged and unstaged edits against HEAD in one git process once there is a commit", async () => {
    initRepo();
    write("a.txt", "one\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-q", "-m", "base");
    write("a.txt", "one\nstaged\n");
    git(repo, "add", "a.txt");
    write("a.txt", "one\nstaged\nunstaged\n");

    const mark = spawned.length;
    const diff = await headDiff();

    expect(diff).toContain("--- a/a.txt\n+++ b/a.txt\n");
    expect(diff).toContain(" one\n+staged\n+unstaged\n");
    expect(spawned.slice(mark).map(subcommand)).toEqual(["diff"]);
  });

  it("diffs an unborn branch whose name prefixes an existing branch against nothing", async () => {
    initRepo();
    git(repo, "checkout", "-q", "-b", "main/old");
    write("a.txt", "old\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-q", "-m", "old");
    git(repo, "symbolic-ref", "HEAD", "refs/heads/main");

    const diff = await headDiff();

    expect(diff).toContain("--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1 @@\n+old\n");
  });

  it("reports git's own error when the branch ref is malformed", async () => {
    initRepo();
    write("a.txt", "one\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-q", "-m", "base");
    const loose = path.join(repo, ".git", "refs", "heads", "main");
    // Only the files ref backend can hold a malformed ref.
    expect(fs.existsSync(loose)).toBe(true);
    fs.writeFileSync(loose, "garbage\n");

    await expect(headDiff()).rejects.toThrow(headDiffFailure(repo));
  });

  it("reports git's own error when HEAD's branch names a missing commit", async () => {
    initRepo();
    write("a.txt", "one\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-q", "-m", "base");
    deleteHeadCommitObject();

    await expect(headDiff()).rejects.toThrow(headDiffFailure(repo));
  });

  it("reports git's own error when a detached HEAD names a missing commit", async () => {
    initRepo();
    write("a.txt", "one\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-q", "-m", "base");
    git(repo, "checkout", "-q", "--detach");
    deleteHeadCommitObject();

    await expect(headDiff()).rejects.toThrow(headDiffFailure(repo));
  });
});
