import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHardenedGit } from "../../../utils/hardenedGit.js";
import { scanStagedFilesForConflictMarkers } from "../conflictMarkerScan.js";

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
  await scanStagedFilesForConflictMarkers(await createHardenedGit(repoDir));
}

afterAll(() => {
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

    const client = await createHardenedGit(path.join(repoDir, "src"));
    await expect(scanStagedFilesForConflictMarkers(client)).rejects.toThrow(
      /conflict markers found in root\.txt/
    );
  });

  it("scans the first commit of an unborn branch", async () => {
    fs.rmSync(path.join(repoDir, ".git"), { recursive: true, force: true });
    git(["init", "-q"]);
    write("first.txt", CONFLICTED);
    git(["add", "first.txt"]);

    await expect(scan()).rejects.toThrow(/conflict markers found in first\.txt/);
  });
});
