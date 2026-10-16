import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Real-git coverage for discard and trash (#13424). No simple-git mock: what
 * matters is the index and the bytes on disk after real git has run, and
 * which of the user's files ended up in the Trash rather than gone.
 */

const TEST_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-file-mutation-ud-"));
const PRIOR_USER_DATA = process.env.DAINTREE_USER_DATA;
process.env.DAINTREE_USER_DATA = TEST_USER_DATA;

const { discardFileChanges, parsePorcelainV1Z, trashFile } = await import("../fileMutation.js");

const scratchDirs: string[] = [];
let repo: string;
let trashDir: string;
let trashed: string[];

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    stdio: "pipe",
    timeout: 10_000,
    env: GIT_ENV,
  }).toString();
}

function status(): string {
  return git(["status", "--porcelain=v1", "--untracked-files=all"]).replace(/\r\n/g, "\n");
}

function write(relativePath: string, contents: string): void {
  const file = path.join(repo, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repo, relativePath), "utf-8").replace(/\r\n/g, "\n");
}

function exists(relativePath: string): boolean {
  return fs.existsSync(path.join(repo, relativePath));
}

/** Stands in for `shell.trashItem`: moves the item aside so the test can read it back. */
async function fakeTrash(absolutePath: string): Promise<void> {
  const destination = path.join(trashDir, `${trashed.length}-${path.basename(absolutePath)}`);
  fs.renameSync(absolutePath, destination);
  trashed.push(destination);
}

function trashedContents(): string[] {
  return trashed.map((file) => fs.readFileSync(file, "utf-8").replace(/\r\n/g, "\n"));
}

function initRepo(withCommit = true): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-file-mutation-"));
  scratchDirs.push(root);
  repo = path.join(root, "repo");
  trashDir = path.join(root, "trash");
  fs.mkdirSync(repo);
  fs.mkdirSync(trashDir);
  trashed = [];
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  git(["config", "commit.gpgsign", "false"]);
  // Pinned in the repo, which production's hardened git reads too: a global
  // autocrlf or rename setting on the machine would otherwise make the
  // fixture and the code under test disagree about what changed.
  git(["config", "core.autocrlf", "false"]);
  git(["config", "status.renames", "true"]);
  if (!withCommit) return;
  write("a.txt", "committed a\n");
  write("old.txt", "committed old\n");
  write("pages/[...slug].tsx", "committed slug\n");
  write("pages/s.tsx", "committed s\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "initial"]);
}

afterAll(() => {
  fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
  if (PRIOR_USER_DATA === undefined) delete process.env.DAINTREE_USER_DATA;
  else process.env.DAINTREE_USER_DATA = PRIOR_USER_DATA;
});

describe("parsePorcelainV1Z", () => {
  it("pairs a rename with its source and keeps names byte-exact", () => {
    const parsed = parsePorcelainV1Z("RM new name.txt \0old.txt\0 M a.txt\0");
    expect(parsed).toEqual([
      { x: "R", y: "M", path: "new name.txt ", origPath: "old.txt" },
      { x: " ", y: "M", path: "a.txt" },
    ]);
  });
});

