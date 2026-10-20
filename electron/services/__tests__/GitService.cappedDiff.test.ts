import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
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

const require = createRequire(import.meta.url);
const cjsCp = require("child_process") as typeof import("child_process");
const realSpawn = cjsCp.spawn;

let home: string;

function fixtureEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, env: fixtureEnv(), stdio: "pipe", timeout: 10_000 });
}

/** Every git child spawned, forwarded unchanged to the real spawn, with the stdout bytes it delivered. */
function captureChildren(): { child: ChildProcess; stdoutBytes: number }[] {
  const children: { child: ChildProcess; stdoutBytes: number }[] = [];
  vi.spyOn(cjsCp, "spawn").mockImplementation(((...args: Parameters<typeof cjsCp.spawn>) => {
    const child = (realSpawn as (...a: unknown[]) => ChildProcess)(...args);
    const entry = { child, stdoutBytes: 0 };
    child.stdout?.on("data", (chunk: Buffer) => {
      entry.stdoutBytes += chunk.length;
    });
    children.push(entry);
    return child;
  }) as typeof cjsCp.spawn);
  // simple-git's ESM build binds `spawn` as a named import.
  syncBuiltinESMExports();
  return children;
}

// ~2MiB of text, so every patch that carries it is past the 1MiB ceiling.
const LARGE_TEXT = "a line of perfectly ordinary text in a large file\n".repeat(42_000);

describe("GitService capped preview diffs (real git)", () => {
  let repoDir: string;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "daintree-git-capped-home-")));
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", path.join(home, ".config"));
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "daintree-git-capped-diff-")));
    git(repoDir, ["init", "-q", "-b", "main"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test"]);
    git(repoDir, ["config", "commit.gpgsign", "false"]);
    git(repoDir, ["config", "core.autocrlf", "false"]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    vi.unstubAllEnvs();
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
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

  it("measures the ceiling in bytes, so a multibyte patch short in characters is refused", async () => {
    // Each line is 193 UTF-8 bytes but 65 UTF-16 units, so the deletion patch
    // is past 1MiB in bytes while its string length stays under it.
    const text = ("界".repeat(64) + "\n").repeat(6_000);
    fs.writeFileSync(path.join(repoDir, "wide.txt"), text);
    commitAll("add wide");
    fs.rmSync(path.join(repoDir, "wide.txt"));

    const diff = await new GitService(repoDir).getFileDiff("wide.txt", "deleted");

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

  it("stops and reaps git once stdout passes the cap, having read a fraction of it", async () => {
    fs.writeFileSync(path.join(repoDir, "big.txt"), LARGE_TEXT);
    commitAll("add big");
    const children = captureChildren();

    const capped = await runWithCappedStdout(repoDir, 64 * 1024, (g) =>
      g.raw(["cat-file", "-p", "HEAD:big.txt"])
    );

    expect(capped).toBeNull();
    expect(children).toHaveLength(1);
    const [{ child, stdoutBytes }] = children;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(stdoutBytes).toBeLessThan(LARGE_TEXT.length / 2);
  });

  it("returns output that fits the cap exactly", async () => {
    fs.writeFileSync(path.join(repoDir, "big.txt"), LARGE_TEXT);
    commitAll("add big");

    const whole = await runWithCappedStdout(repoDir, Buffer.byteLength(LARGE_TEXT), (g) =>
      g.raw(["cat-file", "-p", "HEAD:big.txt"])
    );

    expect(whole).toBe(LARGE_TEXT);
  });
});
