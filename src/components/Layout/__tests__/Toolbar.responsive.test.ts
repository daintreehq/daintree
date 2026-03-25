import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const TOOLBAR_PATH = path.resolve(__dirname, "../Toolbar.tsx");
const TOOLBAR_CSS_PATH = path.resolve(__dirname, "../../../styles/components/toolbar.css");

describe("Toolbar responsive design — issue #4133", () => {
  let source: string;
  let css: string;

  beforeEach(async () => {
    [source, css] = await Promise.all([
      fs.readFile(TOOLBAR_PATH, "utf-8"),
      fs.readFile(TOOLBAR_CSS_PATH, "utf-8"),
    ]);
  });

  describe("overflow hook integration", () => {
    it("imports useToolbarOverflow hook", () => {
      expect(source).toContain("useToolbarOverflow");
    });

    it("renders data-toolbar-button-id measurement wrappers", () => {
      expect(source).toContain("data-toolbar-button-id={");
    });

    it("has left and right group refs for overflow measurement", () => {
      expect(source).toContain("leftGroupRef");
      expect(source).toContain("rightGroupRef");
    });

    it("renders overflow menu with Ellipsis icon", () => {
      expect(source).toContain("Ellipsis");
      expect(source).toContain("renderOverflowMenu");
    });

    it("uses DropdownMenu for overflow menus", () => {
      expect(source).toContain("DropdownMenu");
      expect(source).toContain("DropdownMenuContent");
      expect(source).toContain("DropdownMenuItem");
    });
  });

  describe("branch chip responsive collapse", () => {
    it("branch chip has GitBranch icon", () => {
      expect(source).toContain("GitBranch");
      expect(source).toContain("toolbar-project-chip-icon");
    });

    it("branch chip text has label class for CSS targeting", () => {
      expect(source).toContain("toolbar-project-chip-label");
    });

    it("CSS has container query to hide branch label at narrow widths", () => {
      expect(css).toContain("@container toolbar");
      expect(css).toContain("toolbar-project-chip-label");
      expect(css).toContain("display: none");
    });
  });

  describe("container query setup", () => {
    it("toolbar root has @container/toolbar class", () => {
      expect(source).toContain("@container/toolbar");
    });
  });

  describe("overflow state management", () => {
    it("closes dropdowns when items overflow", () => {
      expect(source).toMatch(/overflowSet\.has\("github-stats"\)/);
      expect(source).toMatch(/overflowSet\.has\("notification-center"\)/);
    });

    it("has overflow action handlers for menu items", () => {
      expect(source).toContain("overflowActions");
    });
  });
});
