import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitService } from "../GitService.js";
import { runWithCappedStdout } from "../../utils/cappedGitOutput.js";

/**
 * Real-git coverage for #13592: a preview diff whose patch passes the 1MiB
 * ceiling is refused while git runs, including the cases no worktree stat can
 * see coming — a deleted file, a file cut down to a line, and a comparison of
 * historical blobs.
 */

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    timeout: 10_000,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_SYSTEM: os.devNull,
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

// ~2MiB of text, so every patch that carries it is past the 1MiB ceiling.
const LARGE_TEXT = "a line of perfectly ordinary text in a large file\n".repeat(42_000);

describe("GitService capped preview diffs (real git)", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-git-capped-diff-"));
    git(repoDir, ["init", "-q", "-b", "main"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test"]);
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  function commitAll(message: string): void {
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["commit", "-qm", message]);
  }

  it("refuses the deletion patch of a large tracked file", async () => {
    fs.writeFileSync(path.join(repoDir, "big.txt"), LARGE_TEXT);
    commitAll("add big");
    fs.rmSync(path.join(repoDir, "big.txt"));

    const diff = await new GitService(repoDir).getFileDiff("big.txt", "deleted");

    expect(diff).toBe("FILE_TOO_LARGE");
  });

  it("refuses the patch of a large file cut down to one line", async () => {
    fs.writeFileSync(path.join(repoDir, "big.txt"), LARGE_TEXT);
    commitAll("add big");
    fs.writeFileSync(path.join(repoDir, "big.txt"), "short\n");

    const diff = await new GitService(repoDir).getFileDiff("big.txt", "modified");

    expect(diff).toBe("FILE_TOO_LARGE");
  });

  it("refuses a large historical comparison between branches", async () => {
    fs.writeFileSync(path.join(repoDir, "big.txt"), LARGE_TEXT);
    commitAll("add big");
    git(repoDir, ["checkout", "-q", "-b", "other"]);
    fs.rmSync(path.join(repoDir, "big.txt"));
    commitAll("drop big");

    const diff = await new GitService(repoDir).compareWorktrees("main", "other", "big.txt");

    expect(diff).toBe("FILE_TOO_LARGE");
  });

  it("still returns small patches, binary markers and special-character paths", async () => {
    const name = "spaced name [1].txt";
    fs.writeFileSync(path.join(repoDir, name), "one\ntwo\n");
    fs.writeFileSync(path.join(repoDir, "blob.bin"), Buffer.from([0, 1, 2, 0, 3]));
    commitAll("add small");
    fs.writeFileSync(path.join(repoDir, name), "one\nthree\n");
    fs.writeFileSync(path.join(repoDir, "blob.bin"), Buffer.from([0, 9, 9, 0, 9]));
    const service = new GitService(repoDir);

    const diff = await service.getFileDiff(name, "modified");

    expect(diff).toContain(`+++ b/${name}`);
    expect(diff).toContain("+three");
    expect(await service.getFileDiff("blob.bin", "modified")).toBe("BINARY_FILE");
  });

  it("still surfaces git's own failure when HEAD is missing", async () => {
    fs.writeFileSync(path.join(repoDir, "file.txt"), "text\n");

    await expect(new GitService(repoDir).getFileDiff("file.txt", "modified")).rejects.toThrow(
      "Failed to generate diff"
    );
  });

  it("stops git once stdout passes the cap and leaves smaller output intact", async () => {
    fs.writeFileSync(path.join(repoDir, "big.txt"), LARGE_TEXT);
    commitAll("add big");

    const capped = await runWithCappedStdout(repoDir, 64 * 1024, (g) =>
      g.raw(["cat-file", "-p", "HEAD:big.txt"])
    );
    const whole = await runWithCappedStdout(repoDir, LARGE_TEXT.length, (g) =>
      g.raw(["cat-file", "-p", "HEAD:big.txt"])
    );

    expect(capped).toBeNull();
    expect(whole).toBe(LARGE_TEXT);
  });
});
