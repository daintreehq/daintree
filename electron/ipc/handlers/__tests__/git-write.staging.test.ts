import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import childProcess, { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RepoOperationPin, StagingStatus } from "../../../../shared/types/git.js";

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
const stallGitDirRead = vi.hoisted(() => ({ onProbe: null as (() => void) | null }));
// A git dir read that fails outright, which proves nothing about HEAD either.
const failGitDirRead = vi.hoisted(() => ({ on: false }));
// A `rev-parse` that exits non-zero with nothing on stderr, as a killed one can.
const silentRevParseFailure = { on: false };

vi.mock("../../../utils/gitUtils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../utils/gitUtils.js")>();
  return {
    ...actual,
    resolveGitDirFromFs: (cwd: string) => {
      if (failGitDirRead.on) return Promise.reject(new Error("git dir unreadable"));
      if (!stallGitDirRead.onProbe) return actual.resolveGitDirFromFs(cwd);
      stallGitDirRead.onProbe();
      return new Promise<never>(() => {});
    },
  };
});

// Real git: what these handlers cost is the processes they start, which only a
// real repository and the real spawn can show. simple-git binds `spawn` by name.
const spawned: string[][] = [];
const originalSpawn = childProcess.spawn;
// A `git status` that exits non-zero without a word, which the default profile
// would read as an empty, clean status.
const silentStatusFailure = { on: false };
/** Runs once, synchronously, as the next `git status` is spawned. */
let duringNextStatus: (() => void) | null = null;

/** The git subcommand, past the `-c key=value` pairs every hardened call leads with. */
function subcommand(args: readonly string[]): string | undefined {
  let i = 0;
  while (args[i] === "-c") i += 2;
  return args[i];
}

// Inherited GIT_* (a hook's GIT_DIR or GIT_INDEX_FILE) would point fixture git
// at another repository, while the hardened handlers strip them.
const GIT_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
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
let batchPathsForArgv: typeof import("../../../utils/git.js").batchPathsForArgv;
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
    if (Array.isArray(args[1])) {
      spawned.push(args[1] as string[]);
      if (duringNextStatus && subcommand(args[1] as string[]) === "status") {
        const run = duringNextStatus;
        duringNextStatus = null;
        run();
      }
    }
    if (silentStatusFailure.on && subcommand(args[1] as string[]) === "status") {
      args = [process.execPath, ["-e", "process.exit(1)"], args[2]];
    }
    if (silentRevParseFailure.on && subcommand(args[1] as string[]) === "rev-parse") {
      return originalSpawn(process.execPath, ["-e", "process.exit(1)"], args[2] as never);
    }
    return (originalSpawn as (...a: unknown[]) => ReturnType<typeof originalSpawn>)(...args);
  }) as typeof originalSpawn;
  syncBuiltinESMExports();

  ({ CHANNELS } = await import("../../channels.js"));
  ({ batchPathsForArgv } = await import("../../../utils/git.js"));
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

