import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import childProcess, { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHardenedGit } from "../../../utils/hardenedGit.js";
import { STAGED_FILE_SIZE_CAP, scanStagedFilesForConflictMarkers } from "../conflictMarkerScan.js";

// Real git, no simple-git mock: the bug is what git does when asked to read a
// gitlink as a blob, which a mock cannot reproduce.

const SUBMODULE_SHA_A = "1".repeat(40);
const SUBMODULE_SHA_B = "2".repeat(40);
const CONFLICTED = "<<<<<<< ours\nleft\n=======\nright\n>>>>>>> theirs\n";

const scratchDirs: string[] = [];
let repoDir: string;

// `/dev/null` rather than `os.devNull`: git special-cases that exact string as
// "no config file" on every platform, including Git for Windows.
function git(args: string[]): void {
  execFileSync("git", args, {
    cwd: repoDir,
    stdio: "pipe",
    timeout: 10_000,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

function write(relativePath: string, contents: string | Buffer): void {
  const file = path.join(repoDir, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function stageGitlink(modulePath: string, sha: string): void {
  git(["update-index", "--add", "--cacheinfo", `160000,${sha},${modulePath}`]);
}

async function scan(): Promise<void> {
  await scanStagedFilesForConflictMarkers(await createHardenedGit(repoDir), repoDir);
}

// Counts the `cat-file` processes a scan starts, which must not grow with the
// number of staged files. The scanner's spawn binds `spawn` by name.
let catFileSpawns = 0;
const originalSpawn = childProcess.spawn;

beforeAll(() => {
  (childProcess as { spawn: typeof originalSpawn }).spawn = ((...args: unknown[]) => {
    if (Array.isArray(args[1]) && args[1].includes("cat-file")) catFileSpawns++;
    return (originalSpawn as (...a: unknown[]) => ReturnType<typeof originalSpawn>)(...args);
  }) as typeof originalSpawn;
  syncBuiltinESMExports();
});

afterAll(() => {
  (childProcess as { spawn: typeof originalSpawn }).spawn = originalSpawn;
  syncBuiltinESMExports();
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("scanStagedFilesForConflictMarkers (real git)", () => {
  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-conflict-scan-"));
    scratchDirs.push(repoDir);
    git(["init", "-q"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    write("README.md", "readme\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "init"]);
  });

  it.each([6, 7, 8, 13, 20])(
    "accepts a Markdown Setext heading with a %i-character underline",
    async (width) => {
      write("CHANGELOG.md", `Release notes\n${"=".repeat(width)}\n\n- first\n`);
      git(["add", "CHANGELOG.md"]);

      await expect(scan()).resolves.toBeUndefined();
    }
  );

  it("accepts an unrelated edit to a file that already holds a seven-character underline", async () => {
    write("CHANGELOG.md", "Release notes\n=======\n\n- first\n");
    git(["add", "CHANGELOG.md"]);
    git(["commit", "-qm", "changelog"]);
    write("CHANGELOG.md", "Release notes\n=======\n\n- first\n- second\n");
    git(["add", "CHANGELOG.md"]);

    await expect(scan()).resolves.toBeUndefined();
  });

  it("accepts a lone seven-equals line used as a plain text separator", async () => {
    write("notes.txt", "above\n=======\nbelow\n");
    git(["add", "notes.txt"]);

    await expect(scan()).resolves.toBeUndefined();
  });

  it("accepts a staged submodule addition", async () => {
    stageGitlink("module", SUBMODULE_SHA_A);
    write(".gitmodules", '[submodule "module"]\n\tpath = module\n\turl = ../module\n');
    git(["add", ".gitmodules"]);

    await expect(scan()).resolves.toBeUndefined();
  });

  it("accepts a staged submodule revision update", async () => {
    stageGitlink("module", SUBMODULE_SHA_A);
    git(["commit", "-qm", "add module"]);
    stageGitlink("module", SUBMODULE_SHA_B);

    await expect(scan()).resolves.toBeUndefined();
  });

  it("accepts a submodule whose path contains a space", async () => {
    stageGitlink("vendor/my module", SUBMODULE_SHA_A);

    await expect(scan()).resolves.toBeUndefined();
  });

  it("still rejects a staged text file with conflict markers beside a gitlink", async () => {
    stageGitlink("module", SUBMODULE_SHA_A);
    write("src/merged file.ts", CONFLICTED);
    git(["add", "src/merged file.ts"]);

    await expect(scan()).rejects.toThrow(/conflict markers found in src\/merged file\.ts/);
  });

  it("ignores binary blobs and staged deletions", async () => {
    // NUL makes git classify the blob as binary; the marker sits at a line
    // start so only the binary skip keeps it from matching.
    write("asset.bin", Buffer.concat([Buffer.from([0, 1, 2, 0x0a]), Buffer.from(CONFLICTED)]));
    git(["add", "asset.bin"]);
    git(["rm", "-q", "README.md"]);

    await expect(scan()).resolves.toBeUndefined();
  });

  it("leaves unmerged paths to git commit, then rejects a marker-bearing resolution", async () => {
    git(["checkout", "-qb", "topic"]);
    write("README.md", "topic\n");
    git(["commit", "-qam", "topic"]);
    git(["checkout", "-q", "-"]);
    write("README.md", "main\n");
    git(["commit", "-qam", "main"]);
    expect(() => git(["merge", "-q", "topic"])).toThrow();

    await expect(scan()).resolves.toBeUndefined();
    expect(() => git(["commit", "-qm", "unresolved"])).toThrow();

    git(["add", "README.md"]);
    await expect(scan()).rejects.toThrow(/conflict markers found in README\.md/);
  });

  it("scans the whole index from a subdirectory under diff.relative", async () => {
    git(["config", "diff.relative", "true"]);
    write("src/clean.ts", "clean\n");
    write("root.txt", CONFLICTED);
    git(["add", "src/clean.ts", "root.txt"]);

    const src = path.join(repoDir, "src");
    await expect(
      scanStagedFilesForConflictMarkers(await createHardenedGit(src), src)
    ).rejects.toThrow(/conflict markers found in root\.txt/);
  });

  it("reads every staged file in two cat-file runs, however many there are", async () => {
    for (let i = 0; i < 30; i++) write(`src/file-${String(i).padStart(2, "0")}.ts`, `clean ${i}\n`);
    write("src/file-30.ts", CONFLICTED);
    git(["add", "src"]);

    const before = catFileSpawns;
    await expect(scan()).rejects.toThrow(/conflict markers found in src\/file-30\.ts/);
    expect(catFileSpawns - before).toBe(2);
  });

  it("never reads a blob past the size cap", async () => {
    write("huge.txt", CONFLICTED + "a".repeat(STAGED_FILE_SIZE_CAP));
    git(["add", "huge.txt"]);

    const before = catFileSpawns;
    await expect(scan()).resolves.toBeUndefined();
    // The sizing run only: nothing was left to read.
    expect(catFileSpawns - before).toBe(1);
  });

  it("scans a blob exactly at the cap beside unusual names and shared content", async () => {
    write("edge.txt", CONFLICTED + "a".repeat(STAGED_FILE_SIZE_CAP - CONFLICTED.length));
    write("-dash é.txt", "clean\n");
    write("same-a.txt", "same\n");
    write("same-b.txt", "same\n");
    git(["add", "-A"]);

    await expect(scan()).rejects.toThrow(/conflict markers found in edge\.txt/);
  });

  it("finds a marker in an executable file", async () => {
    write("run.sh", "#!/bin/sh\n>>>>>>> topic\n");
    git(["add", "run.sh"]);
    git(["update-index", "--chmod=+x", "run.sh"]);
    await expect(scan()).rejects.toThrow(/conflict markers found in run\.sh \(line 2\)/);
  });

  it("still rejects a full conflict region after a heading underline, naming the opener's line", async () => {
    write(
      "CHANGELOG.md",
      "Release notes\n=============\n\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> topic\n"
    );
    git(["add", "CHANGELOG.md"]);

    await expect(scan()).rejects.toThrow(/conflict markers found in CHANGELOG\.md \(line 4\)/);
  });

  it("rejects the eight-wide markers git writes for a rename/rename conflict", async () => {
    // What `git merge` leaves in both destinations when each side renames the
    // file differently and edits the same lines.
    write(
      "b.txt",
      "line3\n<<<<<<<< HEAD:b.txt\nOURS4\n========\nTHEIRS4\n>>>>>>>> theirs:c.txt\nline5\n"
    );
    git(["add", "b.txt"]);

    await expect(scan()).rejects.toThrow(/conflict markers found in b\.txt \(line 2\)/);
  });

  it("finds a diff3 base marker in a CRLF file stored byte for byte", async () => {
    // `-text` keeps git from normalising the CRs away, whatever the user's
    // global attributes or autocrlf say.
    write(".git/info/attributes", "crlf.txt -text\n");
    write("crlf.txt", "one\r\n||||||| base\r\ntwo\r\n");
    git(["add", "crlf.txt"]);

    await expect(scan()).rejects.toThrow(/conflict markers found in crlf\.txt \(line 2\)/);
  });

  it("scans the first commit of an unborn branch", async () => {
    fs.rmSync(path.join(repoDir, ".git"), { recursive: true, force: true });
    git(["init", "-q"]);
    write("first.txt", CONFLICTED);
    git(["add", "first.txt"]);

    await expect(scan()).rejects.toThrow(/conflict markers found in first\.txt/);
  });
});
