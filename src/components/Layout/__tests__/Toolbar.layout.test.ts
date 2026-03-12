import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const TOOLBAR_PATH = path.resolve(__dirname, "../Toolbar.tsx");

describe("Toolbar layout — issue #2584 project switcher collision", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(TOOLBAR_PATH, "utf-8");
  });

  describe("Header container", () => {
    it("uses CSS grid layout", () => {
      expect(source).toContain("grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]");
    });

    it("does not use flex justify-between on the toolbar root", () => {
      // The toolbar root should no longer use flex+justify-between (the old collision-prone pattern)
      expect(source).not.toMatch(/role="toolbar"[^>]*justify-between/);
    });
  });

  describe("Center group", () => {
    it("does not use absolute positioning", () => {
      // Absolute left-1/2 was the root cause of collision
      expect(source).not.toContain("absolute left-1/2");
      expect(source).not.toContain("-translate-x-1/2");
    });

    it("uses justify-self-center for grid alignment", () => {
      expect(source).toContain("justify-self-center");
    });

    it("has min-w-0 and max-w-full to allow shrinking", () => {
      // The center group wrapper must have both constraints for grid-track shrinking to work
      expect(source).toContain("min-w-0 max-w-full pointer-events-none justify-self-center");
    });
  });

  describe("Side groups", () => {
    it("left group uses justify-self-start", () => {
      expect(source).toContain("justify-self-start");
    });

    it("right group uses justify-self-end", () => {
      expect(source).toContain("justify-self-end");
    });
  });

  describe("ARIA toolbar structure — issue #2814", () => {
    it("toolbar root has role=toolbar and aria-label", () => {
      expect(source).toMatch(/role="toolbar"/);
      expect(source).toMatch(/aria-label="Main toolbar"/);
    });

    it("has three role=group regions", () => {
      const groupMatches = source.match(/role="group"/g);
      expect(groupMatches).not.toBeNull();
      expect(groupMatches!.length).toBe(3);
    });

    it("groups have descriptive aria-labels", () => {
      expect(source).toContain('aria-label="Navigation and agents"');
      expect(source).toContain('aria-label="Project"');
      expect(source).toContain('aria-label="Tools and settings"');
    });

    it("toolbar items are marked with data-toolbar-item", () => {
      const itemMatches = source.match(/data-toolbar-item=""/g);
      expect(itemMatches).not.toBeNull();
      expect(itemMatches!.length).toBeGreaterThanOrEqual(10);
    });

    it("has onKeyDown handler for arrow navigation", () => {
      expect(source).toContain("onKeyDown={handleToolbarKeyDown}");
    });

    it("has onFocusCapture handler for focus tracking", () => {
      expect(source).toContain("onFocusCapture={handleToolbarFocusCapture}");
    });
  });

  describe("Project switcher trigger", () => {
    it("button has overflow-hidden for truncation", () => {
      // overflow-hidden appears in className before data-testid on the same button
      expect(source).toMatch(/overflow-hidden[\s\S]{0,200}data-testid="project-switcher-trigger"/);
    });

    it("project name span has truncate class", () => {
      // Both the project name span and the no-project name span should truncate
      const truncateMatches = source.match(/tracking-wide truncate/g);
      expect(truncateMatches).not.toBeNull();
      expect(truncateMatches!.length).toBeGreaterThanOrEqual(2);
    });

    it("emoji span has shrink-0 so it is not squeezed before name truncates", () => {
      expect(source).toContain("text-base leading-none shrink-0");
    });

    it("branch badge has shrink-0 to stay visible during truncation", () => {
      expect(source).toContain("bg-white/10 shrink-0");
    });

    it("chevron icons have shrink-0", () => {
      const chevronMatches = source.match(/text-white\/50 ml-0\.5 shrink-0/g);
      expect(chevronMatches).not.toBeNull();
    });
  });
});
