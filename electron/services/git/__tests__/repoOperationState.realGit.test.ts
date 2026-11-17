import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectRepoOperationState } from "../repoOperationState.js";
import {
  getRepoOperationState,
  getRepoOperationStateSync,
} from "../../../utils/gitRepoOperationState.js";

// Real git: `git am` and an apply-backend rebase both halt inside
// `.git/rebase-apply`, and only the marker file git writes beside the patches
// says which one is waiting (#17580).

let root: string;
let home: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/** The stop is a real three-way conflict, not just a patch that failed to apply. */
function hasUnmergedEntries(repo: string): boolean {
  return git(repo, "ls-files", "--unmerged").trim() !== "";
}

function gitMayFail(cwd: string, ...args: string[]): void {
  try {
    git(cwd, ...args);
  } catch {
    // The conflict is the point: the operation halts and leaves its markers.
  }
}

/** `topic` and `main` both rewrite `f`, so replaying one onto the other conflicts. */
function makeDivergedRepo(name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "f"), "base\n");
  git(dir, "add", "f");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "checkout", "-q", "-b", "topic");
  fs.writeFileSync(path.join(dir, "f"), "topic\n");
  git(dir, "commit", "-q", "-a", "-m", "topic change");
  git(dir, "checkout", "-q", "main");
  fs.writeFileSync(path.join(dir, "f"), "main\n");
  git(dir, "commit", "-q", "-a", "-m", "main change");
  return dir;
}

beforeAll(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "daintree-repoop-realgit-")));
  home = path.join(root, "home");
  fs.mkdirSync(home);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("in-progress operation detection against real git", () => {
  it("reports a conflicted `git am -3` session as a mailbox apply, not a rebase", async () => {
    const repo = makeDivergedRepo("am");
    const patches = path.join(root, "am-patches");
    git(repo, "format-patch", "-q", "-1", "topic", "-o", patches);
    gitMayFail(repo, "am", "-3", path.join(patches, fs.readdirSync(patches)[0]!));
    const gitDir = path.join(repo, ".git");
    expect(fs.existsSync(path.join(gitDir, "rebase-apply", "applying"))).toBe(true);
    const unmerged = hasUnmergedEntries(repo);
    expect(unmerged).toBe(true);

    const detected = await detectRepoOperationState(gitDir, unmerged);
    expect(detected).toEqual({
      state: "APPLYING_MAILBOX",
      rebaseStep: null,
      rebaseTotalSteps: null,
      rebaseSequence: null,
    });
    expect(getRepoOperationStateSync(gitDir)).toBe("APPLYING_MAILBOX");
    await expect(getRepoOperationState(gitDir)).resolves.toBe("APPLYING_MAILBOX");
  });

  it("keeps a conflicted apply-backend rebase as a rebase with its progress", async () => {
    const repo = makeDivergedRepo("rebase-apply");
    git(repo, "checkout", "-q", "topic");
    gitMayFail(repo, "rebase", "--apply", "main");
    const gitDir = path.join(repo, ".git");
    expect(fs.existsSync(path.join(gitDir, "rebase-apply", "rebasing"))).toBe(true);
    const unmerged = hasUnmergedEntries(repo);
    expect(unmerged).toBe(true);

    const detected = await detectRepoOperationState(gitDir, unmerged);
    expect(detected.state).toBe("REBASING");
    expect(detected.rebaseStep).toBe(1);
    expect(detected.rebaseTotalSteps).toBe(1);
    expect(getRepoOperationStateSync(gitDir)).toBe("REBASING");
    await expect(getRepoOperationState(gitDir)).resolves.toBe("REBASING");
  });
});
