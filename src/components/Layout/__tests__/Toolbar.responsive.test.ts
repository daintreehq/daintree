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

  describe("overflow trigger surfaces hidden state — issue #6416", () => {
    it("calls useOverflowBadgeSeverity for both left and right overflow", () => {
      expect(source).toContain("useOverflowBadgeSeverity(leftOverflow");
      expect(source).toContain("useOverflowBadgeSeverity(rightOverflow");
    });

    it("passes left and right severities into renderOverflowMenu independently", () => {
      expect(source).toContain("leftOverflowSeverity");
      expect(source).toContain("rightOverflowSeverity");
    });

    it("maps severity to a Tailwind dot color via OVERFLOW_BADGE_CLASS", () => {
      expect(source).toContain("OVERFLOW_BADGE_CLASS");
      expect(source).toContain("bg-status-error");
      expect(source).toContain("bg-state-waiting");
      expect(source).toContain("bg-daintree-text/50");
    });

    it("renders a dot inside the overflow Button when severity is set", () => {
      expect(source).toContain("toolbar-overflow-badge");
      expect(source).toMatch(/data-severity=\{severity\}/);
    });

    it("builds a dynamic tooltip listing the hidden buttons", () => {
      expect(source).toContain("itemLabels");
      expect(source).toMatch(/\$\{overflowIds\.length\} more — /);
    });

    it("supplies a fallback label for voice-recording so the count and named list stay aligned", () => {
      // voice-recording is absent from OVERFLOW_MENU_META on purpose — it
      // has no dropdown rendering — so the tooltip must look it up
      // separately or the spoken count would exceed the list.
      expect(source).toContain('id === "voice-recording"');
      expect(source).toContain('"Voice recording"');
    });
  });

  describe("overflow menu focus ring after pointer dismissal — issue #6119", () => {
    it("declares the overflowMenuPointerCloseRef", () => {
      expect(source).toContain("overflowMenuPointerCloseRef");
      expect(source).toMatch(/overflowMenuPointerCloseRef\s*=\s*useRef\(false\)/);
    });

    it("sets the ref in onPointerDownOutside on the overflow DropdownMenuContent", () => {
      expect(source).toMatch(
        /onPointerDownOutside={\(\)\s*=>\s*{\s*overflowMenuPointerCloseRef\.current\s*=\s*true;?\s*}}/
      );
    });

    it("conditionally preventDefault and resets the ref in onCloseAutoFocus", () => {
      // Guards the reset line: deleting it would inherit suppression into a
      // later keyboard close and break WAI-ARIA focus return.
      expect(source).toContain("overflowMenuPointerCloseRef.current = false");
      expect(source).toMatch(
        /if\s*\(overflowMenuPointerCloseRef\.current\)\s*{\s*e\.preventDefault\(\);/
      );
    });
  });
});
