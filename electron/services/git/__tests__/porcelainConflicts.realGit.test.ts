import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parsePorcelainV2Conflicts, PORCELAIN_V2_CONFLICT_ARGS } from "../porcelainConflicts.js";

// Real git: only a genuine unmerged index shows how git spells paths that it
// C-quotes even with core.quotepath=false (tab, double quote, newline).

const NAMES = [
  "tab\tfile.txt",
  'quote"file.txt',
  "new\nline.txt",
  "space file.txt",
  "日本語.txt",
  "plain.txt",
];

let root: string;
let repo: string;

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      LC_ALL: "C",
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function writeAll(content: string): void {
  for (const name of NAMES) fs.writeFileSync(path.join(repo, name), content);
  git("add", "-A");
}

// Windows filesystems reject tab, quote and newline in filenames.
describe.skipIf(process.platform === "win32")("parsePorcelainV2Conflicts (real git)", () => {
  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "daintree-conflicts-realgit-")));
    repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    git("init", "-q", "-b", "main");
    writeAll("base\n");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "topic");
    writeAll("topic\n");
    git("commit", "-q", "-m", "topic");
    git("checkout", "-q", "main");
    writeAll("main\n");
    git("commit", "-q", "-m", "main");
    try {
      git("merge", "-q", "topic");
    } catch {
      // The merge is expected to stop on conflicts.
    }
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reports every conflicted path exactly as it exists on disk", () => {
    const unmerged = new Set(
      git("ls-files", "--unmerged", "-z")
        .split("\0")
        .filter(Boolean)
        .map((record) => record.slice(record.indexOf("\t") + 1))
    );
    expect([...unmerged].sort()).toEqual([...NAMES].sort());

    const result = parsePorcelainV2Conflicts(git(...PORCELAIN_V2_CONFLICT_ARGS));
    expect(result.map((entry) => entry.path).sort()).toEqual([...NAMES].sort());
    for (const entry of result) {
      expect(fs.existsSync(path.join(repo, entry.path))).toBe(true);
      expect(entry).toMatchObject({ xy: "UU", label: "both modified" });
    }
  });
});
