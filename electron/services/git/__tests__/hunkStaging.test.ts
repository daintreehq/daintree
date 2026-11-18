import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatHunk, parseFilePatch } from "../../../../shared/utils/patchHunks.js";
import { applyReadHunks, parseReadHunks } from "../hunkStaging.js";

// Inherited GIT_* (a hook's GIT_DIR or GIT_INDEX_FILE) would point fixture git
// at another repository.
const GIT_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.test",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.test",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
}

let home: string;
let tmp: string;
let repo: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  // The service's git reads the user's global config: give it a home of the
  // test's own and no system file.
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hunk-staging-home-")));
  for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "GIT_CONFIG_NOSYSTEM"]) {
    savedEnv[key] = process.env[key];
  }
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hunk-staging-")));
  repo = path.join(tmp, "repo");
  git(tmp, "init", "-q", "-b", "main", repo);
  return () => fs.rmSync(tmp, { recursive: true, force: true });
});

const lines = (count: number, label = "line"): string[] =>
  Array.from({ length: count }, (_, i) => `${label} ${i + 1}`);
const text = (rows: readonly string[]): string => `${rows.join("\n")}\n`;
const BASE = lines(30);
const write = (rows: readonly string[], file = "f.txt") =>
  fs.writeFileSync(path.join(repo, file), text(rows));
const indexBlob = (file = "f.txt") => git(repo, "show", `:${file}`);

function commit(rows: readonly string[], file = "f.txt"): void {
  write(rows, file);
  git(repo, "add", file);
  git(repo, "commit", "-q", "-m", "base");
}

/** What the diff pane would read for one side, as the hunk texts it sends back. */
function readHunks(side: "unstaged" | "staged", file = "f.txt"): string[] {
  const diff = git(repo, "diff", ...(side === "staged" ? ["--cached"] : []), "--", file);
  return parseFilePatch(diff)!.hunks.map(formatHunk);
}

// An edit near the top and one near the bottom: two hunks.
const TOP = ["line 1 changed", ...BASE.slice(1)];
const BOTH = [...TOP.slice(0, 25), "line 26 changed", ...TOP.slice(26)];

