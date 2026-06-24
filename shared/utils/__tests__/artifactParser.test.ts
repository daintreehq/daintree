import { describe, expect, it } from "vitest";
import {
  extractCodeBlocks,
  extractPatchFilename,
  extractPatches,
  normalizeCapturedOutput,
  stripAnsiCodes,
  suggestFilename,
  tailCapturedOutput,
} from "../artifactParser.js";

describe("artifactParser", () => {
  it("extracts code blocks with explicit language", () => {
    const blocks = extractCodeBlocks("```typescript\nconst x = 1;\n```\n");
    expect(blocks).toEqual([{ language: "typescript", content: "const x = 1;" }]);
  });

  it("defaults code block language to text when omitted", () => {
    const blocks = extractCodeBlocks("```\nhello\n```\n");
    expect(blocks).toEqual([{ language: "text", content: "hello" }]);
  });

  it("supports non-word language identifiers like c++", () => {
    const blocks = extractCodeBlocks("```c++\nint main() { return 0; }\n```\n");
    expect(blocks).toEqual([{ language: "c++", content: "int main() { return 0; }" }]);
  });

  it("ignores empty code blocks", () => {
    const blocks = extractCodeBlocks("```ts\n   \n```\n");
    expect(blocks).toEqual([]);
  });

  it("extracts multiple code blocks in order", () => {
    const blocks = extractCodeBlocks(
      "```js\nconst a = 1;\n```\ntext\n```python\ndef f(): pass\n```\n"
    );
    expect(blocks).toEqual([
      { language: "js", content: "const a = 1;" },
      { language: "python", content: "def f(): pass" },
    ]);
  });

  it("extracts a code block with content far larger than the worker's 5KB window", () => {
    const body = "const x = 1; // padding\n".repeat(500); // ~12KB
    const blocks = extractCodeBlocks("```typescript\n" + body + "```\n");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.language).toBe("typescript");
    expect(blocks[0]!.content).toBe(body.trim());
  });

  it("extracts unified diff patches", () => {
    const input = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
      "Some plain text after patch",
    ].join("\n");

    const patches = extractPatches(input);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toContain("+++ b/src/a.ts");
    expect(patches[0]).toContain("+new");
  });

  it("rejects Markdown horizontal rule followed by bulleted list (#9998)", () => {
    // The exact issue-9998 false positive: a `---` Markdown HR followed by
    // list items. The new heuristic must not emit any patch artifact.
    const input = ["---", "- item one", "- item two", "- item three"].join("\n");
    expect(extractPatches(input)).toEqual([]);
  });

  it("rejects YAML front matter with --- delimiters and no hunks (#9998)", () => {
    const input = ["---", "title: My Doc", "author: Greg", "---", "", "Body."].join("\n");
    expect(extractPatches(input)).toEqual([]);
  });

  it("rejects --- a/file opener with no +++ within lookahead window (#9998)", () => {
    // A `--- a/<file>` line that is followed by non-diff prose (no `+++ b/`
    // target header) must not be promoted to a diff. This is the case where
    // an agent's prose happens to mention a file path in a `---` line.
    const input = [
      "--- a/src/file.ts",
      "+ some addition",
      "+ another addition",
      "+ a third line",
    ].join("\n");
    expect(extractPatches(input)).toEqual([]);
  });

  it("accepts plain unified diff without diff --git preamble", () => {
    // Standard `git apply` / `diff -u` format: just the header pair + body.
    const input = ["--- a/file.txt", "+++ b/file.txt", "@@ -1 +1 @@", "-old", "+new"].join("\n");
    const patches = extractPatches(input);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toContain("--- a/file.txt");
    expect(patches[0]).toContain("+++ b/file.txt");
  });

  it("extracts diff body that follows a git format-patch envelope", () => {
    // The `From <sha>` envelope line is not a Tier 1 trigger on its own —
    // the downstream `diff --git` opens the patch block. The test pins the
    // behavior so a future change to the parser doesn't accidentally make
    // envelope lines alone emit a patch artifact.
    const input = [
      "From abcdef1234567890abcdef1234567890abcdef12 Mon Sep 17 00:00:00 2001",
      "Subject: [PATCH] Fix thing",
      "",
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "-- ",
      "2.34.1",
    ].join("\n");
    const patches = extractPatches(input);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toContain("@@ -1 +1 @@");
  });

  it("accepts combined diff with @@@ hunk header", () => {
    // `git diff -c` / `--cc` produces combined diffs with `@@@` (3+ `@`) hunk
    // headers and multiple `---` source headers before the target. The
    // `diff --combined` preamble is dropped (it doesn't match a body line)
    // and the block restarts on the first `--- a/<file>`.
    const input = [
      "diff --combined file.txt",
      "index abc,def..ghi",
      "--- a/file.txt",
      "--- a/file.txt",
      "+++ b/file.txt",
      "@@@ -1,1 -1,1 +1,1 @@@",
      "  unchanged",
      " -old1",
      " -old2",
      " +new1",
      " +new2",
    ].join("\n");
    const patches = extractPatches(input);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toContain("--- a/file.txt");
    expect(patches[0]).toContain("+++ b/file.txt");
    expect(patches[0]).toContain("@@@ -1,1 -1,1 +1,1 @@@");
  });

  it("rejects diff --git snippets that lack an @@ hunk header", () => {
    // A real `diff --git` preamble but no hunk — the hunk check at commit
    // time is the structural guard that `git apply` would also apply.
    const input = ["diff --git a/x b/x", "index abc..def 100644", "--- a/x"].join("\n");
    expect(extractPatches(input)).toEqual([]);
  });

  it("rejects prose that contains @@ but not as a real hunk header (#9998)", () => {
    // `@@user` and `@@@handle` are prose-shaped, not hunk headers — the
    // anchored `-\d+` requirement in the hunk regex stops them.
    const input = [
      "diff --git a/x b/x",
      "--- a/x",
      "+++ b/x",
      "@@user mentioned this in chat",
      "+ some body line",
      "+ another body line",
    ].join("\n");
    expect(extractPatches(input)).toEqual([]);
  });

  it("preserves \\ No newline at end of file marker (#9998)", () => {
    // `git diff` emits `\ No newline at end of file` after the last line of
    // a file that lacks a trailing newline. `git apply` requires this marker
    // and will reject a patch that drops it. The parser must treat the `\`-
    // prefixed line as a body line, not as prose that closes the block.
    const input = [
      "--- a/file",
      "+++ b/file",
      "@@ -1 +1 @@",
      "-line1",
      "\\ No newline at end of file",
      "+line2",
      "\\ No newline at end of file",
    ].join("\n");
    const patches = extractPatches(input);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toContain("\\ No newline at end of file");
    expect(patches[0]).toContain("+line2");
  });

  it("extracts multiple back-to-back diff blocks", () => {
    // Two `diff --git` hunks separated by a single line break — both must
    // be emitted as independent patches, in order.
    const input = [
      "diff --git a/x b/x",
      "--- a/x",
      "+++ b/x",
      "@@ -1 +1 @@",
      "-old1",
      "+new1",
      "diff --git a/y b/y",
      "--- a/y",
      "+++ b/y",
      "@@ -1 +1 @@",
      "-old2",
      "+new2",
    ].join("\n");
    const patches = extractPatches(input);
    expect(patches).toHaveLength(2);
    expect(patches[0]).toContain("+new1");
    expect(patches[1]).toContain("+new2");
    // The 2nd block's `diff --git` header sits on the line that ends the 1st
    // block. The opener must be re-evaluated after finalize() so it isn't
    // dropped (the `--- a/y` line independently re-opens the body, which would
    // mask the loss if only the body were checked).
    expect(patches[0]).toContain("diff --git a/x b/x");
    expect(patches[1]).toContain("diff --git a/y b/y");
  });

  it("extracts a new file diff with --- /dev/null", () => {
    // `git diff` for a newly added file shows `--- /dev/null` as the source
    // header. The opener is `--- /dev/null` (passes `isUnifiedOpener` — the
    // path-like token is `/`), and `+++ b/new` corroborates it.
    const input = [
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,3 @@",
      "+line1",
      "+line2",
      "+line3",
    ].join("\n");
    const patches = extractPatches(input);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toContain("--- /dev/null");
    expect(patches[0]).toContain("+++ b/new.txt");
  });

  it("extracts a deleted file diff with +++ /dev/null", () => {
    // Mirror of the new-file case: `+++ /dev/null` marks a deleted file.
    const input = [
      "--- a/old.txt",
      "+++ /dev/null",
      "@@ -1,3 +0,0 @@",
      "-line1",
      "-line2",
      "-line3",
    ].join("\n");
    const patches = extractPatches(input);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toContain("--- a/old.txt");
    expect(patches[0]).toContain("+++ /dev/null");
  });

  it("splits multi-file diffs at diff lines, not mid-patch --- lines", () => {
    const input = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-old a",
      "+new a",
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1 +1 @@",
      "-old b",
      "+new b",
    ].join("\n");

    const patches = extractPatches(input);
    expect(patches).toHaveLength(2);
    expect(patches[0]).toContain("+new a");
    expect(patches[0]).not.toContain("+new b");
    expect(patches[1]).toContain("+new b");
  });

  it("extracts a patch with a body far larger than the worker's 5KB window", () => {
    let patch = "diff --git a/big.ts b/big.ts\n--- a/big.ts\n+++ b/big.ts\n@@ -1,500 +1,500 @@\n";
    for (let i = 0; i < 500; i++) {
      patch += `+const generated${i} = ${i};\n`;
    }
    const patches = extractPatches(patch + "done\n");
    expect(patches).toHaveLength(1);
    expect(patches[0]).toContain("+const generated0 = 0;");
    expect(patches[0]).toContain("+const generated499 = 499;");
  });

  it("extracts patch filename from +++ line", () => {
    const filename = extractPatchFilename("+++ b/src/main.ts\n@@ -1 +1 @@");
    expect(filename).toBe("src/main.ts");
  });

  it("extracts patch filename from --- line when +++ is absent", () => {
    const filename = extractPatchFilename("--- a/src/legacy.ts\n@@ -1 +1 @@");
    expect(filename).toBe("src/legacy.ts");
  });

  it("returns undefined patch filename when no diff filename markers exist", () => {
    expect(extractPatchFilename("not a patch")).toBeUndefined();
  });

  it("suggests filename from class name for typed languages", () => {
    const suggested = suggestFilename("typescript", "export class TaskQueueService {}");
    expect(suggested).toBe("TaskQueueService.ts");
  });

  it("suggests filename from function name when class is absent", () => {
    const suggested = suggestFilename("javascript", "export function getValue() { return 1; }");
    expect(suggested).toBe("getValue.js");
  });

  it("suggests filename from python defs", () => {
    const suggested = suggestFilename("python", "def parse_input(value):\n    return value");
    expect(suggested).toBe("parse_input.py");
  });

  it("returns undefined when language is unknown", () => {
    expect(suggestFilename("haskell", 'main = putStrLn "hi"')).toBeUndefined();
  });

  it("strips ANSI escape sequences from text", () => {
    const cleaned = stripAnsiCodes("\u001b[31mError:\u001b[0m failed");
    expect(cleaned).toBe("Error: failed");
  });

  it("strips OSC 8 hyperlinks with ST terminator", () => {
    const input = "\x1b]8;;https://youtu.be/dQw4w9WgXcQ\x1b\\Click here\x1b]8;;\x1b\\";
    const cleaned = stripAnsiCodes(input);
    expect(cleaned).toBe("Click here");
  });

  it("strips OSC 8 hyperlinks with BEL terminator", () => {
    const input = "\x1b]8;;https://youtu.be/dQw4w9WgXcQ\x07Click here\x1b]8;;\x07";
    const cleaned = stripAnsiCodes(input);
    expect(cleaned).toBe("Click here");
  });

  it("strips mixed ANSI codes and OSC 8 hyperlinks", () => {
    const input =
      "\x1b[36m\x1b]8;;https://youtube.com/watch?v=abc12345678\x1b\\https://youtube.com/watch?v=abc12345678\x1b]8;;\x1b\\\x1b[0m";
    const cleaned = stripAnsiCodes(input);
    expect(cleaned).toBe("https://youtube.com/watch?v=abc12345678");
  });

  it("strips DCS sequences (Kitty graphics / Sixel / tmux passthrough)", () => {
    const cleaned = stripAnsiCodes("before\x1bPpayload\x1b\\after");
    expect(cleaned).toBe("beforeafter");
  });

  it("strips 8-bit C1 string sequences (DCS/SOS/PM/APC)", () => {
    const cleaned = stripAnsiCodes("before\x90payload\x9cafter");
    expect(cleaned).toBe("beforeafter");
  });

  it("strips 8-bit CSI sequences (C1 introducer 0x9B)", () => {
    const cleaned = stripAnsiCodes("\x9b31mError:\x9b0m failed");
    expect(cleaned).toBe("Error: failed");
  });
});

