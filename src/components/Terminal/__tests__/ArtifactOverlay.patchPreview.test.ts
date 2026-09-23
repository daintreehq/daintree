import { describe, it, expect } from "vitest";
import { getPatchFiles, getPatchStats, patchLineClass } from "../ArtifactOverlay";

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
  });

  describe("patchLineClass", () => {
    it("gives additions, deletions, hunk headers, file headers and context each their own treatment", () => {
      const classes = [
        patchLineClass("+const b = 3;"),
        patchLineClass("-const b = 2;"),
        patchLineClass(" const a = 1;"),
        patchLineClass("@@ -1,3 +1,4 @@"),
        patchLineClass("+++ b/src/foo.ts"),
      ];
      expect(new Set(classes).size).toBe(classes.length);
    });

    it("never styles +++/--- file headers as change lines", () => {
      const header = [patchLineClass("+++ b/src/foo.ts"), patchLineClass("--- a/src/foo.ts")];
      const changes = [patchLineClass("+added"), patchLineClass("-removed")];
      expect(header[0]).toBe(header[1]);
      for (const change of changes) expect(header).not.toContain(change);
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
  });
});
