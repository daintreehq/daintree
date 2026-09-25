import { describe, expect, it } from "vitest";
import { parseDiff } from "react-diff-view";
import type { ChangeData, HunkData } from "react-diff-view";
import {
  buildDiffLineIndex,
  formatDiffNotesPrompt,
  hashLineRange,
  lineForChange,
  placeDiffNote,
  sortDiffNotes,
  type DiffNote,
  type DiffNoteAnchor,
} from "../diffNotes";

const DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
 const e = 6;
`;

// The same file after an upstream insertion shifted every line down by one.
const SHIFTED_DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1111111..3333333 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,6 @@
+// header
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
 const e = 6;
`;

function indexFor(diff: string) {
  const [file] = parseDiff(diff);
  return buildDiffLineIndex(file!.hunks);
}

function note(anchor: DiffNoteAnchor, overrides: Partial<DiffNote> = {}): DiffNote {
  return {
    id: "n1",
    worktreePath: "/repo",
    filePath: "src/app.ts",
    anchor,
    body: "Rename this",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("diff note anchoring", () => {
  it("indexes each side by its own line numbers with react-diff-view change keys", () => {
    const index = indexFor(DIFF);
    expect(index.new.get(2)).toEqual({ key: "I2", content: "const b = 3;" });
    expect(index.old.get(2)).toEqual({ key: "D2", content: "const b = 2;" });
    expect(index.new.get(4)?.key).toBe("N3");
    expect(index.old.get(3)?.key).toBe("N3");
  });

  it("anchors a note whose lines still read as written, on the range's last row", () => {
    const index = indexFor(DIFF);
    const hash = hashLineRange(index, "new", 2, 3)!;
    const placement = placeDiffNote(
      note({ kind: "lines", side: "new", startLine: 2, endLine: 3, contentHash: hash }),
      index
    );
    expect(placement).toEqual({ status: "anchored", widgetKey: "I3", selectedKeys: ["I2", "I3"] });
  });

  it("marks a note stale when the diff moves under it instead of re-anchoring", () => {
    const hash = hashLineRange(indexFor(DIFF), "new", 2, 3)!;
    const anchored = note({
      kind: "lines",
      side: "new",
      startLine: 2,
      endLine: 3,
      contentHash: hash,
    });
    expect(placeDiffNote(anchored, indexFor(SHIFTED_DIFF))).toEqual({ status: "stale" });
  });

  it("leaves a note unplaced, not stale, when its lines aren't rendered", () => {
    const hash = hashLineRange(indexFor(DIFF), "new", 5, 5)!;
    const [file] = parseDiff(DIFF);
    const trimmed = buildDiffLineIndex(
      file!.hunks.map((hunk: HunkData) => ({ ...hunk, changes: hunk.changes.slice(0, 3) }))
    );
    expect(
      placeDiffNote(
        note({ kind: "lines", side: "new", startLine: 5, endLine: 5, contentHash: hash }),
        trimmed
      )
    ).toEqual({ status: "unplaced" });
  });

  it("reads a context row on the new side and a removed row on the old side", () => {
    const [file] = parseDiff(DIFF);
    const changes: ChangeData[] = file!.hunks[0]!.changes;
    expect(lineForChange(changes[0]!)).toEqual({ side: "new", line: 1 });
    expect(lineForChange(changes[1]!)).toEqual({ side: "old", line: 2 });
    expect(lineForChange(changes[2]!)).toEqual({ side: "new", line: 2 });
  });

  it("keeps file notes out of line placement", () => {
    expect(placeDiffNote(note({ kind: "file" }), indexFor(DIFF))).toEqual({ status: "file" });
  });
});

describe("formatDiffNotesPrompt", () => {
  it("writes three lines per note with no preamble", () => {
    const prompt = formatDiffNotesPrompt([
      note({ kind: "lines", side: "new", startLine: 12, endLine: 12, contentHash: "x" }),
      note(
        { kind: "lines", side: "new", startLine: 20, endLine: 24, contentHash: "x" },
        { id: "n2", body: "Extract a helper" }
      ),
    ]);
    expect(prompt).toBe(
      [
        "File: src/app.ts",
        "Line(s): 12",
        '"Rename this"',
        "",
        "File: src/app.ts",
        "Line(s): 20-24",
        '"Extract a helper"',
      ].join("\n")
    );
  });

  it("escapes backslashes before quotes so a body can't close its own string", () => {
    const prompt = formatDiffNotesPrompt([note({ kind: "file" }, { body: 'use "\\n" here\\' })]);
    expect(prompt.split("\n")[2]).toBe('"use \\"\\\\n\\" here\\\\"');
  });

  it("escapes line breaks so every note stays three lines", () => {
    const prompt = formatDiffNotesPrompt([
      note({ kind: "file" }, { body: "first\nsecond\r\nthird" }),
    ]);
    expect(prompt.split("\n")).toEqual([
      "File: src/app.ts",
      "Line(s): whole file",
      '"first\\nsecond\\nthird"',
    ]);
  });

  it("writes each path through the resolver", () => {
    const prompt = formatDiffNotesPrompt([note({ kind: "file" })], (n) => `/repo/${n.filePath}`);
    expect(prompt.split("\n")[0]).toBe("File: /repo/src/app.ts");
  });

  it("names whole-file notes and tags removed-side lines", () => {
    const prompt = formatDiffNotesPrompt([
      note({ kind: "file" }),
      note(
        { kind: "lines", side: "old", startLine: 5, endLine: 7, contentHash: "x" },
        { id: "n2" }
      ),
    ]);
    expect(prompt).toContain("Line(s): whole file");
    expect(prompt).toContain("Line(s): 5-7 (removed lines)");
  });

  it("orders by file, then file notes, then line", () => {
    const sorted = sortDiffNotes([
      note(
        { kind: "lines", side: "new", startLine: 9, endLine: 9, contentHash: "x" },
        { id: "b9", filePath: "b.ts" }
      ),
      note(
        { kind: "lines", side: "new", startLine: 3, endLine: 3, contentHash: "x" },
        { id: "a3", filePath: "a.ts" }
      ),
      note({ kind: "file" }, { id: "af", filePath: "a.ts" }),
    ]);
    expect(sorted.map((n) => n.id)).toEqual(["af", "a3", "b9"]);
  });
});