describe("discardFileChanges", () => {
  beforeEach(() => initRepo());

  it("drops staged and unstaged changes together", async () => {
    write("a.txt", "staged\n");
    git(["add", "a.txt"]);
    write("a.txt", "staged then edited\n");

    await discardFileChanges(repo, "a.txt", fakeTrash);

    expect(read("a.txt")).toBe("committed a\n");
    expect(status()).toBe("");
    expect(trashed).toEqual([]);
  });

  it("brings back a deleted file", async () => {
    fs.rmSync(path.join(repo, "a.txt"));

    await discardFileChanges(repo, "a.txt", fakeTrash);

    expect(read("a.txt")).toBe("committed a\n");
    expect(status()).toBe("");
  });

  it("sends a staged new file to the Trash rather than unlinking it", async () => {
    write("agent.txt", "written by an agent\n");
    git(["add", "agent.txt"]);

    await discardFileChanges(repo, "agent.txt", fakeTrash);

    expect(exists("agent.txt")).toBe(false);
    expect(status()).toBe("");
    expect(trashedContents()).toEqual(["written by an agent\n"]);
  });

  it("undoes both sides of a rename, keeping the edited copy in the Trash", async () => {
    git(["mv", "old.txt", "new.txt"]);
    write("new.txt", "renamed and edited\n");

    await discardFileChanges(repo, "new.txt", fakeTrash);

    expect(read("old.txt")).toBe("committed old\n");
    expect(exists("new.txt")).toBe(false);
    expect(status()).toBe("");
    expect(trashedContents()).toEqual(["renamed and edited\n"]);
  });

  it("refuses to restore a rename's source over a new file standing there", async () => {
    git(["mv", "old.txt", "new.txt"]);
    write("old.txt", "a different file\n");

    await expect(discardFileChanges(repo, "new.txt", fakeTrash)).rejects.toThrow(/Move it aside/);
    expect(read("old.txt")).toBe("a different file\n");
    expect(read("new.txt")).toBe("committed old\n");
    expect(trashed).toEqual([]);
  });

  it("discards a copy's own row without touching the file it was copied from", async () => {
    // The copy sorts ahead of its source, so a lookup that matched a copy by
    // its source would reach the copy's record before the source's own.
    git(["config", "status.renames", "copies"]);
    fs.copyFileSync(path.join(repo, "old.txt"), path.join(repo, "b-copy.txt"));
    write("old.txt", "edited source\n");
    git(["add", "-A"]);

    await discardFileChanges(repo, "old.txt", fakeTrash);

    expect(read("old.txt")).toBe("committed old\n");
    expect(read("b-copy.txt")).toBe("committed old\n");
    expect(trashed).toEqual([]);
  });

  it("refuses a path that reaches git's own directory through a symlinked folder", async () => {
    try {
      fs.symlinkSync(path.join(repo, ".git"), path.join(repo, "metadata"), "dir");
    } catch {
      return; // Symlinks need privileges on some Windows setups.
    }

    await expect(trashFile(repo, "metadata/index", fakeTrash)).rejects.toThrow(/Invalid file path/);
    expect(fs.existsSync(path.join(repo, ".git", "index"))).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "keeps a backslash as part of a POSIX file name",
    async () => {
      write("a\\b.txt", "backslash name\n");
      write("a/b.txt", "nested\n");

      await trashFile(repo, "a\\b.txt", fakeTrash);

      expect(trashedContents()).toEqual(["backslash name\n"]);
      expect(read("a/b.txt")).toBe("nested\n");
    }
  );

  it("leaves every other change in the worktree alone", async () => {
    write("a.txt", "discard me\n");
    write("old.txt", "keep me\n");
    git(["add", "old.txt"]);
    write("untracked.txt", "keep me too\n");

    await discardFileChanges(repo, "a.txt", fakeTrash);

    expect(read("a.txt")).toBe("committed a\n");
    expect(status()).toBe("M  old.txt\n?? untracked.txt\n");
  });

  it("restores a file whose name is a glob, not the sibling it matches", async () => {
    write("pages/[...slug].tsx", "edited slug\n");
    write("pages/s.tsx", "edited s\n");

    await discardFileChanges(repo, "pages/[...slug].tsx", fakeTrash);

    expect(read("pages/[...slug].tsx")).toBe("committed slug\n");
    expect(read("pages/s.tsx")).toBe("edited s\n");
  });

  it("refuses an untracked file and leaves it on disk", async () => {
    write("untracked.txt", "new\n");

    await expect(discardFileChanges(repo, "untracked.txt", fakeTrash)).rejects.toThrow(
      /no changes to discard/
    );
    expect(read("untracked.txt")).toBe("new\n");
  });

  it("refuses a conflicted file", async () => {
    git(["checkout", "-qb", "other"]);
    write("a.txt", "theirs\n");
    git(["commit", "-qam", "theirs"]);
    git(["checkout", "-q", "main"]);
    write("a.txt", "ours\n");
    git(["commit", "-qam", "ours"]);
    expect(() => git(["merge", "-q", "other"])).toThrow();

    await expect(discardFileChanges(repo, "a.txt", fakeTrash)).rejects.toThrow(/merge conflict/);
    expect(status()).toContain("UU a.txt");
  });

  it("changes nothing when the Trash refuses the file", async () => {
    write("agent.txt", "written by an agent\n");
    git(["add", "agent.txt"]);
    const refusingTrash = () => Promise.reject(new Error("No trash on this volume"));

    await expect(discardFileChanges(repo, "agent.txt", refusingTrash)).rejects.toThrow(
      "No trash on this volume"
    );
    expect(read("agent.txt")).toBe("written by an agent\n");
    expect(status()).toBe("A  agent.txt\n");
  });

  it.each(["../outside.txt", "/etc/hosts", ".git/config", "pages/../../x", "."])(
    "refuses the path %s",
    async (relativePath) => {
      await expect(discardFileChanges(repo, relativePath, fakeTrash)).rejects.toThrow(
        /Invalid file path/
      );
    }
  );
});

describe("discardFileChanges on an unborn branch", () => {
  beforeEach(() => initRepo(false));

  it("trashes a staged file, since there is no commit to restore it from", async () => {
    write("first.txt", "first draft\n");
    git(["add", "first.txt"]);

    await discardFileChanges(repo, "first.txt", fakeTrash);

    expect(exists("first.txt")).toBe(false);
    expect(status()).toBe("");
    expect(trashedContents()).toEqual(["first draft\n"]);
  });
});

describe("trashFile", () => {
  beforeEach(() => initRepo());

  it("moves a tracked file to the Trash and leaves the index alone", async () => {
    await trashFile(repo, "a.txt", fakeTrash);

    expect(exists("a.txt")).toBe(false);
    expect(status()).toBe(" D a.txt\n");
    expect(trashedContents()).toEqual(["committed a\n"]);
  });

  it("moves an untracked file to the Trash", async () => {
    write("scratch/agent.txt", "scratch\n");

    await trashFile(repo, "scratch/agent.txt", fakeTrash);

    expect(exists("scratch/agent.txt")).toBe(false);
    expect(trashedContents()).toEqual(["scratch\n"]);
  });

  it("refuses a folder", async () => {
    await expect(trashFile(repo, "pages", fakeTrash)).rejects.toThrow(/is a folder/);
    expect(exists("pages/s.tsx")).toBe(true);
  });

  it("trashes a symlink as the link, even when it points outside the worktree", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-file-mutation-target-"));
    scratchDirs.push(outside);
    fs.writeFileSync(path.join(outside, "secret.env"), "kept\n");
    try {
      fs.symlinkSync(path.join(outside, "secret.env"), path.join(repo, ".env"));
    } catch {
      return;
    }

    await trashFile(repo, ".env", fakeTrash);

    expect(fs.lstatSync(trashed[0]).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(outside, "secret.env"), "utf-8")).toBe("kept\n");
  });

  it("refuses a file that is already gone", async () => {
    await expect(trashFile(repo, "missing.txt", fakeTrash)).rejects.toThrow(/no longer exists/);
  });

  it("refuses a path through a symlinked folder that leaves the worktree", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-file-mutation-outside-"));
    scratchDirs.push(outside);
    fs.writeFileSync(path.join(outside, "victim.txt"), "not yours\n");
    try {
      fs.symlinkSync(outside, path.join(repo, "link"), "dir");
    } catch {
      return; // Symlinks need privileges on some Windows setups.
    }

    await expect(trashFile(repo, "link/victim.txt", fakeTrash)).rejects.toThrow(
      /Invalid file path/
    );
    expect(fs.existsSync(path.join(outside, "victim.txt"))).toBe(true);
  });
});
