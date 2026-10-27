import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readWorktreeDiffNames } from "../voiceDiffNames.js";

const dirs: string[] = [];

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-diff-names-"));
  dirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      stdio: "ignore",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(path.join(dir, "base.ts"), "export const startingPoint = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readWorktreeDiffNames", () => {
  it("reads the names a worktree's uncommitted work adds when no default branch is known", async () => {
    const dir = repo();
    writeFileSync(
      path.join(dir, "base.ts"),
      "export const startingPoint = 1;\nexport function annotateUncertainSpans() {}\n"
    );
    expect(await readWorktreeDiffNames(dir, 5_000)).toEqual(["annotateUncertainSpans"]);
  });

  it("reads nothing outside a repository", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "voice-diff-none-"));
    dirs.push(dir);
    expect(await readWorktreeDiffNames(dir, 5_000)).toEqual([]);
  });
});
