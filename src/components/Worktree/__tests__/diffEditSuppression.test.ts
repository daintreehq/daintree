import { describe, expect, it } from "vitest";
import { markEdits, parseDiff, tokenize } from "react-diff-view";
import type { HunkData, TokenNode, TokenPath } from "react-diff-view";
import {
  EDIT_COVERAGE_LIMIT,
  shouldSuppressEdits,
  suppressFullLineEdits,
} from "../diffEditSuppression";

function textPath(value: string): TokenPath {
  return [{ type: "text", value }];
}

function editPath(value: string): TokenPath {
  return [{ type: "edit" }, { type: "text", value }];
}

function lineHasEdit(line: TokenPath[]): boolean {
  return line.some((path) => path.some((node) => node.type === "edit"));
}

function lineText(line: TokenPath[]): string {
  return line.map((path) => String(path[path.length - 1]?.value ?? "")).join("");
}

function run(oldLines: TokenPath[][], newLines: TokenPath[][]): [TokenPath[][], TokenPath[][]] {
  return suppressFullLineEdits()([oldLines, newLines]);
}

describe("suppressFullLineEdits", () => {
  it("keeps marks for small token edits", () => {
    const line = [textPath("const value = "), editPath("foo"), textPath("(input);")];
    const [, [result]] = run([], [line]);
    expect(result && lineHasEdit(result)).toBe(true);
  });

  it("unwraps marks covering most of the line, preserving the text", () => {
    const line = [textPath("ab"), editPath("cdefghijklmnop")];
    const [, [result]] = run([], [line]);
    expect(result && lineHasEdit(result)).toBe(false);
    expect(result && lineText(result)).toBe("abcdefghijklmnop");
  });

  it("exempts whitespace-only edits — their mark is the only visible signal", () => {
    const line = [editPath("    \t")];
    const [, [result]] = run([], [line]);
    expect(result && lineHasEdit(result)).toBe(true);
  });

  it("judges each line and side independently", () => {
    const noisy = [editPath("entirely rewritten")];
    const calm = [textPath("const value = "), editPath("foo"), textPath("(input);")];
    const [[oldResult], [newResult]] = run([noisy], [calm]);
    expect(oldResult && lineHasEdit(oldResult)).toBe(false);
    expect(newResult && lineHasEdit(newResult)).toBe(true);
  });

  it("suppresses real markEdits output on rewritten lines, keeps it on similar lines", () => {
    const diff = `diff --git a/a.ts b/a.ts
index 0000001..0000002 100644
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,3 @@
 const top = 1;
-const value = oldName(input);
+const value = newName(input);
 const tail = 2;
@@ -10,3 +10,3 @@
 const mid = 3;
-aaaa bbbb cccc dddd eeee
+zzzz yyyy xxxx wwww vvvv
 const end = 4;`;
    const hunks = parseDiff(diff)[0]!.hunks as HunkData[];
    const tokens = tokenize(hunks, {
      highlight: false,
      refractor: null,
      language: "plaintext",
      enhancers: [markEdits(hunks, { type: "block" }), suppressFullLineEdits()],
    });

    const treeHasEdit = (nodes: TokenNode[]): boolean =>
      nodes.some((node) => node.type === "edit" || (node.children && treeHasEdit(node.children)));

    // Lines are 1-based file lines per side; index 1 = line 2 (the rename),
    // index 10 = line 11 (the rewrite).
    const newLines = tokens.new as TokenNode[][];
    expect(treeHasEdit(newLines[1] ?? [])).toBe(true);
    expect(treeHasEdit(newLines[10] ?? [])).toBe(false);
  });
});

// The predicate the rendered Markdown diff shares with the line diff (#12171):
// both surfaces have to land on the same side of the same judgment.
describe("shouldSuppressEdits", () => {
  it("keeps marks at exactly the limit and drops them past it", () => {
    const total = 100;
    const atLimit = Math.round(total * EDIT_COVERAGE_LIMIT);
    expect(shouldSuppressEdits(total, atLimit, "x".repeat(atLimit))).toBe(false);
    expect(shouldSuppressEdits(total, atLimit + 1, "x".repeat(atLimit + 1))).toBe(true);
  });

  it("exempts whitespace-only edits at any coverage", () => {
    expect(shouldSuppressEdits(10, 9, "         ")).toBe(false);
    expect(shouldSuppressEdits(10, 9, "\t\t\t\t\t\t\t\t\t")).toBe(false);
  });

  it("says nothing to suppress when there are no edits or no content", () => {
    expect(shouldSuppressEdits(100, 0, "")).toBe(false);
    expect(shouldSuppressEdits(0, 0, "")).toBe(false);
  });
});
