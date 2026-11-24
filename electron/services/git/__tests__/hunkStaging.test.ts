import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import childProcess, { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatHunk, parseFilePatch } from "../../../../shared/utils/patchHunks.js";
import { applyReadHunks, gitPathFor, parseReadHunks } from "../hunkStaging.js";

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

// Real git through the real spawn, which a test can intercept to run another
// writer at an exact moment of the service's sequence.
const originalSpawn = childProcess.spawn;
let onSpawn: ((args: readonly string[]) => void) | null = null;

/** The git subcommand, past the `-c key=value` pairs every hardened call leads with. */
function subcommand(args: readonly string[]): string | undefined {
  let i = 0;
  while (args[i] === "-c") i += 2;
  return args[i];
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
  (childProcess as { spawn: typeof originalSpawn }).spawn = ((...args: unknown[]) => {
    if (Array.isArray(args[1])) onSpawn?.(args[1] as string[]);
    return (originalSpawn as (...a: unknown[]) => ReturnType<typeof originalSpawn>)(...args);
  }) as typeof originalSpawn;
  syncBuiltinESMExports();
});

afterAll(() => {
  (childProcess as { spawn: typeof originalSpawn }).spawn = originalSpawn;
  syncBuiltinESMExports();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  onSpawn = null;
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

  it("stages several hunks of one selection together", async () => {
    commit(BASE);
    write(BOTH);

    const result = await applyReadHunks(
      repo,
      "f.txt",
      parseReadHunks(readHunks("unstaged")),
      "stage"
    );

    expect(result).toEqual({ status: "applied" });
    expect(indexBlob()).toBe(text(BOTH));
  });

  it("writes nothing when one hunk of a selection was rewritten", async () => {
    commit(BASE);
    write(BOTH);
    const read = readHunks("unstaged");
    write([...TOP.slice(0, 25), "line 26 rewritten", ...TOP.slice(26)]);

    const result = await applyReadHunks(repo, "f.txt", parseReadHunks(read), "stage");

    expect(result).toEqual({ status: "stale" });
    expect(indexBlob()).toBe(text(BASE));
  });

  it("stages a zero-context insertion at its own line past a skipped deletion", async () => {
    commit(BASE);
    git(repo, "config", "diff.context", "0");
    write([...BASE.slice(0, 2), ...BASE.slice(6, 20), "inserted", ...BASE.slice(20)]);
    const read = readHunks("unstaged");
    expect(read).toHaveLength(2);

    const result = await applyReadHunks(repo, "f.txt", parseReadHunks([read[1]!]), "stage");

    expect(result).toEqual({ status: "applied" });
    expect(indexBlob()).toBe(text([...BASE.slice(0, 20), "inserted", ...BASE.slice(20)]));
  });

  it("refuses as stale when another writer moves the entry after the hunk was checked", async () => {
    commit(BASE);
    git(repo, "config", "diff.context", "0");
    write([...BASE.slice(0, 20), "inserted", ...BASE.slice(20)]);
    const [insertion] = readHunks("unstaged");
    // The same insertion staged by someone else after the hunk was checked,
    // just before the apply.
    const ran: Array<string | undefined> = [];
    let listed = 0;
    onSpawn = (args) => {
      ran.push(subcommand(args));
      if (subcommand(args) === "ls-files" && ++listed === 2) git(repo, "add", "f.txt");
    };

    const result = await applyReadHunks(repo, "f.txt", parseReadHunks([insertion!]), "stage");

    expect(result).toEqual({ status: "stale" });
    expect(ran).toEqual(["ls-files", "diff", "ls-files"]);
    expect(indexBlob()).toBe(text([...BASE.slice(0, 20), "inserted", ...BASE.slice(20)]));
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

  // A worktree chmod sets no executable bit git can see on Windows.
  it.skipIf(process.platform === "win32")(
    "keeps the index's mode when the file also became executable",
    async () => {
      commit(BASE);
      git(repo, "config", "core.fileMode", "true");
      write(BOTH);
      fs.chmodSync(path.join(repo, "f.txt"), 0o755);
      const [first] = readHunks("unstaged");

      const result = await applyReadHunks(repo, "f.txt", parseReadHunks([first!]), "stage");

      expect(result).toEqual({ status: "applied" });
      expect(git(repo, "ls-files", "-s", "f.txt")).toMatch(/^100644 /);
      expect(indexBlob()).toBe(text(TOP));
    }
  );

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

  it("refuses a zero-context hunk the pane placed through a replaced index blob", async () => {
    commit(BASE);
    git(repo, "config", "diff.context", "0");
    write([...BASE.slice(0, 20), "inserted", ...BASE.slice(20)]);
    const real = git(repo, "rev-parse", ":f.txt").trim();
    const replacement = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: repo,
      env: GIT_ENV,
      input: text(["replaced extra", ...BASE]),
      encoding: "utf8",
    }).trim();
    git(repo, "replace", real, replacement);
    // Plain git, as the pane reads, puts the insertion one line further down,
    // past a line the real index doesn't hold; with no context to check, only
    // its start says where it goes.
    const [, insertion] = readHunks("unstaged");

    const result = await applyReadHunks(repo, "f.txt", parseReadHunks([insertion!]), "stage");

    expect(result).toEqual({ status: "stale" });
    expect(git(repo, "--no-replace-objects", "show", ":f.txt")).toBe(text(BASE));
  });

  it("refuses an unstage whose hunk moved in the index after it was read", async () => {
    commit(BASE);
    write(BOTH);
    git(repo, "add", "f.txt");
    const [, second] = readHunks("staged");
    // Three lines added above the hunk move its new start; HEAD, and so its old start, stay put.
    write(["agent 1", "agent 2", "agent 3", ...BOTH]);
    git(repo, "add", "f.txt");
    const index = indexBlob();

    const result = await applyReadHunks(repo, "f.txt", parseReadHunks([second!]), "unstage");

    expect(result).toEqual({ status: "stale" });
    expect(indexBlob()).toBe(index);
  });

  it("refuses a hunk read with a replacement character, which could stand for other bytes", async () => {
    commit(BASE);
    write(["line 1 \ufffd", ...BASE.slice(1)]);
    const [read] = readHunks("unstaged");

    const result = await applyReadHunks(repo, "f.txt", parseReadHunks([read!]), "stage");

    expect(result).toEqual({ status: "unsupported" });
    expect(indexBlob()).toBe(text(BASE));
  });

  it.skipIf(process.platform === "win32")(
    "stages the file named with a backslash, not its slash-named neighbour",
    async () => {
      fs.mkdirSync(path.join(repo, "a"));
      for (const file of ["a\\b.txt", "a/b.txt"]) write(BASE, file);
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "base");
      for (const file of ["a\\b.txt", "a/b.txt"]) write(TOP, file);
      const [read] = readHunks("unstaged", "a\\b.txt");

      const result = await applyReadHunks(
        repo,
        gitPathFor("a\\b.txt"),
        parseReadHunks([read!]),
        "stage"
      );

      expect(result).toEqual({ status: "applied" });
      expect(indexBlob("a\\b.txt")).toBe(text(TOP));
      expect(indexBlob("a/b.txt")).toBe(text(BASE));
    }
  );

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

describe("gitPathFor", () => {
  it("turns separators into git's slashes on Windows only", () => {
    expect(gitPathFor("src\\a.ts", "win32")).toBe("src/a.ts");
    expect(gitPathFor("src\\a.ts", "darwin")).toBe("src\\a.ts");
    expect(gitPathFor("src\\a.ts", "linux")).toBe("src\\a.ts");
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
