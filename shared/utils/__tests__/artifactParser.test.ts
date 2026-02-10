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
});
