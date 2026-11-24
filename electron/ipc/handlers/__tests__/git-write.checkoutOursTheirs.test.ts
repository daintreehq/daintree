import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConflictSideChoice, StagingStatus } from "../../../../shared/types/git.js";

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

/** Runs a command expected to stop on a conflict, so its exit status is git's answer. */
function gitConflicting(cwd: string, ...args: string[]): void {
  try {
    execFileSync("git", args, { cwd, env: GIT_ENV, stdio: "ignore" });
  } catch {
    return;
  }
  throw new Error(`git ${args.join(" ")} did not stop on a conflict`);
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

const takeSide = (filePath: string, choice: ConflictSideChoice) =>
  handler(CHANNELS.GIT_CHECKOUT_OURS_THEIRS)(null, { cwd: repo, filePath, ...choice });
const indexAndDisk = (name: string) => ({
  index: git(repo, "ls-files", "--stage", "--", name),
  disk: onDisk(name) ? read(name) : null,
});
const stagingStatus = () =>
  handler(CHANNELS.GIT_GET_STAGING_STATUS)(null, repo) as Promise<StagingStatus>;
const conflictCodes = async () =>
  (await stagingStatus()).conflictedFiles.map(({ path: p, xy }) => `${xy} ${p}`);
const onDisk = (name: string) => fs.existsSync(path.join(repo, name));
const read = (name: string) => fs.readFileSync(path.join(repo, name), "utf8");

beforeAll(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "git-write-sides-home-")));
  for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "GIT_CONFIG_NOSYSTEM"]) {
    savedEnv[key] = process.env[key];
  }
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  process.env.GIT_CONFIG_NOSYSTEM = "1";

  ({ CHANNELS } = await import("../../channels.js"));
  ({ _resetRateLimitQueuesForTest: resetRateLimits } = await import("../../utils.js"));
  const { registerGitWriteHandlers } = await import("../git-write.js");
  registerGitWriteHandlers({} as never);
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  resetRateLimits();
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "git-write-sides-")));
  repo = path.join(tmp, "repo");
  git(tmp, "init", "-q", "-b", "main", repo);
  fs.writeFileSync(path.join(repo, "original"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "checkout", "-q", "-b", "deleter");
  git(repo, "rm", "-q", "original");
  git(repo, "commit", "-q", "-m", "delete original");
  git(repo, "checkout", "-q", "-b", "modifier", "main");
  fs.writeFileSync(path.join(repo, "original"), "modified\n");
  git(repo, "commit", "-q", "-am", "modify original");
  return () => fs.rmSync(tmp, { recursive: true, force: true });
});

