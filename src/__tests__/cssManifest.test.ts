import { describe, expect, it } from "vitest";
import fs from "node:fs";
import {
  DIFF_VIEWER_CSS_PATH,
  TOOLBAR_CSS_PATH,
  readDiffViewerCss,
  readToolbarCss,
} from "@/__tests__/support/cssManifest";

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("CSS manifests (#13322)", () => {
  describe.each([
    {
      name: "toolbar.css",
      manifest: TOOLBAR_CSS_PATH,
      read: readToolbarCss,
      // One rule from each partial, in import order.
      markers: [
        ".surface-toolbar {",
        ".toolbar-icon-button",
        ".toolbar-problems-badge",
        "border: 2px solid ButtonText",
      ],
    },
    {
      name: "DiffViewer.css",
      manifest: DIFF_VIEWER_CSS_PATH,
      read: readDiffViewerCss,
      markers: [
        ".diff-gutter",
        ".diff-scroll-root",
        ".diff-note-thread",
        "@media (prefers-contrast: more)",
      ],
    },
  ])("$name", ({ manifest, read, markers }) => {
    it("is an import list with no rules of its own", () => {
      const declarations = stripComments(fs.readFileSync(manifest, "utf8"))
        .replace(/^@import\s+"[^"]+";\s*$/gm, "")
        .trim();
      expect(declarations).toBe("");
    });

    it("expands every import, leaving none for a guard to read past", () => {
      expect(stripComments(read())).not.toMatch(/@import/);
    });

    it("expands its partials in cascade order", () => {
      const css = read();
      const positions = markers.map((marker) => css.indexOf(marker));
      expect(positions.every((p) => p >= 0)).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    });
  });
});
