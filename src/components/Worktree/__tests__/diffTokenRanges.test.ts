import { describe, expect, it } from "vitest";
import { parseDiff } from "react-diff-view";
import type { HunkData } from "react-diff-view";
import { computeSearchRanges, computeTrailingWsRanges } from "../diffTokenRanges";

function hunksOf(diff: string): HunkData[] {
  return parseDiff(diff)[0]!.hunks;
}

const DIFF = `diff --git a/a.ts b/a.ts
index 0000001..0000002 100644
--- a/a.ts
+++ b/a.ts
@@ -10,3 +10,3 @@
 const alpha = 1;
-const needle = oldNeedle();
+const needle = newNeedle();
 const omega = needle + needle;`;

describe("computeSearchRanges", () => {
  it("keys old-side matches by old line numbers and new-side by new line numbers", () => {
    const ranges = computeSearchRanges(hunksOf(DIFF), "needle");
    expect(ranges).not.toBeNull();

    const oldLines = ranges!.old.map((r) => r.lineNumber);
    const newLines = ranges!.new.map((r) => r.lineNumber);

    // Context line "const omega = needle + needle;" is old line 12 / new line
    // 12 and contributes two matches per side.
    expect(oldLines.filter((line) => line === 12)).toHaveLength(2);
    expect(newLines.filter((line) => line === 12)).toHaveLength(2);

    // Delete-only matches never appear on the new side and vice versa.
    expect(oldLines).toContain(11);
    expect(newLines).toContain(11);
    expect(ranges!.old.every((r) => r.className === "diff-search-match")).toBe(true);
  });

  it("matches case-insensitively with correct offsets", () => {
    const ranges = computeSearchRanges(hunksOf(DIFF), "OLDNEEDLE");
    expect(ranges).not.toBeNull();
    expect(ranges!.new).toHaveLength(0);
    expect(ranges!.old).toHaveLength(1);
    const match = ranges!.old[0]!;
    expect(match.lineNumber).toBe(11);
    // "const needle = oldNeedle();" — offset of "oldNeedle"
    expect(match.start).toBe("const needle = ".length);
    expect(match.length).toBe("OLDNEEDLE".length);
  });

  it("returns null for an empty query or a query with no matches", () => {
    expect(computeSearchRanges(hunksOf(DIFF), "")).toBeNull();
    expect(computeSearchRanges(hunksOf(DIFF), "zzz-not-here")).toBeNull();
  });

  it("finds non-overlapping repeated matches within one line", () => {
    const ranges = computeSearchRanges(hunksOf(DIFF), "ne");
    expect(ranges).not.toBeNull();
    // "const omega = needle + needle;" has two "ne" hits at distinct offsets.
    const line12 = ranges!.new.filter((r) => r.lineNumber === 12);
    expect(line12.map((r) => r.start)).toEqual([14, 23]);
  });
});

describe("computeTrailingWsRanges", () => {
  it("flags trailing whitespace on added lines only", () => {
    const diff = `diff --git a/a.ts b/a.ts
index 0000001..0000002 100644
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,3 @@
 const context = 1;${"  "}
-const removed = 2;${"\t"}
+const added = 3;${" \t"}
 const tail = 4;`;
    const ranges = computeTrailingWsRanges(hunksOf(diff));
    expect(ranges).toHaveLength(1);
    const range = ranges[0]!;
    expect(range.lineNumber).toBe(2);
    expect(range.start).toBe("const added = 3;".length);
    expect(range.length).toBe(2);
    expect(range.className).toBe("diff-ws-trailing");
  });

  it("skips whitespace-only added lines", () => {
    const diff = `diff --git a/a.ts b/a.ts
index 0000001..0000002 100644
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,3 @@
 const context = 1;
+${"   "}
 const tail = 4;`;
    expect(computeTrailingWsRanges(hunksOf(diff))).toHaveLength(0);
  });
});
