import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readWorktreeDiffNames, resetWorktreeDiffNamesForTests } from "../voiceDiffNames.js";

const dirs: string[] = [];

/** A repository whose origin/HEAD is its first commit, as a worktree branch sees develop. */
function repo(): { dir: string; git: (...args: string[]) => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-diff-names-"));
  dirs.push(dir);
  const git = (...args: string[]) => {
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  };
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(path.join(dir, "base.ts"), "export const startingPoint = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  git("update-ref", "refs/remotes/origin/develop", "HEAD");
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
  return { dir, git };
}

beforeEach(() => {
  resetWorktreeDiffNamesForTests();
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readWorktreeDiffNames", () => {
  it("reads the names the branch's commits add since it left the default branch", async () => {
    const { dir, git } = repo();
    writeFileSync(path.join(dir, "spans.ts"), "export function annotateUncertainSpans() {}\n");
    writeFileSync(path.join(dir, "package-lock.json"), '{ "integrityHashFragmentXyz9": 1 }\n');
    git("add", ".");
    git("commit", "-q", "-m", "work");
    // Uncommitted work, staged or not, is never read: reading the working tree
    // could run its filters.
    writeFileSync(path.join(dir, "base.ts"), "export const modifiedTrackedName = 1;\n");
    writeFileSync(path.join(dir, "staged.ts"), "export const stagedHelperName = 2;\n");
    git("add", "staged.ts");

    expect(await readWorktreeDiffNames(dir, 5_000)).toEqual(["annotateUncertainSpans"]);
  });

  it("never runs a textconv program the repository configures", async () => {
    const { dir, git } = repo();
    const marker = path.join(dir, "textconv-ran");
    git("config", "diff.spy.textconv", `sh -c 'touch "${marker}"; cat "$1"' --`);
    writeFileSync(path.join(dir, ".gitattributes"), "*.ts diff=spy\n");
    writeFileSync(path.join(dir, "spans.ts"), "export function annotateUncertainSpans() {}\n");
    git("add", ".");
    git("commit", "-q", "-m", "work");

    expect(await readWorktreeDiffNames(dir, 5_000)).toContain("annotateUncertainSpans");
    expect(existsSync(marker)).toBe(false);
    // The spy does run for a diff that allows it, so its silence above means something.
    execFileSync("git", ["diff", "HEAD~1..HEAD"], { cwd: dir, stdio: "ignore" });
    expect(existsSync(marker)).toBe(true);
  });

  it("never runs a program a changed submodule configures", async () => {
    const sub = repo().dir;
    const marker = path.join(sub, "submodule-textconv-ran");
    const { dir, git } = repo();
    git("-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sub");
    git("commit", "-q", "-m", "add submodule");
    git("update-ref", "refs/remotes/origin/develop", "HEAD");
    const inSub = (...args: string[]) =>
      execFileSync("git", args, { cwd: path.join(dir, "sub"), stdio: "ignore" });
    inSub("config", "diff.spy.textconv", `sh -c 'touch "${marker}"; cat "$1"' --`);
    inSub("config", "user.email", "test@example.com");
    inSub("config", "user.name", "Test");
    writeFileSync(path.join(dir, "sub", ".gitattributes"), "*.ts diff=spy\n");
    writeFileSync(path.join(dir, "sub", "inner.ts"), "export const innerSubmoduleName = 1;\n");
    inSub("add", ".");
    inSub("commit", "-q", "-m", "inner");
    git("config", "diff.submodule", "diff");
    git("add", "sub");
    git("commit", "-q", "-m", "bump submodule");

    await readWorktreeDiffNames(dir, 5_000);
    expect(existsSync(marker)).toBe(false);
  });

  it("serves a worktree's next dictations from the read it just made", async () => {
    const { dir, git } = repo();
    writeFileSync(path.join(dir, "spans.ts"), "export function annotateUncertainSpans() {}\n");
    git("add", ".");
    git("commit", "-q", "-m", "work");
    expect(await readWorktreeDiffNames(dir, 5_000)).toEqual(["annotateUncertainSpans"]);

    writeFileSync(path.join(dir, "more.ts"), "export function matchCodeNames() {}\n");
    git("add", ".");
    git("commit", "-q", "-m", "more");
    expect(await readWorktreeDiffNames(dir, 5_000)).toEqual(["annotateUncertainSpans"]);
  });

  it("reads nothing without a default branch to diff against, or outside a repository", async () => {
    const { dir, git } = repo();
    git("symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
    expect(await readWorktreeDiffNames(dir, 5_000)).toEqual([]);

    const plain = mkdtempSync(path.join(tmpdir(), "voice-diff-none-"));
    dirs.push(plain);
    expect(await readWorktreeDiffNames(plain, 5_000)).toEqual([]);
  });
});
