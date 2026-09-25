import { describe, it, expect } from "vitest";
import {
  describeApplyFailure,
  getPatchFiles,
  getPatchStats,
  parsePatchLines,
  PATCH_ROW_CLASS,
} from "../ArtifactOverlay";

const PATCH = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
].join("\n");

function kinds(content: string) {
  return parsePatchLines(content).map((line) => line.kind);
}

describe("ArtifactOverlay patch preview helpers (issue #10020)", () => {
  describe("getPatchStats", () => {
    it("counts added and removed lines, excluding +++/--- file headers", () => {
      expect(getPatchStats(PATCH)).toEqual({ additions: 2, deletions: 1 });
    });

    it("returns zeros for content with no change lines", () => {
      expect(getPatchStats("just some text\nwith no markers")).toEqual({
        additions: 0,
        deletions: 0,
      });
    });

    it("counts hunk lines whose text begins with ++ or -- as changes, not headers", () => {
      const patch = [PATCH, "@@ -9,2 +10,2 @@", "--- old separator", "+++ new separator"].join(
        "\n"
      );
      expect(getPatchStats(patch)).toEqual({ additions: 3, deletions: 2 });
    });
  });

  describe("parsePatchLines", () => {
    it("reads headers, hunks, changes and context in order", () => {
      expect(kinds(PATCH)).toEqual([
        "file",
        "file",
        "file",
        "hunk",
        "context",
        "del",
        "add",
        "add",
      ]);
    });

    it("keeps the no-newline marker as a verbatim note inside a hunk", () => {
      const lines = parsePatchLines([PATCH, "\\ No newline at end of file"].join("\n"));
      expect(lines.at(-1)).toEqual({ kind: "meta", text: "\\ No newline at end of file" });
    });

    it("treats a new diff header as leaving the hunk, so the next --- is a header again", () => {
      const second = ["diff --git a/b.ts b/b.ts", "--- a/b.ts", "+++ b/b.ts"].join("\n");
      expect(kinds([PATCH, second].join("\n")).slice(-3)).toEqual(["file", "file", "file"]);
    });

    it("gives every line kind its own treatment", () => {
      const classes = Object.values(PATCH_ROW_CLASS);
      expect(new Set(classes).size).toBe(classes.length);
    });
  });

  describe("getPatchFiles", () => {
    it("lists every file a multi-file patch touches, once each, in order", () => {
      const multi = [
        PATCH,
        "diff --git a/src/bar.ts b/src/bar.ts",
        "--- a/src/bar.ts",
        "+++ b/src/bar.ts",
        "@@ -1 +1 @@",
        "-x",
        "+y",
        "diff --git a/src/foo.ts b/src/foo.ts",
        "--- a/src/foo.ts",
        "+++ b/src/foo.ts",
        "@@ -9 +9 @@",
        "-p",
        "+q",
      ].join("\n");
      expect(getPatchFiles(multi)).toEqual(["src/foo.ts", "src/bar.ts"]);
    });

    it("names a deleted file by its old path rather than /dev/null", () => {
      const deletion = ["--- a/src/gone.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye"].join("\n");
      expect(getPatchFiles(deletion)).toEqual(["src/gone.ts"]);
    });

    it("ignores ++-prefixed content lines inside a hunk", () => {
      const patch = [PATCH, "+++ b/not-a-file.ts"].join("\n");
      expect(getPatchFiles(patch)).toEqual(["src/foo.ts"]);
    });
  });

  describe("describeApplyFailure", () => {
    it("tells a stale patch, a missing file and an unreadable patch apart", () => {
      const advice = [
        describeApplyFailure(
          "error: patch failed: src/a.ts:24\nerror: src/a.ts: patch does not apply"
        ),
        describeApplyFailure("error: src/a.ts: No such file or directory"),
        describeApplyFailure("error: corrupt patch at line 12"),
        describeApplyFailure("something git has never said"),
      ];
      expect(new Set(advice).size).toBe(advice.length);
    });
  });
});
