import { describe, expect, it } from "vitest";
import {
  extractCodeBlocks,
  extractPatchFilename,
  extractPatches,
  stripAnsiCodes,
  suggestFilename,
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

  it("accepts git format-patch envelope followed by diff body", () => {
    // The `From <sha>` envelope is a Tier 1 trigger. The header line opens
    // a candidate block that closes on `Subject:` (not a body line), then
    // the real diff is opened by the `diff --git` line further down.
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
    // headers and multiple `---` source headers before the target.
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