describe("normalizeCapturedOutput", () => {
  it("strips a trailing blank-padding run entirely", () => {
    // The Codex bottom-padding shape: real content, then many bare-CR rows.
    const padded = "answer line one\nanswer line two\r\n\r\n\r\n\r\n\r\n\r\n";
    expect(normalizeCapturedOutput(padded)).toBe("answer line one\nanswer line two");
  });

  it("collapses interior blank runs and strips the trailing run", () => {
    // header -> content -> footer/composer with blank gaps between regions
    // (the structure the agent leaves behind): each interior run of 2+ blanks
    // collapses to one, and the trailing run is dropped wholesale.
    const buffer = ["header", "", "", "", "content", "", "", "footer", "", "", ""].join("\n");
    expect(normalizeCapturedOutput(buffer)).toBe(
      ["header", "", "content", "", "footer"].join("\n")
    );
  });

  it("keeps single interior blank lines (paragraph structure survives)", () => {
    const buffer = "para one\n\npara two\n\npara three";
    expect(normalizeCapturedOutput(buffer)).toBe("para one\n\npara two\n\npara three");
  });

  it("right-trims each line but preserves leading indentation", () => {
    const buffer = "  indented   \ntrailing tabs\t\t\nplain";
    expect(normalizeCapturedOutput(buffer)).toBe("  indented\ntrailing tabs\nplain");
  });

  it("treats whitespace-only and bare-CR lines as blank", () => {
    const buffer = "real\n   \n\r\n\t\nmore";
    expect(normalizeCapturedOutput(buffer)).toBe("real\n\nmore");
  });

  it("treats SGR-painted / ANSI-only rows as blank padding", () => {
    // A themed TUI paints its empty region with a background colour; raw
    // right-trim leaves the SGR, so blank detection must be ANSI-aware.
    const padded =
      "the answer\n" + "\x1b[48;5;235m   \x1b[0m\r\n".repeat(3) + "\x1b[0m\r\n\x1b[0m\r\n";
    expect(normalizeCapturedOutput(padded)).toBe("the answer");
  });

  it("preserves ANSI on non-blank content lines", () => {
    const buffer = "\x1b[32mgreen\x1b[0m\n\n\n\x1b[31mred\x1b[0m\r\n\r\n";
    expect(normalizeCapturedOutput(buffer)).toBe("\x1b[32mgreen\x1b[0m\n\n\x1b[31mred\x1b[0m");
  });

  it("strips a leading blank-padding run entirely", () => {
    expect(normalizeCapturedOutput("\n\n\n\nfirst real line")).toBe("first real line");
  });

  it("makes the last line real content after tailing a padded buffer (N=1 boundary)", () => {
    // The lower-bound version of #10763: even a one-line tail must skip padding.
    const padded = "prompt> done\r\n" + "\r\n".repeat(40);
    const tail = normalizeCapturedOutput(padded).split("\n").slice(-1).join("\n");
    expect(tail).toBe("prompt> done");
  });

  it("collapses an all-blank buffer to an empty string", () => {
    expect(normalizeCapturedOutput("\r\n\r\n\r\n\r\n")).toBe("");
  });

  it("returns an empty string unchanged", () => {
    expect(normalizeCapturedOutput("")).toBe("");
  });

  it("leaves blank-free output untouched", () => {
    const buffer = "line1\nline2\nline3";
    expect(normalizeCapturedOutput(buffer)).toBe(buffer);
  });
});

