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
// A `git status` that exits non-zero without a word, which the default profile
// would read as an empty, clean status.
const silentStatusFailure = { on: false };

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
    if (silentStatusFailure.on && subcommand(args[1] as string[]) === "status") {
      args = [process.execPath, ["-e", "process.exit(1)"], args[2]];
    }
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
    // The status read finds a staged rename's other half (below).
    expect(spawnedSince(mark).map(subcommand)).toEqual(["status", "reset"]);
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
      expect(spawnedSince(mark).map(subcommand)).toEqual(["status", "reset"]);
    }
  });

  it("unstages several files, and everything, without asking git whether HEAD exists", async () => {
    commitFiles({ "a.txt": "one\n", "b.txt": "one\n" });
    for (const name of ["a.txt", "b.txt"]) fs.writeFileSync(path.join(repo, name), "two\n");
    git(repo, "add", ".");

    let mark = spawned.length;
    await handler(CHANNELS.GIT_UNSTAGE_FILES)(null, { cwd: repo, filePaths: ["a.txt", "b.txt"] });
    expect(git(repo, "diff", "--cached", "--name-only")).toBe("");
    expect(spawnedSince(mark).map(subcommand)).toEqual(["status", "reset"]);

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
      expect(spawnedSince(mark).map(subcommand)).toEqual(["rev-parse", "status", "reset"]);
    } finally {
      vi.useRealTimers();
      stallGitDirRead.on = false;
    }
  });

  it("unstages several files, and everything, on an unborn branch", async () => {
    const names = ["a.txt", "b.txt", "c.txt"];
    for (const name of names) fs.writeFileSync(path.join(repo, name), `${name}\n`);
    git(repo, "add", ".");
    await handler(CHANNELS.GIT_UNSTAGE_FILES)(null, { cwd: repo, filePaths: ["a.txt", "c.txt"] });
    expect(git(repo, "ls-files")).toBe("b.txt\n");

    await handler(CHANNELS.GIT_UNSTAGE_ALL)(null, repo);
    expect(git(repo, "ls-files")).toBe("");
    const left = fs.readdirSync(repo).filter((name) => name !== ".git");
    expect(left.sort()).toEqual(names);
  });

  it("unstages the first file of an unborn branch and leaves it on disk", async () => {
    fs.writeFileSync(path.join(repo, "first.txt"), "first\n");
    await stage("first.txt");
    expect(git(repo, "ls-files")).toBe("first.txt\n");

    await unstage("first.txt");
    expect(git(repo, "ls-files")).toBe("");
    expect(fs.readFileSync(path.join(repo, "first.txt"), "utf8")).toBe("first\n");
  });

  describe("a staged rename", () => {
    const unstageFiles = (filePaths: string[]) =>
      handler(CHANNELS.GIT_UNSTAGE_FILES)(null, { cwd: repo, filePaths });

    /** The index against HEAD with renames split, so each half shows on its own. */
    const cached = () => git(repo, "diff", "--cached", "--name-status", "--no-renames");

    function stageRename(from: string, to: string): void {
      git(repo, "mv", from, to);
      expect(git(repo, "diff", "--cached", "--name-status", "-M").split("\n")).toContain(
        `R100\t${from}\t${to}`
      );
    }

    function expectRenameUnstaged(from: string, to: string, content: string): void {
      const stagedPaths = cached()
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("\t")[1]);
      expect(stagedPaths).not.toContain(from);
      expect(stagedPaths).not.toContain(to);
      expect(fs.readFileSync(path.join(repo, to), "utf8")).toBe(content);
      expect(fs.existsSync(path.join(repo, from))).toBe(false);
    }

    it("unstages both halves when the single-file unstage names the destination", async () => {
      commitFiles({ "original.txt": "keep\n" });
      stageRename("original.txt", "renamed.txt");

      await unstage("renamed.txt");

      expect(cached()).toBe("");
      expectRenameUnstaged("original.txt", "renamed.txt", "keep\n");
    });

    it("unstages both halves when the single-file unstage names the source", async () => {
      commitFiles({ "original.txt": "keep\n" });
      stageRename("original.txt", "renamed.txt");

      await unstage("original.txt");

      expect(cached()).toBe("");
      expectRenameUnstaged("original.txt", "renamed.txt", "keep\n");
    });

    it("unstages a rename with staged and unstaged edits and keeps the newest bytes", async () => {
      commitFiles({ "original.txt": "a\nb\nc\nd\n" });
      git(repo, "mv", "original.txt", "renamed.txt");
      fs.writeFileSync(path.join(repo, "renamed.txt"), "a\nb\nc\nd\ne\n");
      git(repo, "add", "renamed.txt");
      fs.writeFileSync(path.join(repo, "renamed.txt"), "a\nb\nc\nd\ne\nf\n");
      expect(git(repo, "status", "--porcelain=v1")).toBe("RM original.txt -> renamed.txt\n");

      await unstage("renamed.txt");

      expect(cached()).toBe("");
      expectRenameUnstaged("original.txt", "renamed.txt", "a\nb\nc\nd\ne\nf\n");
    });

    it("unstages every rename a multi-file unstage names, by either half, and nothing else", async () => {
      commitFiles({ "one.txt": "1\n", "sub/two.txt": "2\n", "three.txt": "3\n", "p.txt": "a\n" });
      stageRename("one.txt", "uno.txt");
      stageRename("sub/two.txt", "dos.txt");
      stageRename("three.txt", "tres.txt");
      fs.writeFileSync(path.join(repo, "p.txt"), "b\n");
      git(repo, "add", "p.txt");

      await unstageFiles(["uno.txt", "sub/two.txt", "p.txt"]);

      expectRenameUnstaged("one.txt", "uno.txt", "1\n");
      expectRenameUnstaged("sub/two.txt", "dos.txt", "2\n");
      expect(fs.readFileSync(path.join(repo, "p.txt"), "utf8")).toBe("b\n");
      expect(cached()).toBe("D\tthree.txt\nA\ttres.txt\n");
    });

    it("leaves a copy's source staged", async () => {
      commitFiles({ "a.txt": "1\n2\n3\n4\n" });
      git(repo, "config", "status.renames", "copies");
      fs.copyFileSync(path.join(repo, "a.txt"), path.join(repo, "b.txt"));
      fs.writeFileSync(path.join(repo, "a.txt"), "1\n2\n3\n4\n5\n");
      git(repo, "add", ".");
      expect(git(repo, "status", "--porcelain=v1")).toBe("M  a.txt\nC  a.txt -> b.txt\n");

      await unstage("b.txt");

      expect(cached()).toBe("M\ta.txt\n");
    });

    it("leaves a staged rename alone when unstaging the file its destination moved to", async () => {
      commitFiles({ "a.txt": "one\ntwo\nthree\n" });
      stageRename("a.txt", "b.txt");
      fs.renameSync(path.join(repo, "b.txt"), path.join(repo, "c.txt"));
      git(repo, "add", "-N", "c.txt");
      expect(git(repo, "status", "--porcelain=v1")).toBe("R  a.txt -> b.txt\n R b.txt -> c.txt\n");

      await unstage("c.txt");

      expect(cached()).toBe("D\ta.txt\nA\tb.txt\n");
    });

    it("unstages a source whose name is a glob without widening to the names it matches", async () => {
      commitFiles({ "[draft].md": "x\n", "d.md": "d\n" });
      stageRename("[draft].md", "final.md");
      fs.writeFileSync(path.join(repo, "d.md"), "d2\n");
      git(repo, "add", "d.md");

      await unstageFiles(["final.md"]);

      expectRenameUnstaged("[draft].md", "final.md", "x\n");
      expect(cached()).toBe("M\td.md\n");
    });

    it("pairs the halves the way status does, not diff", async () => {
      commitFiles({ "one.txt": "1\n", "two.txt": "2\n" });
      stageRename("one.txt", "uno.txt");
      git(repo, "config", "diff.renames", "false");
      git(repo, "config", "status.renames", "true");

      await unstage("uno.txt");
      expectRenameUnstaged("one.txt", "uno.txt", "1\n");

      // Shown as two rows, a deletion and an addition, each unstages alone.
      git(repo, "config", "status.renames", "false");
      stageRename("two.txt", "dos.txt");
      await unstage("dos.txt");
      expect(cached()).toBe("D\ttwo.txt\n");
    });

    it("refuses before resetting anything when the status read fails silently", async () => {
      commitFiles({ "original.txt": "keep\n" });
      stageRename("original.txt", "renamed.txt");

      silentStatusFailure.on = true;
      try {
        const mark = spawned.length;
        await expect(unstage("renamed.txt")).rejects.toThrow(/exited with 1 and no error output/);
        expect(spawnedSince(mark).map(subcommand)).toEqual(["status"]);
      } finally {
        silentStatusFailure.on = false;
      }

      expect(cached()).toBe("D\toriginal.txt\nA\trenamed.txt\n");
    });
  });

  describe("a selection longer than the Windows command line", () => {
    // Windows caps a whole command line at 32,767 characters.
    const WINDOWS_COMMAND_LINE_MAX = 32_767;
    // Glob, magic, option and quoting lookalikes, each a literal filename here.
    const unusual = [
      "é space.txt",
      "[...slug].tsx",
      "-leading-dash.txt",
      ":leading-colon.txt",
      "star*.txt",
      ...(process.platform === "win32" ? [] : ["new\nline.txt", 'quote".txt']),
    ];
    // Unselected files a glob or prefix reading of the selection would catch.
    const decoys = ["s.tsx", "star-decoy.txt", "leading-colon.txt"];

    function longSelection(): string[] {
      const dir = `nested/${"d".repeat(40)}`;
      const names = Array.from(
        { length: 420 },
        (_, i) => `${dir}/${"f".repeat(40)}-${String(i).padStart(4, "0")}.txt`
      );
      return [...names, ...unusual];
    }

    function writeAll(names: readonly string[], content: string): void {
      for (const name of names) {
        fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
        fs.writeFileSync(path.join(repo, name), content);
      }
    }

    function indexed(...args: string[]): string[] {
      return git(repo, ...args, "-z")
        .split("\0")
        .filter(Boolean)
        .sort();
    }

    function expectEveryCommandLineFits(commands: string[][]): void {
      expect(commands.length).toBeGreaterThan(0);
      for (const args of commands) {
        expect(args.join(" ").length).toBeLessThan(WINDOWS_COMMAND_LINE_MAX);
      }
    }

    it("stages exactly the selected paths", async () => {
      commitFiles({ "keep.txt": "base\n" });
      const selection = longSelection();
      expect(selection.join(" ").length).toBeGreaterThan(WINDOWS_COMMAND_LINE_MAX);
      writeAll([...selection, ...decoys], "new\n");

      const mark = spawned.length;
      await handler(CHANNELS.GIT_STAGE_FILES)(null, { cwd: repo, filePaths: selection });

      expect(indexed("diff", "--cached", "--name-only")).toEqual([...selection].sort());
      expectEveryCommandLineFits(spawnedSince(mark));
    });

    it("unstages exactly the selected paths", async () => {
      const selection = longSelection();
      writeAll([...selection, ...decoys], "base\n");
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "base");
      writeAll([...selection, ...decoys], "changed\n");
      git(repo, "add", ".");

      const mark = spawned.length;
      await handler(CHANNELS.GIT_UNSTAGE_FILES)(null, { cwd: repo, filePaths: selection });

      expect(indexed("diff", "--cached", "--name-only")).toEqual([...decoys].sort());
      expectEveryCommandLineFits(spawnedSince(mark));
    });

    it("unstages exactly the selected paths on an unborn branch", async () => {
      const selection = longSelection();
      writeAll([...selection, ...decoys], "new\n");
      git(repo, "add", ".");

      const mark = spawned.length;
      await handler(CHANNELS.GIT_UNSTAGE_FILES)(null, { cwd: repo, filePaths: selection });

      expect(indexed("ls-files")).toEqual([...decoys].sort());
      expect(fs.existsSync(path.join(repo, selection[0]!))).toBe(true);
      expectEveryCommandLineFits(spawnedSince(mark));
    });
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
