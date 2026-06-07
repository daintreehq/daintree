import { describe, it, expect } from "vitest";
import { getPatchStats, patchLineClass } from "../ArtifactOverlay";

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
    it("distinguishes additions, deletions, headers, and context lines", () => {
      const addition = patchLineClass("+const b = 3;");
      const deletion = patchLineClass("-const b = 2;");
      const context = patchLineClass(" const a = 1;");
      const classes = [
        addition,
        deletion,
        context,
        patchLineClass("@@ -1,3 +1,4 @@"),
        patchLineClass("+++ b/src/foo.ts"),
      ];
      // Each category renders distinctly so the preview reads as a diff.
      expect(new Set(classes).size).toBe(4);
      expect(addition).not.toBe(deletion);
    });

    it("styles +++/--- file headers as headers, not as change lines", () => {
      expect(patchLineClass("+++ b/src/foo.ts")).toBe(patchLineClass("@@ -1,3 +1,4 @@"));
      expect(patchLineClass("--- a/src/foo.ts")).toBe(patchLineClass("@@ -1,3 +1,4 @@"));
      expect(patchLineClass("+++ b/src/foo.ts")).not.toBe(patchLineClass("+added"));
      expect(patchLineClass("--- a/src/foo.ts")).not.toBe(patchLineClass("-removed"));
    });
  });
});
