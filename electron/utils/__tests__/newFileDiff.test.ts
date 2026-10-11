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

  it("names the file in the header", () => {
    expect(newFileDiff("src/new file.ts", "x\n")).toMatch(
      /^diff --git a\/src\/new file\.ts b\/src\/new file\.ts\nnew file mode 100644\n--- \/dev\/null\n\+\+\+ b\/src\/new file\.ts\n@@/
    );
  });
});
