import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitService } from "../GitService.js";

/**
 * Real-git coverage for #13562. On Unix a backslash is an ordinary filename
 * byte, so `a\b.txt` and `a/b.txt` are two different files; mapping one onto
 * the other reads the wrong blob. NTFS forbids `\` in names, so the suite only
 * runs where such a file can exist.
 */

const LITERAL = "a\\b.txt";
const NESTED = "a/b.txt";
const DOTTED = "..\\x.txt";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
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

function write(repo: string, relativePath: string, contents: string): void {
  const file = path.join(repo, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function text(result: Awaited<ReturnType<GitService["readFileAtHead"]>>): string | null {
  return result.ok && "content" in result ? result.content.toString("utf-8") : null;
}

describe.skipIf(process.platform === "win32")("GitService backslash filenames (real git)", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-git-backslash-"));
    git(repoDir, ["init", "-q"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test"]);
    write(repoDir, LITERAL, "literal backslash file");
    write(repoDir, NESTED, "different nested file");
    write(repoDir, DOTTED, "dotted literal file");
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["commit", "-qm", "init"]);
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("reads the literal-backslash file at HEAD, not the nested one", async () => {
    const service = new GitService(repoDir);

    expect(text(await service.readFileAtHead(LITERAL, 1000))).toBe("literal backslash file");
    expect(text(await service.readFileAtHead(NESTED, 1000))).toBe("different nested file");
  });

  it("accepts a name that only looks like traversal under Windows separators", async () => {
    const service = new GitService(repoDir);

    expect(text(await service.readFileAtHead(DOTTED, 1000))).toBe("dotted literal file");
    await expect(service.readFileAtHead("a/../../x.txt", 1000)).rejects.toThrow(/traversal/i);
  });

  it("reads the previous version of a deleted literal-backslash file", async () => {
    git(repoDir, ["rm", "-q", "--", LITERAL, NESTED]);
    git(repoDir, ["commit", "-qm", "delete"]);
    const service = new GitService(repoDir);

    expect(text(await service.readPreviousFileVersion(LITERAL, 1000))).toBe(
      "literal backslash file"
    );
  });
});
