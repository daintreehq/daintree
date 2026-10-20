import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitService } from "../GitService.js";
import type { CrossWorktreeDiffResult } from "../../../shared/types/ipc/git.js";

/**
 * Real-git coverage for #13572. Git C-quotes names containing a double quote or
 * a tab in line-delimited diff output, and a trailing space is lost to any
 * record-level trim, so branch comparison must read NUL-delimited output to
 * hand back paths the per-file diff can find. NTFS forbids `"` and tabs in
 * names, so the suite only runs where such files can exist.
 */

const TRAILING_SPACE = "trailing.txt ";
const TAB = "tab\tname.txt";
const QUOTE = 'quote"name.txt';
const NEWLINE = "new\nline.txt";
const UNICODE = "café.txt";

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
  fs.writeFileSync(path.join(repo, relativePath), contents);
}

function asList(result: CrossWorktreeDiffResult | string): CrossWorktreeDiffResult {
  if (typeof result === "string") throw new Error(`Expected file list, got ${result}`);
  return result;
}

describe.skipIf(process.platform === "win32")(
  "GitService.compareWorktrees unusual filenames (real git)",
  () => {
    let repoDir: string;

    beforeEach(() => {
      repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-git-compare-paths-"));
      git(repoDir, ["init", "-q", "-b", "main"]);
      git(repoDir, ["config", "user.email", "test@example.com"]);
      git(repoDir, ["config", "user.name", "Test"]);
      write(repoDir, "base.txt", "base\n");
      write(repoDir, "rename me.txt", "one\ntwo\nthree\nfour\nfive\n");
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-qm", "init"]);
      git(repoDir, ["checkout", "-q", "-b", "other"]);
    });

    afterEach(() => {
      fs.rmSync(repoDir, { recursive: true, force: true });
    });

    it.each([
      ["a trailing space", TRAILING_SPACE],
      ["a literal tab", TAB],
      ["a double quote", QUOTE],
      ["a newline", NEWLINE],
      ["non-ASCII characters", UNICODE],
    ])("lists a file whose name has %s and diffs it by that path", async (_label, name) => {
      write(repoDir, name, "first\nsecond\n");
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-qm", "add"]);
      const service = new GitService(repoDir);

      const { files } = asList(await service.compareWorktrees("main", "other"));

      expect(files).toEqual([{ status: "A", path: name, insertions: 2, deletions: 0 }]);
      const diff = await service.compareWorktrees("main", "other", files[0].path);
      expect(diff).not.toBe("NO_CHANGES");
      expect(diff).toContain("+second");
    });

    it("keeps a deleted and a binary file exact on a merge-base comparison", async () => {
      git(repoDir, ["checkout", "-q", "main"]);
      write(repoDir, " leading.txt", "gone\n");
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-qm", "seed"]);
      git(repoDir, ["checkout", "-q", "other"]);
      git(repoDir, ["merge", "-q", "main"]);
      git(repoDir, ["rm", "-q", "--", " leading.txt"]);
      fs.writeFileSync(path.join(repoDir, "a\\b.bin"), Buffer.from([0, 1, 2, 0, 255]));
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-qm", "change"]);
      const service = new GitService(repoDir);

      const { files } = asList(await service.compareWorktrees("main", "other", undefined, true));

      expect(files).toEqual(
        expect.arrayContaining([
          { status: "D", path: " leading.txt", insertions: 0, deletions: 1 },
          { status: "A", path: "a\\b.bin", insertions: null, deletions: null },
        ])
      );
      expect(files).toHaveLength(2);
      expect(await service.compareWorktrees("main", "other", " leading.txt", true)).toContain(
        "-gone"
      );
    });

    it("keeps both sides of a rename exact and matches their churn", async () => {
      git(repoDir, ["mv", "rename me.txt", QUOTE]);
      fs.appendFileSync(path.join(repoDir, QUOTE), "six\n");
      git(repoDir, ["commit", "-qam", "rename"]);
      const service = new GitService(repoDir);

      const { files } = asList(await service.compareWorktrees("main", "other"));

      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({
        status: "R",
        path: QUOTE,
        oldPath: "rename me.txt",
        insertions: 6,
        deletions: 5,
      });
    });
  }
);
