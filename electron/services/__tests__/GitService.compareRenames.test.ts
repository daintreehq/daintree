import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitService } from "../GitService.js";
import type { CrossWorktreeDiffResult } from "../../../shared/types/ipc/git.js";

/**
 * Real-git coverage for #17459: a rename's churn and patch must describe the
 * move, not a delete of the old path and an add of the new one.
 */

const HUNDRED_LINES = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    timeout: 10_000,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: path.resolve(cwd, "..", "empty.gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

function asList(result: CrossWorktreeDiffResult | string): CrossWorktreeDiffResult {
  if (typeof result === "string") throw new Error(`Expected file list, got ${result}`);
  return result;
}

describe("GitService.compareWorktrees renames (real git)", () => {
  let fixtureRoot: string;
  let repoDir: string;

  beforeEach(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-git-compare-renames-"));
    // Git for Windows rejects the device path reported by os.devNull.
    fs.writeFileSync(path.join(fixtureRoot, "empty.gitconfig"), "");
    repoDir = path.join(fixtureRoot, "repo");
    fs.mkdirSync(repoDir);
    git(repoDir, ["init", "-q", "-b", "main"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test"]);
    // GitService's own git calls read global config; pin git's default here.
    git(repoDir, ["config", "diff.renames", "true"]);
    fs.mkdirSync(path.join(repoDir, "src"));
    fs.writeFileSync(path.join(repoDir, "src", "old.ts"), HUNDRED_LINES);
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["commit", "-qm", "init"]);
    git(repoDir, ["checkout", "-q", "-b", "other"]);
  });

  afterEach(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("reports no churn for a pure rename and diffs it as a move", async () => {
    git(repoDir, ["mv", "src/old.ts", "src/new.ts"]);
    git(repoDir, ["commit", "-qm", "rename"]);
    const service = new GitService(repoDir);

    const { files } = asList(await service.compareWorktrees("main", "other"));

    expect(files).toEqual([
      { status: "R", path: "src/new.ts", oldPath: "src/old.ts", insertions: 0, deletions: 0 },
    ]);
    const diff = await service.compareWorktrees(
      "main",
      "other",
      "src/new.ts",
      undefined,
      undefined,
      undefined,
      "src/old.ts"
    );
    expect(diff).toContain("rename from src/old.ts\nrename to src/new.ts");
    expect(diff).not.toContain("new file mode");
    expect(diff).not.toContain("@@");
  });

  it("counts and diffs only the edit on a rename with a one-line change", async () => {
    git(repoDir, ["mv", "src/old.ts", "src/new.ts"]);
    fs.writeFileSync(
      path.join(repoDir, "src", "new.ts"),
      HUNDRED_LINES.replace("line 50\n", "line fifty\n")
    );
    git(repoDir, ["commit", "-qam", "rename and edit"]);
    const service = new GitService(repoDir);

    const { files } = asList(await service.compareWorktrees("main", "other", undefined, true));

    expect(files).toEqual([
      { status: "R", path: "src/new.ts", oldPath: "src/old.ts", insertions: 1, deletions: 1 },
    ]);
    const diff = await service.compareWorktrees(
      "main",
      "other",
      "src/new.ts",
      true,
      undefined,
      undefined,
      "src/old.ts"
    );
    expect(typeof diff).toBe("string");
    const changed = (diff as string).split("\n").filter((line) => /^[+-](?![+-]{2} )/.test(line));
    expect(changed).toEqual(["-line 50", "+line fifty"]);
    expect(diff).toContain("rename from src/old.ts");
  });

  it("diffs a copy against its source without the source's own patch", async () => {
    git(repoDir, ["config", "diff.renames", "copies"]);
    fs.copyFileSync(path.join(repoDir, "src", "old.ts"), path.join(repoDir, "src", "copy.ts"));
    fs.appendFileSync(path.join(repoDir, "src", "old.ts"), "source edit\n");
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["commit", "-qm", "copy"]);
    const service = new GitService(repoDir);

    const { files } = asList(await service.compareWorktrees("main", "other"));

    expect(files).toEqual(
      expect.arrayContaining([
        { status: "M", path: "src/old.ts", insertions: 1, deletions: 0 },
        { status: "C", path: "src/copy.ts", oldPath: "src/old.ts", insertions: 0, deletions: 0 },
      ])
    );
    expect(files).toHaveLength(2);
    const diff = await service.compareWorktrees(
      "main",
      "other",
      "src/copy.ts",
      undefined,
      undefined,
      undefined,
      "src/old.ts"
    );
    expect(diff).toContain("copy from src/old.ts\ncopy to src/copy.ts");
    expect(diff).not.toContain("source edit");
    expect((diff as string).match(/^diff --git /gm)).toHaveLength(1);
  });

  it("keeps a delete and an add apart when rename detection is off", async () => {
    git(repoDir, ["config", "diff.renames", "false"]);
    git(repoDir, ["mv", "src/old.ts", "src/new.ts"]);
    git(repoDir, ["commit", "-qm", "rename"]);
    const service = new GitService(repoDir);

    const { files } = asList(await service.compareWorktrees("main", "other"));

    expect(files).toEqual(
      expect.arrayContaining([
        { status: "D", path: "src/old.ts", insertions: 0, deletions: 100 },
        { status: "A", path: "src/new.ts", insertions: 100, deletions: 0 },
      ])
    );
    expect(files).toHaveLength(2);
  });
});
