import { describe, expect, it } from "vitest";
import { newFileDiff } from "../newFileDiff.js";

function hunk(diff: string): string {
  return diff.slice(diff.indexOf("@@"));
}

describe("newFileDiff", () => {
  it("counts a line ended by a newline once, as git does", () => {
    expect(hunk(newFileDiff("a.txt", "untracked\n"))).toBe("@@ -0,0 +1,1 @@\n+untracked\n");
    expect(hunk(newFileDiff("a.txt", "one\ntwo\n"))).toBe("@@ -0,0 +1,2 @@\n+one\n+two\n");
  });

  it("marks a last line with no newline the way git does", () => {
    expect(hunk(newFileDiff("a.txt", "one\ntwo"))).toBe(
      "@@ -0,0 +1,2 @@\n+one\n+two\n\\ No newline at end of file"
    );
  });

  it("keeps blank lines the file really has", () => {
    expect(hunk(newFileDiff("a.txt", "one\n\n"))).toBe("@@ -0,0 +1,2 @@\n+one\n+\n");
  });

  it("records a symlink with git's symlink mode and its target as the one line", () => {
    expect(newFileDiff("link", "a.txt", "120000")).toBe(
      "diff --git a/link b/link\nnew file mode 120000\n--- /dev/null\n+++ b/link\n@@ -0,0 +1,1 @@\n+a.txt\n\\ No newline at end of file"
    );
  });

  it("names the file in the header", () => {
    expect(newFileDiff("src/new file.ts", "x\n")).toMatch(
      /^diff --git a\/src\/new file\.ts b\/src\/new file\.ts\nnew file mode 100644\n--- \/dev\/null\n\+\+\+ b\/src\/new file\.ts\n@@/
    );
  });
});