afterEach(() => {
  stallGitDirRead.onProbe = null;
  vi.useRealTimers();
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

    const probeStarted = new Promise<void>((resolve) => {
      stallGitDirRead.onProbe = resolve;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const mark = spawned.length;
    const run = unstage("a.txt");

    // The handler does asynchronous work before it arms the HEAD deadline.
    await Promise.race([probeStarted, run]);
    await vi.advanceTimersByTimeAsync(5_000);
    vi.useRealTimers();
    await run;

    expect(git(repo, "diff", "--cached", "--name-only")).toBe("");
    expect(spawnedSince(mark).map(subcommand)).toEqual(["rev-parse", "status", "reset"]);
  });

  it("reads a probe that fails silently as a commit, so several files unstage without a deletion", async () => {
    commitFiles({ "a.txt": "one\n", "b.txt": "one\n" });
    for (const name of ["a.txt", "b.txt"]) fs.writeFileSync(path.join(repo, name), "two\n");
    git(repo, "add", ".");

    failGitDirRead.on = true;
    silentRevParseFailure.on = true;
    try {
      const mark = spawned.length;
      await handler(CHANNELS.GIT_UNSTAGE_FILES)(null, { cwd: repo, filePaths: ["a.txt", "b.txt"] });
      expect(spawnedSince(mark).map(subcommand)).toEqual(["rev-parse", "status", "reset"]);
      expect(git(repo, "diff", "--cached", "--name-only")).toBe("");
      expect(git(repo, "ls-files")).toBe("a.txt\nb.txt\n");
    } finally {
      failGitDirRead.on = false;
      silentRevParseFailure.on = false;
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
      ...(process.platform === "win32"
        ? []
        : [":leading-colon.txt", "star*.txt", "new\nline.txt", 'quote".txt']),
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

    // Each argument as Windows may quote it, after room for the executable's
    // own path at the longest a classic Windows path runs.
    function windowsCommandLineLength(args: readonly string[]): number {
      return args.reduce((sum, arg) => sum + arg.length + 3, 260);
    }

    function expectEveryCommandLineFits(commands: string[][]): void {
      expect(commands.length).toBeGreaterThan(0);
      for (const args of commands) {
        expect(windowsCommandLineLength(args)).toBeLessThan(WINDOWS_COMMAND_LINE_MAX);
      }
    }

    async function rejection(run: Promise<unknown>): Promise<Error> {
      const error = await run.then(
        () => null,
        (err: unknown) => err
      );
      if (!(error instanceof Error)) throw new Error("expected the write to fail");
      return error;
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

    it("unstages both halves of a staged rename in one batch", async () => {
      const selection = longSelection();
      writeAll(selection, "base\n");
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "base");
      writeAll(selection.slice(1), "changed\n");
      git(repo, "add", ".");
      const from = selection[0]!;
      const to = `${from}.moved`;
      git(repo, "mv", from, to);
      expect(git(repo, "status", "--porcelain=v1", "--", from, to)).toContain("R  ");

      const mark = spawned.length;
      // The rename's row goes by its destination, and its source isn't asked for.
      await handler(CHANNELS.GIT_UNSTAGE_FILES)(null, {
        cwd: repo,
        filePaths: [to, ...selection.slice(1)],
      });

      expect(indexed("diff", "--cached", "--name-only")).toEqual([]);
      const resets = spawnedSince(mark).filter((args) => subcommand(args) === "reset");
      expect(resets.length).toBeGreaterThanOrEqual(3);
      const withRename = resets.filter((args) => args.includes(to));
      expect(withRename).toHaveLength(1);
      expect(withRename[0]).toContain(from);
      expectEveryCommandLineFits(resets);
    });

    it("says how many paths were staged when a later batch fails", async () => {
      commitFiles({ "keep.txt": "base\n" });
      const selection = longSelection();
      const batches = batchPathsForArgv(selection);
      expect(batches.length).toBeGreaterThanOrEqual(3);
      const missing = batches[1]![0]!;
      writeAll(
        selection.filter((name) => name !== missing),
        "new\n"
      );

      const mark = spawned.length;
      const error = await rejection(
        handler(CHANNELS.GIT_STAGE_FILES)(null, { cwd: repo, filePaths: selection })
      );

      expect(error.message).toMatch(
        new RegExp(
          `^Staged at least ${batches[0]!.length} of ${selection.length} files before Git stopped: `
        )
      );
      expect(error.message).toContain("did not match any files");
      expect(indexed("diff", "--cached", "--name-only")).toEqual([...batches[0]!].sort());
      expect(spawnedSince(mark).filter((args) => subcommand(args) === "add")).toHaveLength(2);

      // The same selection again, once the missing file exists, stages it all.
      writeAll([missing], "new\n");
      await handler(CHANNELS.GIT_STAGE_FILES)(null, { cwd: repo, filePaths: selection });
      expect(indexed("diff", "--cached", "--name-only")).toEqual([...selection].sort());
    });

    it("claims no more than git confirmed when a failed add still stages part of its batch", async () => {
      commitFiles({ "keep.txt": "base\n" });
      const selection = longSelection();
      const batches = batchPathsForArgv(selection);
      expect(batches.length).toBeGreaterThanOrEqual(3);
      writeAll(selection, "new\n");
      // An ignored path makes `add` stage the rest of its batch and exit 1.
      const ignored = batches[1]![0]!;
      fs.writeFileSync(path.join(repo, ".git", "info", "exclude"), `/${ignored}\n`);

      const error = await rejection(
        handler(CHANNELS.GIT_STAGE_FILES)(null, { cwd: repo, filePaths: selection })
      );

      expect(error.message).toMatch(
        new RegExp(
          `^Staged at least ${batches[0]!.length} of ${selection.length} files before Git stopped: `
        )
      );
      const staged = indexed("diff", "--cached", "--name-only");
      expect(staged).toEqual([...batches[0]!, ...batches[1]!.slice(1)].sort());
    });

    it("runs overlapping writes to one worktree one after the other", async () => {
      const selection = longSelection();
      const batchCount = batchPathsForArgv(selection).length;
      expect(batchCount).toBeGreaterThanOrEqual(3);
      writeAll(selection, "base\n");
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "base");
      writeAll(selection, "changed\n");

      const mark = spawned.length;
      await Promise.all([
        handler(CHANNELS.GIT_STAGE_FILES)(null, { cwd: repo, filePaths: selection }),
        handler(CHANNELS.GIT_UNSTAGE_FILES)(null, { cwd: repo, filePaths: selection }),
      ]);

      const writes = spawnedSince(mark)
        .map(subcommand)
        .filter((command) => command === "add" || command === "reset");
      const run = (command: string) => Array<string>(batchCount).fill(command);
      const stagedFirst = writes[0] === "add";
      expect(writes).toEqual(
        stagedFirst ? [...run("add"), ...run("reset")] : [...run("reset"), ...run("add")]
      );
      expect(indexed("diff", "--cached", "--name-only")).toEqual(
        stagedFirst ? [] : [...selection].sort()
      );
    });

    it("passes a first-batch failure through unchanged, with nothing staged", async () => {
      commitFiles({ "keep.txt": "base\n" });
      const selection = longSelection();
      const missing = selection[0]!;
      writeAll(selection.slice(1), "new\n");

      const error = await rejection(
        handler(CHANNELS.GIT_STAGE_FILES)(null, { cwd: repo, filePaths: selection })
      );

      expect(error.message).not.toContain("before Git stopped");
      expect(error.message).toContain(`pathspec '${missing}' did not match any files`);
      expect(indexed("diff", "--cached", "--name-only")).toEqual([]);
    });

    it("says how many paths were unstaged on an unborn branch, and replays the whole selection", async () => {
      const selection = longSelection();
      const batches = batchPathsForArgv(selection);
      expect(batches.length).toBeGreaterThanOrEqual(3);
      writeAll(selection, "indexed\n");
      git(repo, "add", ".");
      // Staged content that differs from both the file and HEAD: `rm --cached`
      // refuses it, and with it the whole batch it rides in.
      const refused = batches[1]![0]!;
      writeAll([refused], "edited\n");

      const error = await rejection(
        handler(CHANNELS.GIT_UNSTAGE_FILES)(null, { cwd: repo, filePaths: selection })
      );

      expect(error.message).toMatch(
        new RegExp(
          `^Unstaged at least ${batches[0]!.length} of ${selection.length} files before Git stopped: `
        )
      );
      expect(indexed("ls-files")).toEqual(batches.slice(1).flat().sort());

      writeAll([refused], "indexed\n");
      await handler(CHANNELS.GIT_UNSTAGE_FILES)(null, { cwd: repo, filePaths: selection });
      expect(indexed("ls-files")).toEqual([]);
    });
  });

  it("refuses a path holding a NUL before running any git", async () => {
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    const mark = spawned.length;
    await expect(
      handler(CHANNELS.GIT_STAGE_FILES)(null, { cwd: repo, filePaths: ["a.txt", "b\0.txt"] })
    ).rejects.toThrow("Invalid file path in filePaths");
    expect(spawnedSince(mark)).toEqual([]);
  });

  // #17588: git names no push destination before a branch's first commit, so
  // the status has to say why the destination is missing.
  it("reports an unborn branch with a remote as unborn, until its first commit", async () => {
    git(repo, "remote", "add", "upstream", path.join(tmp, "origin.git"));
    fs.writeFileSync(path.join(repo, "first.txt"), "first\n");
    git(repo, "add", "first.txt");

    const unborn = await stagingStatus();

    expect(unborn.currentBranch).toBe("main");
    expect(unborn.isDetachedHead).toBe(false);
    expect(unborn.hasRemote).toBe(true);
    expect(unborn.pushDestination).toBeNull();
    expect(unborn.isUnbornBranch).toBe(true);

    git(repo, "commit", "-q", "-m", "first");
    const mark = spawned.length;
    const born = await stagingStatus();

    expect(born.isUnbornBranch).toBeUndefined();
    expect(born.pushDestination).toEqual({ remote: "upstream", branch: "main" });
    // A branch with a commit never pays for the probe.
    const probes = spawnedSince(mark).filter((args) => args.includes("--porcelain=v2"));
    expect(probes).toEqual([]);
  });

  // rev-parse echoes a pathname back when the revision doesn't resolve, so an
  // unborn branch tracking a file named `HEAD` "reads" a HEAD of `HEAD`.
  it("reports an unborn branch as unborn even with a tracked file named HEAD", async () => {
    fs.writeFileSync(path.join(repo, "HEAD"), "not a ref\n");
    git(repo, "add", "HEAD");

    const status = await stagingStatus();

    expect(status.staged.map((entry) => entry.path)).toEqual(["HEAD"]);
    expect(status.isUnbornBranch).toBe(true);
  });

  it("reports an orphan branch as unborn, and a detached HEAD never", async () => {
    commitFiles({ "a.txt": "a\n" });
    git(repo, "checkout", "-q", "--orphan", "fresh");
    fs.writeFileSync(path.join(repo, "b.txt"), "b\n");
    git(repo, "add", "b.txt");

    const orphan = await stagingStatus();
    expect(orphan.currentBranch).toBe("fresh");
    expect(orphan.isUnbornBranch).toBe(true);

    git(repo, "checkout", "-q", "--detach", "main");
    const detached = await stagingStatus();
    expect(detached.isDetachedHead).toBe(true);
    expect(detached.isUnbornBranch).toBeUndefined();
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

  describe("staged paths during a stopped operation", () => {
    /** A merge that git stages `clean.txt` for itself and stops on `conf.txt`. */
    function mergeWithOneCleanAndOneConflict(): void {
      commitFiles({ "conf.txt": "a\nb\nc\n", "clean.txt": "base\n" });
      git(repo, "checkout", "-q", "-b", "topic");
      fs.writeFileSync(path.join(repo, "conf.txt"), "a\ntopic\nc\n");
      fs.writeFileSync(path.join(repo, "clean.txt"), "topic\n");
      git(repo, "commit", "-qam", "topic");
      git(repo, "checkout", "-q", "main");
      fs.writeFileSync(path.join(repo, "conf.txt"), "a\nmain\nc\n");
      git(repo, "commit", "-qam", "main");
      expect(() => git(repo, "merge", "topic")).toThrow();
    }

    const resolveUndoReads = (mark: number) =>
      spawnedSince(mark).filter((args) => subcommand(args) === "ls-files");

    it("tells a resolved conflict from a path git merged cleanly, before and after resolving", async () => {
      mergeWithOneCleanAndOneConflict();

      let mark = spawned.length;
      const before = await stagingStatus();
      expect(before.repoState).toBe("MERGING");
      expect(before.staged.map((f) => f.path)).toEqual(["clean.txt"]);
      expect(before.conflictedFiles.map((f) => f.path)).toEqual(["conf.txt"]);
      expect(before.resolveUndoPaths).toEqual([]);
      expect(resolveUndoReads(mark)).toHaveLength(1);

      fs.writeFileSync(path.join(repo, "conf.txt"), "a\nboth\nc\n");
      await stage("conf.txt");

      mark = spawned.length;
      const after = await stagingStatus();
      expect(after.conflictedFiles).toEqual([]);
      expect(after.staged.map((f) => f.path).sort()).toEqual(["clean.txt", "conf.txt"]);
      expect(after.resolveUndoPaths).toEqual(["conf.txt"]);
      expect(resolveUndoReads(mark)).toHaveLength(1);
    });

    it("reads nothing when nothing is staged or no operation is stopped", async () => {
      commitFiles({ "a.txt": "one\n" });
      fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
      await stage("a.txt");

      let mark = spawned.length;
      const ordinary = await stagingStatus();
      expect(ordinary.staged.map((f) => f.path)).toEqual(["a.txt"]);
      expect("resolveUndoPaths" in ordinary).toBe(false);
      expect(resolveUndoReads(mark)).toEqual([]);

      git(repo, "reset", "-q");
      git(repo, "checkout", "-q", "--", "a.txt");
      git(repo, "checkout", "-q", "-b", "topic");
      fs.writeFileSync(path.join(repo, "a.txt"), "topic\n");
      git(repo, "commit", "-qam", "topic");
      git(repo, "checkout", "-q", "main");
      fs.writeFileSync(path.join(repo, "a.txt"), "main\n");
      git(repo, "commit", "-qam", "main");
      expect(() => git(repo, "merge", "topic")).toThrow();

      mark = spawned.length;
      const conflictOnly = await stagingStatus();
      expect(conflictOnly.repoState).toBe("MERGING");
      expect(conflictOnly.staged).toEqual([]);
      expect("resolveUndoPaths" in conflictOnly).toBe(false);
      expect(resolveUndoReads(mark)).toEqual([]);
    });

    it("reads nothing for a stash pop's conflict, which has no operation behind it", async () => {
      commitFiles({ "conf.txt": "a\nb\nc\n", "other.txt": "base\n" });
      fs.writeFileSync(path.join(repo, "conf.txt"), "a\nstash\nc\n");
      fs.writeFileSync(path.join(repo, "other.txt"), "stashed\n");
      git(repo, "stash", "push", "-q");
      fs.writeFileSync(path.join(repo, "conf.txt"), "a\nhead\nc\n");
      git(repo, "commit", "-qam", "head");
      expect(() => git(repo, "stash", "pop")).toThrow();

      const mark = spawned.length;
      const status = await stagingStatus();
      expect(status.repoState).toBe("DIRTY");
      expect(status.conflictedFiles.map((f) => f.path)).toEqual(["conf.txt"]);
      expect(status.staged.map((f) => f.path)).toEqual(["other.txt"]);
      expect("resolveUndoPaths" in status).toBe(false);
      expect(resolveUndoReads(mark)).toEqual([]);
    });
  });

  it("reports markers left behind with no opener apart from the region count", async () => {
    fs.writeFileSync(path.join(repo, "orphan.ts"), "kept\n=======\nright\n>>>>>>> theirs\n");
    fs.writeFileSync(path.join(repo, "clean.ts"), "resolved\n");
    fs.writeFileSync(
      path.join(repo, "region.ts"),
      "a\n>>>>>>> stray\n<<<<<<< ours\nl\n=======\nr\n>>>>>>> theirs\n"
    );
    fs.mkdirSync(path.join(repo, "dir"));
    // Past the scan cap, with a marker on its first line.
    fs.writeFileSync(path.join(repo, "huge.ts"), `>>>>>>> theirs\n${"x".repeat(1_000_000)}`);

    const entries = await handler(CHANNELS.GIT_SCAN_CONFLICT_MARKERS)(null, {
      cwd: repo,
      filePaths: ["orphan.ts", "clean.ts", "region.ts", "missing.ts", "dir", "huge.ts"],
    });

    expect(entries).toEqual([
      { path: "orphan.ts", hunkCount: 0, hasMarkers: true, firstMarkerLine: 4 },
      { path: "clean.ts", hunkCount: 0, hasMarkers: false, firstMarkerLine: null },
      { path: "region.ts", hunkCount: 1, hasMarkers: true, firstMarkerLine: 2 },
      { path: "missing.ts", hunkCount: null, hasMarkers: null, firstMarkerLine: null },
      { path: "dir", hunkCount: null, hasMarkers: null, firstMarkerLine: null },
      { path: "huge.ts", hunkCount: null, hasMarkers: null, firstMarkerLine: null },
    ]);
  });
});

describe("git-write repository operation handlers on a halted git am (real git)", () => {
  const continueOperation = () =>
    handler(CHANNELS.GIT_CONTINUE_REPOSITORY_OPERATION)(null, repo) as Promise<void>;
  const abortOperation = () =>
    handler(CHANNELS.GIT_ABORT_REPOSITORY_OPERATION)(null, repo) as Promise<void>;
  const continueOperationWith = (pin: RepoOperationPin) =>
    handler(CHANNELS.GIT_CONTINUE_REPOSITORY_OPERATION)(null, repo, pin) as Promise<void>;
  const abortOperationWith = (pin: RepoOperationPin) =>
    handler(CHANNELS.GIT_ABORT_REPOSITORY_OPERATION)(null, repo, pin) as Promise<void>;
  const amMarker = () => path.join(repo, ".git", "rebase-apply", "applying");

  /**
   * A `git am -3` of `topic`'s two commits onto a `main` that rewrote the line
   * the second one touches: the first patch lands, the second stops.
   */
  function haltGitAm(): { tip: string; firstApplied: string } {
    commitFiles({ "f.txt": "base\n", "g.txt": "base\n" });
    // The handlers' git commits under the test's empty home, so the identity
    // has to live in the repository itself.
    git(repo, "config", "user.name", "Repo Owner");
    git(repo, "config", "user.email", "repo@example.test");
    git(repo, "config", "commit.gpgsign", "false");
    git(repo, "checkout", "-q", "-b", "topic");
    fs.writeFileSync(path.join(repo, "g.txt"), "topic\n");
    git(repo, "commit", "-q", "-a", "-m", "clean change");
    fs.writeFileSync(path.join(repo, "f.txt"), "topic\n");
    git(repo, "commit", "-q", "-a", "-m", "topic change");
    const patches = path.join(tmp, "patches");
    git(repo, "format-patch", "-q", "-2", "-o", patches);
    git(repo, "checkout", "-q", "main");
    fs.writeFileSync(path.join(repo, "f.txt"), "main\n");
    git(repo, "commit", "-q", "-a", "-m", "main change");
    const tip = git(repo, "rev-parse", "HEAD").trim();
    const series = fs
      .readdirSync(patches)
      .sort()
      .map((name) => path.join(patches, name));
    expect(() =>
      execFileSync("git", ["am", "-3", ...series], { cwd: repo, env: GIT_ENV, stdio: "ignore" })
    ).toThrow();
    expect(fs.existsSync(amMarker())).toBe(true);
    const firstApplied = git(repo, "rev-parse", "HEAD").trim();
    expect(git(repo, "log", "-1", "--format=%s").trim()).toBe("clean change");
    expect(firstApplied).not.toBe(tip);
    return { tip, firstApplied };
  }

  it("reports the halted session as a mailbox apply in the staging status", async () => {
    haltGitAm();

    const status = await stagingStatus();

    expect(status.repoState).toBe("APPLYING_MAILBOX");
    expect(status.conflicted).toEqual(["f.txt"]);
    expect(status.rebaseStep).toBeNull();
    expect(status.rebaseTotalSteps).toBeNull();
  });

  it("continues with git am once the conflict is staged, committing the patch", async () => {
    haltGitAm();
    fs.writeFileSync(path.join(repo, "f.txt"), "resolved\n");
    git(repo, "add", "f.txt");

    const mark = spawned.length;
    await continueOperation();

    const subcommands = spawnedSince(mark).map(subcommand);
    expect(subcommands).toContain("am");
    expect(subcommands).not.toContain("rebase");
    expect(fs.existsSync(path.join(repo, ".git", "rebase-apply"))).toBe(false);
    expect(git(repo, "log", "-1", "--format=%s").trim()).toBe("topic change");
    expect(git(repo, "show", "HEAD:f.txt")).toBe("resolved\n");
  });

  // `git am` explains an unmerged index on stdout and leaves stderr to advice
  // hints, so with the hints off the refusal reaches simple-git with no stderr.
  it("rejects a continue on unresolved paths even with git's conflict advice off", async () => {
    haltGitAm();
    git(repo, "config", "advice.mergeConflict", "false");

    await expect(continueOperation()).rejects.toThrow(/unmerged paths/);
    expect(fs.existsSync(amMarker())).toBe(true);
  });

  // Two patches so a skip, which would keep the first, can't pass for an abort.
  it("aborts with git am, returning the branch to its tip from before the session", async () => {
    const { tip } = haltGitAm();

    const mark = spawned.length;
    await abortOperation();

    const subcommands = spawnedSince(mark).map(subcommand);
    expect(subcommands).toContain("am");
    expect(subcommands).not.toContain("rebase");
    expect(fs.existsSync(path.join(repo, ".git", "rebase-apply"))).toBe(false);
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(tip);
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  // Review Hub pins Abort and Continue to the session it shows (#17559), so a
  // halted am needs an identity of its own, and one a restart changes.
  it("pins the session it shows, and refuses the pin once the same series restarts", async () => {
    haltGitAm();
    const shown = await stagingStatus();
    expect(shown.repoOperationId).toEqual(expect.any(String));
    const chosen: RepoOperationPin = {
      operation: "APPLYING_MAILBOX",
      operationId: shown.repoOperationId,
    };

    git(repo, "am", "--abort");
    // Past the coarse clock some filesystems stamp from, as a real restart is.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const patches = path.join(tmp, "patches");
    const series = fs
      .readdirSync(patches)
      .sort()
      .map((name) => path.join(patches, name));
    expect(() =>
      execFileSync("git", ["am", "-3", ...series], { cwd: repo, env: GIT_ENV, stdio: "ignore" })
    ).toThrow();
    // Resolved and staged, so a continue that ran would commit the new session's patch.
    fs.writeFileSync(path.join(repo, "f.txt"), "resolved\n");
    git(repo, "add", "f.txt");

    const mark = spawned.length;
    await expect(abortOperationWith(chosen)).rejects.toMatchObject({
      reason: "repo-operation-changed",
    });
    await expect(continueOperationWith(chosen)).rejects.toMatchObject({
      reason: "repo-operation-changed",
    });
    expect(spawnedSince(mark).map(subcommand)).not.toContain("am");
    expect(fs.existsSync(amMarker())).toBe(true);

    const current = (await stagingStatus()).repoOperationId;
    expect(current).toEqual(expect.any(String));
    expect(current).not.toBe(chosen.operationId);
    await continueOperationWith({ operation: "APPLYING_MAILBOX", operationId: current });
    expect(fs.existsSync(path.join(repo, ".git", "rebase-apply"))).toBe(false);
    expect(git(repo, "log", "-1", "--format=%s").trim()).toBe("topic change");
  });
});

describe("abort and continue act only on the operation the user chose (real git, #17559)", () => {
  /** A git command expected to stop on a conflict, which exits non-zero. */
  function gitHalting(cwd: string, ...args: string[]): void {
    try {
      git(cwd, ...args);
    } catch {
      // The halt is the point; the tests assert on the state it leaves.
    }
  }

  const statusAt = (cwd: string) =>
    handler(CHANNELS.GIT_GET_STAGING_STATUS)(null, cwd) as Promise<StagingStatus>;
  const abortAt = (cwd: string, pin?: RepoOperationPin) =>
    handler(CHANNELS.GIT_ABORT_REPOSITORY_OPERATION)(null, cwd, pin);
  const continueAt = (cwd: string, pin?: RepoOperationPin) =>
    handler(CHANNELS.GIT_CONTINUE_REPOSITORY_OPERATION)(null, cwd, pin);

  async function pinAt(cwd: string): Promise<RepoOperationPin> {
    const status = await statusAt(cwd);
    expect(status.repoState).not.toMatch(/^(CLEAN|DIRTY)$/);
    expect(status.repoOperationId).toEqual(expect.any(String));
    return {
      operation: status.repoState as RepoOperationPin["operation"],
      operationId: status.repoOperationId,
    };
  }

  /** `main` and `side` both change f.txt, so merging or rebasing one onto the other conflicts. */
  function divergedBranches(sideCommits = 1): void {
    // The handlers' own git commits on continue, and reads no identity from the
    // test's environment.
    git(repo, "config", "user.name", "Test");
    git(repo, "config", "user.email", "test@example.test");
    commitFiles({ "f.txt": "base\n" });
    git(repo, "checkout", "-q", "-b", "side");
    for (let i = 1; i <= sideCommits; i++) {
      fs.writeFileSync(path.join(repo, "f.txt"), `side ${i}\n`);
      git(repo, "commit", "-q", "-am", `side ${i}`);
    }
    git(repo, "checkout", "-q", "main");
    fs.writeFileSync(path.join(repo, "f.txt"), "main\n");
    git(repo, "commit", "-q", "-am", "main");
  }

  // Linux stamps files from a coarse clock, a jiffy (up to 10ms) wide, and can
  // hand a just-freed inode straight back: a restart inside the same tick could
  // otherwise land on an identical file identity. Real clients take far longer
  // than this between an abort and a fresh start.
  const pastTimestampGranularity = () => new Promise((resolve) => setTimeout(resolve, 25));

  it("refuses a merge restarted on the same commits, for abort and continue, then accepts a fresh choice", async () => {
    divergedBranches();
    gitHalting(repo, "merge", "side");
    const chosen = await pinAt(repo);
    expect(chosen.operation).toBe("MERGING");

    git(repo, "merge", "--abort");
    await pastTimestampGranularity();
    gitHalting(repo, "merge", "side");
    // Resolved and staged, so a continue that ran would commit the new merge.
    fs.writeFileSync(path.join(repo, "f.txt"), "resolved\n");
    git(repo, "add", "f.txt");
    const mergeHead = path.join(repo, ".git", "MERGE_HEAD");

    const mark = spawned.length;
    await expect(abortAt(repo, chosen)).rejects.toMatchObject({
      reason: "repo-operation-changed",
    });
    await expect(continueAt(repo, chosen)).rejects.toMatchObject({
      reason: "repo-operation-changed",
    });
    expect(spawnedSince(mark).map(subcommand)).not.toContain("merge");
    expect(fs.existsSync(mergeHead)).toBe(true);
    expect(git(repo, "diff", "--cached", "--name-only")).toBe("f.txt\n");

    const current = await pinAt(repo);
    expect(current.operationId).not.toBe(chosen.operationId);
    await abortAt(repo, current);
    expect(fs.existsSync(mergeHead)).toBe(false);
  });

  it("refuses an operation of another kind, and one that has ended", async () => {
    divergedBranches();
    gitHalting(repo, "merge", "side");
    const chosen = await pinAt(repo);

    git(repo, "merge", "--abort");
    await expect(abortAt(repo, chosen)).rejects.toThrow(/no longer in progress/);

    gitHalting(repo, "cherry-pick", "side");
    await expect(abortAt(repo, chosen)).rejects.toThrow(/cherry-pick is in progress now/);
    expect(fs.existsSync(path.join(repo, ".git", "CHERRY_PICK_HEAD"))).toBe(true);
  });

  it("keeps one rebase's pin across its steps in a linked worktree", async () => {
    divergedBranches(2);
    const linked = path.join(tmp, "linked");
    git(repo, "worktree", "add", "-q", linked, "side");
    gitHalting(linked, "rebase", "main");
    const chosen = await pinAt(linked);
    expect(chosen.operation).toBe("REBASING");

    // Resolving step 1 and continuing stops again on step 2's conflict, which
    // the handler reports as a failure while the rebase has moved on.
    fs.writeFileSync(path.join(linked, "f.txt"), "resolved 1\n");
    git(linked, "add", "f.txt");
    await expect(continueAt(linked, chosen)).rejects.toThrow(/could not apply/i);
    const second = await statusAt(linked);
    expect(second.repoState).toBe("REBASING");
    expect(second.rebaseStep).toBe(2);
    expect(second.repoOperationId).toBe(chosen.operationId);

    await abortAt(linked, chosen);
    expect((await statusAt(linked)).repoState).toBe("CLEAN");
    expect(git(linked, "log", "-1", "--format=%s")).toBe("side 2\n");
  });

  it("withholds the id when the merge is replaced while the status is read", async () => {
    divergedBranches();
    gitHalting(repo, "merge", "side");
    const mergeHead = path.join(repo, ".git", "MERGE_HEAD");
    // Another merge in its place mid-read: the counts would be the old one's.
    const otherCommit = git(repo, "rev-parse", "main");
    duringNextStatus = () => {
      fs.rmSync(mergeHead);
      fs.writeFileSync(mergeHead, otherCommit);
    };

    const status = await statusAt(repo);
    expect(duringNextStatus).toBeNull();
    expect(status.repoState).toBe("MERGING");
    expect(status.repoOperationId).toBeNull();
    // The next read, with nothing changing under it, identifies it again.
    expect((await statusAt(repo)).repoOperationId).toEqual(expect.any(String));
  });

  it("withholds the id when a merge starts while the status is read", async () => {
    divergedBranches();
    const sideCommit = git(repo, "rev-parse", "side");
    duringNextStatus = () => {
      fs.writeFileSync(path.join(repo, ".git", "MERGE_HEAD"), sideCommit);
    };

    const status = await statusAt(repo);
    expect(duringNextStatus).toBeNull();
    expect(status.repoState).toBe("MERGING");
    expect(status.repoOperationId).toBeNull();
  });

  it("reports no operation id for a clean worktree", async () => {
    commitFiles({ "f.txt": "base\n" });
    const status = await stagingStatus();
    expect(status.repoState).toBe("CLEAN");
    expect(status.repoOperationId).toBeNull();
  });
});