describe("applyReadHunks (real git)", () => {
  it("stages one unstaged hunk and leaves the other one, and the file, alone", async () => {
    commit(BASE);
    write(BOTH);
    const [, second] = readHunks("unstaged");

    const result = await applyReadHunks(repo, "f.txt", parseReadHunks([second!]), "stage");

    expect(result).toEqual({ status: "applied" });
    expect(indexBlob()).toBe(text([...BASE.slice(0, 25), "line 26 changed", ...BASE.slice(26)]));
    expect(fs.readFileSync(path.join(repo, "f.txt"), "utf8")).toBe(text(BOTH));
  });

  it("unstages one staged hunk and keeps the other one staged", async () => {
    commit(BASE);
    write(BOTH);
    git(repo, "add", "f.txt");
    const [first] = readHunks("staged");

    const result = await applyReadHunks(repo, "f.txt", parseReadHunks([first!]), "unstage");

    expect(result).toEqual({ status: "applied" });
    expect(indexBlob()).toBe(text([...BASE.slice(0, 25), "line 26 changed", ...BASE.slice(26)]));
  });

  it("still stages the hunk that was read after an agent adds lines above it", async () => {
    commit(BASE);
    write(BOTH);
    const [, second] = readHunks("unstaged");
    // The agent keeps writing near the top: the second hunk's new start moves.
    write(["agent 1", "agent 2", ...BOTH]);

    const result = await applyReadHunks(repo, "f.txt", parseReadHunks([second!]), "stage");

    expect(result).toEqual({ status: "applied" });
    expect(indexBlob()).toBe(text([...BASE.slice(0, 25), "line 26 changed", ...BASE.slice(26)]));
  });

  it("refuses as stale once an agent rewrites the lines that were read", async () => {
    commit(BASE);
    write(BOTH);
    const [, second] = readHunks("unstaged");
    write([...TOP.slice(0, 25), "line 26 rewritten", ...TOP.slice(26)]);

    const result = await applyReadHunks(repo, "f.txt", parseReadHunks([second!]), "stage");

    expect(result).toEqual({ status: "stale" });
    expect(indexBlob()).toBe(text(BASE));
  });

  it("refuses as stale rather than stage the twin of a rewritten hunk", async () => {
    const block = ["a", "b", "c", "target", "d", "e", "f"];
    const base = [...block, ...lines(10, "gap"), ...block];
    commit(base);
    const both = [...base];
    both[3] = "target changed";
    both[20] = "target changed";
    write(both);
    const [first] = readHunks("unstaged");
    // The first copy changes again; only the second still matches the read.
    const rewritten = [...both];
    rewritten[3] = "target rewritten";
    write(rewritten);

    const result = await applyReadHunks(repo, "f.txt", parseReadHunks([first!]), "stage");

    expect(result).toEqual({ status: "stale" });
    expect(indexBlob()).toBe(text(base));
  });

  it("stages under a user's diff.noprefix and diff.context, reading hunks the same way", async () => {
    commit(BASE);
    git(repo, "config", "diff.noprefix", "true");
    git(repo, "config", "diff.context", "1");
    write(BOTH);
    const read = readHunks("unstaged");
    expect(read).toHaveLength(2);

    const result = await applyReadHunks(repo, "f.txt", parseReadHunks([read[0]!]), "stage");

    expect(result).toEqual({ status: "applied" });
    expect(indexBlob()).toBe(text(TOP));
  });

  it("keeps the index's mode when the file also became executable", async () => {
    commit(BASE);
    git(repo, "config", "core.fileMode", "true");
    write(BOTH);
    fs.chmodSync(path.join(repo, "f.txt"), 0o755);
    const [first] = readHunks("unstaged");

    const result = await applyReadHunks(repo, "f.txt", parseReadHunks([first!]), "stage");

    expect(result).toEqual({ status: "applied" });
    expect(git(repo, "ls-files", "-s", "f.txt")).toMatch(/^100644 /);
    expect(indexBlob()).toBe(text(TOP));
  });

  it("refuses a file git doesn't track, and one whose diff isn't UTF-8", async () => {
    commit(BASE);
    write(BOTH, "new.txt");
    const hunk = `@@ -0,0 +1,2 @@\n+a\n+b`;
    expect(await applyReadHunks(repo, "new.txt", parseReadHunks([hunk]), "stage")).toEqual({
      status: "unsupported",
    });

    fs.writeFileSync(path.join(repo, "f.txt"), Buffer.from([0x6c, 0xe9, 0x0a]));
    const lossy = `@@ -1 +1 @@\n-line 1\n+l�`;
    expect(await applyReadHunks(repo, "f.txt", parseReadHunks([lossy]), "stage")).toEqual({
      status: "unsupported",
    });
    expect(indexBlob()).toBe(text(BASE));
  });

  it("reports a held index lock as GIT_INDEX_LOCKED and writes nothing", async () => {
    commit(BASE);
    write(BOTH);
    const [first] = readHunks("unstaged");
    fs.writeFileSync(path.join(repo, ".git", "index.lock"), "");

    await expect(
      applyReadHunks(repo, "f.txt", parseReadHunks([first!]), "stage")
    ).rejects.toMatchObject({ code: "GIT_INDEX_LOCKED" });

    fs.rmSync(path.join(repo, ".git", "index.lock"));
    expect(indexBlob()).toBe(text(BASE));
  });
});

describe("parseReadHunks", () => {
  it("refuses anything but one bare hunk per text", () => {
    expect(() => parseReadHunks(["not a hunk"])).toThrow();
    expect(() => parseReadHunks(["diff --git a/f b/f\n@@ -1 +1 @@\n-a\n+b"])).toThrow();
    expect(() => parseReadHunks(["@@ -1 +1 @@\n-a\n+b\n@@ -5 +5 @@\n-c\n+d"])).toThrow();
    expect(parseReadHunks(["@@ -1 +1 @@\n-a\n+b"])).toHaveLength(1);
  });
});
