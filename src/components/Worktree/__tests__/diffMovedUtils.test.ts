import { describe, expect, it } from "vitest";
import { parseDiff, getChangeKey } from "react-diff-view";
import type { ChangeData, HunkData } from "react-diff-view";
import { detectMovedLines } from "../diffMovedUtils";

function hunksOf(diff: string): HunkData[] {
  return parseDiff(diff)[0]!.hunks;
}

function changesOfType(hunks: HunkData[], type: ChangeData["type"]): ChangeData[] {
  return hunks.flatMap((h) => h.changes.filter((c) => c.type === type));
}

const MOVED_BLOCK_DIFF = `diff --git a/a.ts b/a.ts
index 0000001..0000002 100644
--- a/a.ts
+++ b/a.ts
@@ -1,5 +1,3 @@
 const top = 1;
-function relocated(): number {
-  return computeExpensiveValue(top);
-}
 const after = 2;
@@ -20,3 +18,6 @@
 const tail = 3;
+function relocated(): number {
+  return computeExpensiveValue(top);
+}
 const end = 4;`;

describe("detectMovedLines", () => {
  it("pairs a deleted block with its verbatim reappearance in another hunk", () => {
    const hunks = hunksOf(MOVED_BLOCK_DIFF);
    const moved = detectMovedLines(hunks);

    const deletes = changesOfType(hunks, "delete");
    const inserts = changesOfType(hunks, "insert");
    expect(deletes).toHaveLength(3);
    expect(inserts).toHaveLength(3);
    for (const change of [...deletes, ...inserts]) {
      expect(moved.has(getChangeKey(change))).toBe(true);
    }
  });

  it("leaves genuinely new and removed lines unmarked", () => {
    const diff = `diff --git a/a.ts b/a.ts
index 0000001..0000002 100644
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,3 @@
 const top = 1;
-const removedForGood = oldComputation();
+const addedFresh = newComputation();
 const after = 2;`;
    const moved = detectMovedLines(hunksOf(diff));
    expect(moved.size).toBe(0);
  });

  it("ignores trivial matches below the alphanumeric threshold", () => {
    // "}" and short fragments reappear constantly; git's MIN_ALNUM_COUNT
    // analogue must keep them from lighting up as moves.
    const diff = `diff --git a/a.ts b/a.ts
index 0000001..0000002 100644
--- a/a.ts
+++ b/a.ts
@@ -1,4 +1,3 @@
 const top = 1;
-}
-x;
 const after = 2;
@@ -20,2 +19,4 @@
 const tail = 3;
+}
+x;
 const end = 4;`;
    const moved = detectMovedLines(hunksOf(diff));
    expect(moved.size).toBe(0);
  });

  it("requires exact content — re-indented copies are not moves", () => {
    const diff = `diff --git a/a.ts b/a.ts
index 0000001..0000002 100644
--- a/a.ts
+++ b/a.ts
@@ -1,4 +1,3 @@
 const top = 1;
-const value = computeExpensiveValue(top);
 const after = 2;
@@ -20,2 +19,3 @@
 const tail = 3;
+  const value = computeExpensiveValue(top);
 const end = 4;`;
    const moved = detectMovedLines(hunksOf(diff));
    expect(moved.size).toBe(0);
  });

  it("matches each deleted block at most once", () => {
    // One deletion, two identical insertions: only one insertion pairs up.
    const diff = `diff --git a/a.ts b/a.ts
index 0000001..0000002 100644
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,2 @@
 const top = 1;
-const value = computeExpensiveValue(top);
 const after = 2;
@@ -20,2 +19,4 @@
 const tail = 3;
+const value = computeExpensiveValue(top);
+const value = computeExpensiveValue(top);
 const end = 4;`;
    const hunks = hunksOf(diff);
    const moved = detectMovedLines(hunks);

    const inserts = changesOfType(hunks, "insert");
    const movedInserts = inserts.filter((c) => moved.has(getChangeKey(c)));
    expect(movedInserts).toHaveLength(1);
    const deletes = changesOfType(hunks, "delete");
    expect(deletes.every((c) => moved.has(getChangeKey(c)))).toBe(true);
  });

  it("returns an empty set when a side has no changes", () => {
    const diff = `diff --git a/a.ts b/a.ts
index 0000001..0000002 100644
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,3 @@
 const top = 1;
+const addedOnly = somethingBrandNew();
 const after = 2;`;
    expect(detectMovedLines(hunksOf(diff)).size).toBe(0);
  });
});