describe("git:checkout-ours-theirs on a modify/delete conflict (real git)", () => {
  describe("HEAD modified the file and the incoming branch deleted it", () => {
    beforeEach(async () => {
      gitConflicting(repo, "merge", "--no-edit", "deleter");
      expect(await conflictCodes()).toEqual(["UD original"]);
    });

    it("takes the incoming deletion by removing the file", async () => {
      await takeSide("original", { resolution: "delete", side: "theirs" });
      expect(await conflictCodes()).toEqual([]);
      expect(onDisk("original")).toBe(false);
      expect(git(repo, "diff", "--cached", "--name-status")).toBe("D\toriginal\n");
    });

    it("keeps HEAD's modification over a hand edit", async () => {
      fs.appendFileSync(path.join(repo, "original"), "hand edit\n");
      await takeSide("original", { resolution: "checkout", side: "ours" });
      expect(await conflictCodes()).toEqual([]);
      expect(read("original")).toBe("modified\n");
      expect(git(repo, "diff", "--cached", "--name-status")).toBe("");
    });
  });

  describe("HEAD deleted the file and the incoming branch modified it", () => {
    beforeEach(async () => {
      git(repo, "checkout", "-q", "deleter");
      gitConflicting(repo, "merge", "--no-edit", "modifier");
      expect(await conflictCodes()).toEqual(["DU original"]);
    });

    it("takes HEAD's deletion by removing the file, edits and all", async () => {
      fs.appendFileSync(path.join(repo, "original"), "hand edit\n");
      await takeSide("original", { resolution: "delete", side: "ours" });
      expect(await conflictCodes()).toEqual([]);
      expect(onDisk("original")).toBe(false);
      expect(git(repo, "ls-files", "--", "original")).toBe("");
    });

    it("keeps the incoming modification over a hand edit", async () => {
      fs.appendFileSync(path.join(repo, "original"), "hand edit\n");
      await takeSide("original", { resolution: "checkout", side: "theirs" });
      expect(await conflictCodes()).toEqual([]);
      expect(read("original")).toBe("modified\n");
      expect(git(repo, "show", ":original")).toBe("modified\n");
    });

    it("refuses a deletion of both, since the incoming side has the file", async () => {
      const before = indexAndDisk("original");
      await expect(takeSide("original", { resolution: "delete", side: "both" })).rejects.toThrow(
        /has changed/
      );
      expect(indexAndDisk("original")).toEqual(before);
    });
  });

  describe("refuses a choice the index no longer agrees with, changing nothing", () => {
    beforeEach(() => gitConflicting(repo, "merge", "--no-edit", "deleter"));

    it.each<[string, ConflictSideChoice]>([
      ["a deletion of the side that has the file", { resolution: "delete", side: "ours" }],
      ["an overwrite from the side without the file", { resolution: "checkout", side: "theirs" }],
      ["a deletion of both when one side has the file", { resolution: "delete", side: "both" }],
    ])("%s", async (_name, choice) => {
      const before = indexAndDisk("original");
      await expect(takeSide("original", choice)).rejects.toThrow(/has changed/);
      expect(indexAndDisk("original")).toEqual(before);
      expect(await conflictCodes()).toEqual(["UD original"]);
    });

    it("a path that is no longer in conflict", async () => {
      git(repo, "add", "original");
      const before = indexAndDisk("original");
      await expect(takeSide("original", { resolution: "delete", side: "theirs" })).rejects.toThrow(
        /has changed/
      );
      expect(indexAndDisk("original")).toEqual(before);
    });

    it("a checkout without a resolution", async () => {
      await expect(
        handler(CHANNELS.GIT_CHECKOUT_OURS_THEIRS)(null, {
          cwd: repo,
          filePath: "original",
          side: "ours",
        })
      ).rejects.toThrow(/Invalid resolution/);
      expect(onDisk("original")).toBe(true);
    });
  });

  it("refuses a directory holding a conflict, which is not the conflicted path", async () => {
    git(repo, "checkout", "-q", "main");
    fs.mkdirSync(path.join(repo, "sub"));
    fs.writeFileSync(path.join(repo, "sub/inner"), "base\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "sub");
    git(repo, "checkout", "-q", "-b", "sub-deleter");
    git(repo, "rm", "-q", "sub/inner");
    git(repo, "commit", "-q", "-m", "delete sub/inner");
    git(repo, "checkout", "-q", "main");
    fs.writeFileSync(path.join(repo, "sub/inner"), "edit\n");
    git(repo, "commit", "-q", "-am", "modify sub/inner");
    gitConflicting(repo, "merge", "--no-edit", "sub-deleter");

    const before = indexAndDisk("sub/inner");
    await expect(takeSide("sub", { resolution: "checkout", side: "ours" })).rejects.toThrow(
      /has changed/
    );
    expect(indexAndDisk("sub/inner")).toEqual(before);
    expect(await conflictCodes()).toEqual(["UD sub/inner"]);
  });

  it("resolves a rename/rename conflict: the original by deleting both, each new name by its side", async () => {
    git(repo, "checkout", "-q", "-b", "left", "main");
    git(repo, "mv", "original", "left");
    git(repo, "commit", "-q", "-m", "rename to left");
    git(repo, "checkout", "-q", "-b", "right", "main");
    git(repo, "mv", "original", "right");
    git(repo, "commit", "-q", "-m", "rename to right");
    git(repo, "checkout", "-q", "left");
    gitConflicting(repo, "merge", "--no-edit", "right");
    expect(await conflictCodes()).toEqual(["AU left", "DD original", "UA right"]);

    await takeSide("original", { resolution: "delete", side: "both" });
    await takeSide("left", { resolution: "delete", side: "theirs" });
    await takeSide("right", { resolution: "checkout", side: "theirs" });
    expect(await conflictCodes()).toEqual([]);
    expect(onDisk("original")).toBe(false);
    expect(onDisk("left")).toBe(false);
    expect(read("right")).toBe("base\n");
    expect(git(repo, "ls-files")).toBe("right\n");
  });

  it("refuses to delete a submodule, which would take more than the one path", async () => {
    git(repo, "checkout", "-q", "main");
    const base = git(repo, "rev-parse", "HEAD").trim();
    git(repo, "update-index", "--add", "--cacheinfo", `160000,${base},sub`);
    git(repo, "commit", "-q", "-m", "add submodule");
    const linked = git(repo, "rev-parse", "HEAD").trim();
    git(repo, "checkout", "-q", "-b", "sub-deleter");
    git(repo, "rm", "-q", "--cached", "sub");
    git(repo, "commit", "-q", "-m", "drop submodule");
    git(repo, "checkout", "-q", "main");
    git(repo, "update-index", "--cacheinfo", `160000,${linked},sub`);
    git(repo, "commit", "-q", "-m", "move submodule");
    gitConflicting(repo, "merge", "--no-edit", "sub-deleter");
    expect(await conflictCodes()).toEqual(["UD sub"]);

    const before = git(repo, "ls-files", "--stage", "--", "sub");
    await expect(takeSide("sub", { resolution: "delete", side: "theirs" })).rejects.toThrow(
      /submodule/
    );
    expect(git(repo, "ls-files", "--stage", "--", "sub")).toBe(before);
  });

  it("deletes a file whose name is a glob pattern, and only that file", async () => {
    git(repo, "checkout", "-q", "main");
    for (const name of ["a[1].ts", "a1.ts"]) fs.writeFileSync(path.join(repo, name), "base\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "globs");
    git(repo, "checkout", "-q", "-b", "glob-deleter");
    git(repo, "rm", "-q", "a[1].ts", "a1.ts");
    git(repo, "commit", "-q", "-m", "delete both");
    git(repo, "checkout", "-q", "main");
    for (const name of ["a[1].ts", "a1.ts"]) fs.writeFileSync(path.join(repo, name), "edit\n");
    git(repo, "commit", "-q", "-am", "modify both");
    gitConflicting(repo, "merge", "--no-edit", "glob-deleter");

    await takeSide("a[1].ts", { resolution: "delete", side: "theirs" });
    expect(onDisk("a[1].ts")).toBe(false);
    expect(read("a1.ts")).toBe("edit\n");
    expect(await conflictCodes()).toEqual(["UD a1.ts"]);
  });
});
