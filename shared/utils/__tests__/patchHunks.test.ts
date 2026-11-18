import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildHunkPatch,
  matchHunks,
  formatHunk,
  hasNoContext,
  hunksWithin,
  isPlainModification,
  parseFilePatch,
  sameHunkBody,
} from "../patchHunks.js";

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function repoWith(content: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "daintree-hunks-")));
  roots.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "repo@example.com"]);
  git(dir, ["config", "user.name", "Repo Owner"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "f.txt"), content);
  git(dir, ["add", "f.txt"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  return dir;
}

const numbered = (count: number, label = "line"): string[] =>
  Array.from({ length: count }, (_, i) => `${label} ${i + 1}`);

const indexBlob = (dir: string): string => git(dir, ["show", ":f.txt"]);

describe("parseFilePatch", () => {
  it("reads a header and git's hunks, defaulting omitted counts to one", () => {
    const patch = parseFilePatch(
      [
        "diff --git a/f b/f",
        "index 111..222 100644",
        "--- a/f",
        "+++ b/f",
        "@@ -1 +1 @@ fn()",
        "-a",
        "+b",
        "@@ -5,2 +5,3 @@",
        " c",
        "+d",
        " e",
        "",
      ].join("\n")
    );
    expect(patch?.header).toEqual([
      "diff --git a/f b/f",
      "index 111..222 100644",
      "--- a/f",
      "+++ b/f",
    ]);
    expect(patch?.hunks.map(({ lines, ...range }) => ({ range, lines }))).toEqual([
      {
        range: { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, section: " fn()" },
        lines: ["-a", "+b"],
      },
      {
        range: { oldStart: 5, oldLines: 2, newStart: 5, newLines: 3, section: "" },
        lines: [" c", "+d", " e"],
      },
    ]);
  });

  it("keeps no-newline markers and carriage returns verbatim", () => {
    const text = "@@ -1 +1 @@\n-old\r\n\\ No newline at end of file\n+new\r\n";
    const patch = parseFilePatch(text);
    expect(patch?.header).toEqual([]);
    expect(patch?.hunks[0]?.lines).toEqual(["-old\r", "\\ No newline at end of file", "+new\r"]);
    expect(formatHunk(patch!.hunks[0]!)).toBe(text.slice(0, -1));
  });

  it("reads an empty line inside a hunk as the blank context line it stands for", () => {
    const suppressed = parseFilePatch("@@ -1,3 +1,3 @@\n-a\n+b\n\n c\n");
    const plain = parseFilePatch("@@ -1,3 +1,3 @@\n-a\n+b\n \n c\n");
    expect(suppressed?.hunks[0]?.lines).toEqual(["-a", "+b", " ", " c"]);
    expect(sameHunkBody(suppressed!.hunks[0]!, plain!.hunks[0]!)).toBe(true);
  });

  it("keeps a section that ends in a carriage return or holds a line separator", () => {
    const patch = parseFilePatch(
      "@@ -1 +1 @@ function f() {\r\n-a\n+b\n@@ -9 +9 @@ g\u2028h\n-c\n+d\n"
    );
    expect(patch?.hunks.map((hunk) => hunk.section)).toEqual([" function f() {\r", " g\u2028h"]);
  });

  it("reads a line that looks like a hunk header as content when the counts say so", () => {
    const patch = parseFilePatch("@@ -1,2 +1,2 @@\n-x\n+@@ -9 +9 @@\n y\n");
    expect(patch?.hunks).toHaveLength(1);
    expect(patch?.hunks[0]?.lines).toEqual(["-x", "+@@ -9 +9 @@", " y"]);
  });

  it("refuses a second file, a short hunk, and a stray line", () => {
    expect(
      parseFilePatch("diff --git a/a b/a\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/b b/b\n")
    ).toBeNull();
    expect(parseFilePatch("diff --git a/a b/a\ndiff --git a/b b/b\n")).toBeNull();
    expect(parseFilePatch("@@ -1,2 +1,2 @@\n-a\n+b\n")).toBeNull();
    expect(parseFilePatch("@@ -1 +1 @@\n-a\n+b\nnot a patch line\n")).toBeNull();
  });
});

describe("matchHunks", () => {
  const patch = parseFilePatch(
    "@@ -1,2 +1,2 @@\n-a\n+b\n c\n@@ -10,2 +10,2 @@\n-a\n+b\n c\n@@ -20,2 +20,2 @@\n-x\n+y\n z\n"
  )!;
  const hunk = (text: string) => parseFilePatch(text)!.hunks[0]!;

  it("takes a matching body at the old start it was read at, wherever its new start moved", () => {
    expect([...matchHunks(patch, [hunk("@@ -10,2 +14,2 @@\n-a\n+b\n c\n")])!]).toEqual([1]);
  });

  it("takes every hunk of a selection, or none when one of them is missing", () => {
    const first = hunk("@@ -1,2 +1,2 @@\n-a\n+b\n c\n");
    const third = hunk("@@ -20,2 +20,2 @@\n-x\n+y\n z\n");
    expect([...matchHunks(patch, [first, third])!]).toEqual([0, 2]);
    expect(matchHunks(patch, [first, hunk("@@ -20,2 +20,2 @@\n-x\n+q\n z\n")])).toBeNull();
  });

  it("pins the new start too for an unstage, whose new side is the index it writes", () => {
    const shifted = hunk("@@ -10,2 +14,2 @@\n-a\n+b\n c\n");
    expect(matchHunks(patch, [shifted], { matchNewStart: true })).toBeNull();
    expect([
      ...matchHunks(patch, [hunk("@@ -10,2 +10,2 @@\n-a\n+b\n c\n")], { matchNewStart: true })!,
    ]).toEqual([1]);
  });

  it("never takes the same body at another old start", () => {
    expect(matchHunks(patch, [hunk("@@ -17,2 +17,2 @@\n-x\n+y\n z\n")])).toBeNull();
  });

  it("refuses the surviving twin once the hunk that was read is rewritten", () => {
    const rewritten = parseFilePatch(
      "@@ -1,2 +1,2 @@\n-a\n+q\n c\n@@ -10,2 +10,2 @@\n-a\n+b\n c\n"
    )!;
    expect(matchHunks(rewritten, [hunk("@@ -1,2 +1,2 @@\n-a\n+b\n c\n")])).toBeNull();
  });

  it("matches one fresh hunk once, however often it was sent", () => {
    const read = hunk("@@ -10,2 +10,2 @@\n-a\n+b\n c\n");
    expect(matchHunks(patch, [read, read])).toBeNull();
  });

  it("finds nothing once the lines were rewritten", () => {
    const rewritten = hunk("@@ -20,2 +20,2 @@\n-x\n+q\n z\n");
    expect(matchHunks(patch, [rewritten])).toBeNull();
    expect(sameHunkBody(patch.hunks[2]!, rewritten)).toBe(false);
  });
});

describe("isPlainModification", () => {
  const header = (...extra: string[]): string[] => [
    "diff --git a/f b/f",
    ...extra,
    "--- a/f",
    "+++ b/f",
  ];

  it("takes a regular file changed in place, with or without an executable-bit change", () => {
    expect(isPlainModification(header("index 1a..2b 100644"))).toBe(true);
    expect(isPlainModification(header("old mode 100644", "new mode 100755", "index 1a..2b"))).toBe(
      true
    );
  });

  it("refuses new, deleted, renamed, symlink and submodule entries", () => {
    expect(
      isPlainModification([
        "diff --git a/f b/f",
        "new file mode 100644",
        "index 0..2b",
        "--- /dev/null",
        "+++ b/f",
      ])
    ).toBe(false);
    expect(
      isPlainModification(["diff --git a/f b/f", "index 1a..0", "--- a/f", "+++ /dev/null"])
    ).toBe(false);
    expect(
      isPlainModification(
        header("similarity index 90%", "rename from e", "rename to f", "index 1a..2b 100644")
      )
    ).toBe(false);
    expect(isPlainModification(header("index 1a..2b 120000"))).toBe(false);
    expect(isPlainModification(header("index 1a..2b 160000"))).toBe(false);
  });

  it("refuses a header missing its file lines or repeating one", () => {
    expect(isPlainModification(["diff --git a/f b/f", "index 1a..2b 100644"])).toBe(false);
    expect(isPlainModification(header("index 1a..2b 100644", "index 1a..2b 100644"))).toBe(false);
  });
});

describe("hunksWithin", () => {
  const patch = parseFilePatch(
    "@@ -2,3 +2,4 @@\n a\n+b\n c\n d\n@@ -20,3 +21,2 @@\n x\n-y\n z\n@@ -40,0 +40,1 @@\n+n\n"
  )!;

  it("maps an unmerged hunk to itself", () => {
    expect(hunksWithin(patch, { oldStart: 20, oldLines: 3, newStart: 21, newLines: 2 })).toEqual([
      1,
    ]);
    expect(hunksWithin(patch, { oldStart: 40, oldLines: 0, newStart: 40, newLines: 1 })).toEqual([
      2,
    ]);
  });

  it("leaves out a git hunk that only one side of the rendered range holds", () => {
    // Old side covers the second hunk; the new side stops short of it.
    expect(hunksWithin(patch, { oldStart: 18, oldLines: 6, newStart: 10, newLines: 5 })).toEqual(
      []
    );
    // New side covers it; the old side starts past it.
    expect(hunksWithin(patch, { oldStart: 21, oldLines: 5, newStart: 19, newLines: 6 })).toEqual(
      []
    );
  });

  it("places a zero-count change after the line its header names", () => {
    // `-40,0` sits between old lines 40 and 41, so a rendered range opening on
    // old line 41 holds it, and one opening on 42 doesn't. The new side holds
    // the inserted line in both.
    expect(hunksWithin(patch, { oldStart: 41, oldLines: 3, newStart: 40, newLines: 4 })).toEqual([
      2,
    ]);
    expect(hunksWithin(patch, { oldStart: 42, oldLines: 3, newStart: 40, newLines: 4 })).toEqual(
      []
    );
  });

  it("maps a hunk merged by expanded context to every git hunk inside it", () => {
    expect(hunksWithin(patch, { oldStart: 1, oldLines: 25, newStart: 1, newLines: 25 })).toEqual([
      0, 1,
    ]);
    expect(hunksWithin(patch, { oldStart: 1, oldLines: 50, newStart: 1, newLines: 51 })).toEqual([
      0, 1, 2,
    ]);
  });
});

describe("buildHunkPatch against real git", () => {
  // Two hunks far enough apart to stay separate, the first adding lines.
  const base = numbered(30);
  const edited = [
    "added 1",
    "added 2",
    "added 3",
    ...base.slice(0, 20),
    "line 21 changed",
    ...base.slice(21),
  ];

  it("stages only the later hunk, at its own place, past an unstaged hunk that adds lines", () => {
    const dir = repoWith(`${base.join("\n")}\n`);
    fs.writeFileSync(path.join(dir, "f.txt"), `${edited.join("\n")}\n`);
    const patch = parseFilePatch(git(dir, ["diff", "--", "f.txt"]))!;
    expect(patch.hunks).toHaveLength(2);

    git(dir, ["apply", "--cached", "-"], buildHunkPatch(patch, new Set([1]), "forward"));

    expect(indexBlob(dir)).toBe(
      `${[...base.slice(0, 20), "line 21 changed", ...base.slice(21)].join("\n")}\n`
    );
  });

  it("lands the hunk at its own place when an identical block sits where the unshifted offset points", () => {
    // The unstaged first hunk adds 10 lines, so the second one's new start is
    // 10 past its place in the index. The block it changes repeats 6 lines
    // lower, nearer to that unshifted start than its own copy is, so a patch
    // that kept the worktree's numbering would change the wrong one.
    const dups = (count: number): string[] => Array.from({ length: count }, () => "dup");
    const baseLines = [
      ...numbered(10),
      ...dups(3),
      "target",
      ...dups(5),
      "target",
      ...dups(3),
      ...numbered(10, "tail"),
    ];
    const targetIndex = 13;
    const editedLines = [...numbered(10, "new"), ...baseLines];
    editedLines[10 + targetIndex] = "target changed";
    const dir = repoWith(`${baseLines.join("\n")}\n`);
    fs.writeFileSync(path.join(dir, "f.txt"), `${editedLines.join("\n")}\n`);
    const patch = parseFilePatch(git(dir, ["diff", "--", "f.txt"]))!;
    expect(patch.hunks).toHaveLength(2);

    const expected = [...baseLines];
    expected[targetIndex] = "target changed";
    const unshifted = { ...patch, hunks: [patch.hunks[1]!] };
    const scratch = repoWith(`${baseLines.join("\n")}\n`);
    git(scratch, ["apply", "--cached", "-"], buildHunkPatch(unshifted, new Set([0]), "forward"));
    expect(indexBlob(scratch)).not.toBe(`${expected.join("\n")}\n`);

    git(dir, ["apply", "--cached", "-"], buildHunkPatch(patch, new Set([1]), "forward"));

    expect(indexBlob(dir)).toBe(`${expected.join("\n")}\n`);
  });

  it("unstages only the later staged hunk and keeps the earlier one staged", () => {
    const dir = repoWith(`${base.join("\n")}\n`);
    fs.writeFileSync(path.join(dir, "f.txt"), `${edited.join("\n")}\n`);
    git(dir, ["add", "f.txt"]);
    const patch = parseFilePatch(git(dir, ["diff", "--cached", "--", "f.txt"]))!;
    expect(patch.hunks).toHaveLength(2);

    git(dir, ["apply", "--cached", "-R", "-"], buildHunkPatch(patch, new Set([1]), "reverse"));

    expect(indexBlob(dir)).toBe(`${["added 1", "added 2", "added 3", ...base].join("\n")}\n`);
  });

  it("unstages the later hunk at its own place when an identical staged block sits nearer the unshifted start", () => {
    // Reverse: git looks for the hunk's staged text in the index, starting at
    // its old (HEAD) start. The staged first hunk adds 10 lines the index
    // keeps, so that start is 10 short of the hunk's place. HEAD already holds
    // the same changed block 6 lines above it, nearer the unshifted start, so
    // an unshifted patch would unstage that one instead.
    const dups = (count: number): string[] => Array.from({ length: count }, () => "dup");
    const baseLines = [
      ...numbered(10),
      ...dups(3),
      "target changed",
      ...dups(5),
      "target",
      ...dups(3),
      ...numbered(10, "tail"),
    ];
    const staged = [...numbered(10, "new"), ...baseLines];
    staged[10 + 19] = "target changed";
    const dir = repoWith(`${baseLines.join("\n")}\n`);
    fs.writeFileSync(path.join(dir, "f.txt"), `${staged.join("\n")}\n`);
    git(dir, ["add", "f.txt"]);
    const patch = parseFilePatch(git(dir, ["diff", "--cached", "--", "f.txt"]))!;
    expect(patch.hunks).toHaveLength(2);

    const unshifted = buildHunkPatch(
      { ...patch, hunks: [patch.hunks[1]!] },
      new Set([0]),
      "reverse"
    );
    const scratch = repoWith(`${baseLines.join("\n")}\n`);
    fs.writeFileSync(path.join(scratch, "f.txt"), `${staged.join("\n")}\n`);
    git(scratch, ["add", "f.txt"]);
    let unshiftedResult: string | null = null;
    try {
      git(scratch, ["apply", "--cached", "-R", "-"], unshifted);
      unshiftedResult = indexBlob(scratch);
    } catch {
      unshiftedResult = null;
    }
    const expected = `${[...numbered(10, "new"), ...baseLines].join("\n")}\n`;
    expect(unshiftedResult).not.toBe(expected);

    git(dir, ["apply", "--cached", "-R", "-"], buildHunkPatch(patch, new Set([1]), "reverse"));

    expect(indexBlob(dir)).toBe(expected);
  });

  it("unstages the earlier hunk and leaves the later one staged", () => {
    const dir = repoWith(`${base.join("\n")}\n`);
    fs.writeFileSync(path.join(dir, "f.txt"), `${edited.join("\n")}\n`);
    git(dir, ["add", "f.txt"]);
    const patch = parseFilePatch(git(dir, ["diff", "--cached", "--", "f.txt"]))!;

    git(dir, ["apply", "--cached", "-R", "-"], buildHunkPatch(patch, new Set([0]), "reverse"));

    expect(indexBlob(dir)).toBe(
      `${[...base.slice(0, 20), "line 21 changed", ...base.slice(21)].join("\n")}\n`
    );
  });

  it("stages what git add -p stages for the same choice", () => {
    const viaPatch = repoWith(`${base.join("\n")}\n`);
    const viaAddP = repoWith(`${base.join("\n")}\n`);
    for (const dir of [viaPatch, viaAddP]) {
      fs.writeFileSync(path.join(dir, "f.txt"), `${edited.join("\n")}\n`);
    }
    const patch = parseFilePatch(git(viaPatch, ["diff", "--", "f.txt"]))!;
    git(viaPatch, ["apply", "--cached", "-"], buildHunkPatch(patch, new Set([1]), "forward"));
    git(viaAddP, ["add", "-p", "--", "f.txt"], "n\ny\n");

    expect(indexBlob(viaPatch)).toBe(indexBlob(viaAddP));
  });

  it("unstages what git reset -p unstages for the same choice", () => {
    const viaPatch = repoWith(`${base.join("\n")}\n`);
    const viaResetP = repoWith(`${base.join("\n")}\n`);
    for (const dir of [viaPatch, viaResetP]) {
      fs.writeFileSync(path.join(dir, "f.txt"), `${edited.join("\n")}\n`);
      git(dir, ["add", "f.txt"]);
    }
    const patch = parseFilePatch(git(viaPatch, ["diff", "--cached", "--", "f.txt"]))!;
    git(viaPatch, ["apply", "--cached", "-R", "-"], buildHunkPatch(patch, new Set([1]), "reverse"));
    git(viaResetP, ["reset", "-p", "--", "f.txt"], "n\ny\n");

    expect(indexBlob(viaPatch)).toBe(indexBlob(viaResetP));
  });

  it("lands a zero-context insertion at its own line past a skipped deletion", () => {
    const dir = repoWith(`${base.join("\n")}\n`);
    git(dir, ["config", "diff.context", "0"]);
    const lines = [...base.slice(0, 2), ...base.slice(6, 20), "inserted", ...base.slice(20)];
    fs.writeFileSync(path.join(dir, "f.txt"), `${lines.join("\n")}\n`);
    const patch = parseFilePatch(git(dir, ["diff", "--", "f.txt"]))!;
    expect(patch.hunks).toHaveLength(2);
    expect(hasNoContext(patch.hunks[1]!)).toBe(true);

    git(
      dir,
      ["apply", "--cached", "--unidiff-zero", "-"],
      buildHunkPatch(patch, new Set([1]), "forward")
    );

    expect(indexBlob(dir)).toBe(
      `${[...base.slice(0, 20), "inserted", ...base.slice(20)].join("\n")}\n`
    );
  });

  // A worktree chmod sets no executable bit git can see on Windows.
  it.skipIf(process.platform === "win32")(
    "stages a last line that gains its newline, and leaves out a mode change",
    () => {
      const dir = repoWith(`${numbered(3).join("\n")}`);
      fs.writeFileSync(path.join(dir, "f.txt"), `${numbered(3).join("\n")}\n`);
      fs.chmodSync(path.join(dir, "f.txt"), 0o755);
      const diff = git(dir, ["-c", "core.fileMode=true", "diff", "--", "f.txt"]);
      expect(diff).toContain("new mode 100755");
      const patch = parseFilePatch(diff)!;

      git(dir, ["apply", "--cached", "-"], buildHunkPatch(patch, new Set([0]), "forward"));

      expect(indexBlob(dir)).toBe(`${numbered(3).join("\n")}\n`);
      expect(git(dir, ["ls-files", "-s", "f.txt"])).toMatch(/^100644 /);
    }
  );
});