describe("tailCapturedOutput", () => {
  it("returns the last N normalized lines with truncated/lineCount over real content", () => {
    const padded = "a\nb\nc\nd\ne\r\n\r\n\r\n\r\n";
    const r = tailCapturedOutput(padded, 3, true);
    expect(r.content).toBe("c\nd\ne");
    expect(r.lineCount).toBe(3);
    // 5 real lines > 3 requested -> truncated; the 4 padding rows don't count.
    expect(r.truncated).toBe(true);
  });

  it("does not report truncated when only padding pushed the raw line count up", () => {
    const padded = "only line\r\n" + "\r\n".repeat(40);
    const r = tailCapturedOutput(padded, 10, true);
    expect(r.content).toBe("only line");
    expect(r.lineCount).toBe(1);
    expect(r.truncated).toBe(false);
  });

  it("strips ANSI by default and preserves it when stripAnsi is false", () => {
    const buffer = "\x1b[32mgreen\x1b[0m\r\n\r\n";
    expect(tailCapturedOutput(buffer, 10, true).content).toBe("green");
    expect(tailCapturedOutput(buffer, 10, false).content).toBe("\x1b[32mgreen\x1b[0m");
  });

  it("reports zero lines for an empty or all-blank buffer", () => {
    expect(tailCapturedOutput("", 10, true)).toEqual({
      content: "",
      lineCount: 0,
      truncated: false,
    });
    expect(tailCapturedOutput("\r\n\r\n\r\n", 10, true)).toEqual({
      content: "",
      lineCount: 0,
      truncated: false,
    });
  });

  it("clamps a non-positive maxLines to one line (no slice(-0) blowup)", () => {
    expect(tailCapturedOutput("a\nb\nc", 0, true).content).toBe("c");
  });
});
