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
    it("left group uses flex items-center", () => {
      expect(source).toContain('aria-label="Navigation and agents"');
      expect(source).toContain("flex items-center gap-1.5 z-20");
    });

    it("right group uses justify-end", () => {
      expect(source).toContain('aria-label="Tools and settings"');
      expect(source).toContain("flex items-center justify-end gap-1.5 z-20");
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

  describe("Agent/tool button group divider — issue #2879", () => {
    it("defines AGENT_TOOLBAR_IDS constant for group boundary detection", () => {
      expect(source).toContain("AGENT_TOOLBAR_IDS");
    });

    it("has renderLeftButtons helper that inserts group dividers", () => {
      expect(source).toContain("renderLeftButtons");
    });

    it("uses renderLeftButtons for the left button group", () => {
      expect(source).toContain("renderLeftButtons(effectiveLeftButtons");
    });

    it("divider element has aria-hidden for accessibility", () => {
      expect(source).toMatch(/group-divider[\s\S]{0,200}aria-hidden="true"/);
    });
  });

  describe("Window resize strip — issue #3273 Linux native title bar", () => {
    it("imports isLinux from platform", () => {
      expect(source).toContain("isLinux");
    });

    it("window-resize-strip is guarded by !isLinux()", () => {
      expect(source).toMatch(/!isLinux\(\)\s*&&\s*<div className="window-resize-strip"/);
    });

    it("window-resize-strip is not rendered unconditionally", () => {
      expect(source).not.toMatch(/^\s*<div className="window-resize-strip"\s*\/>/m);
    });
  });

  describe("Project switcher trigger", () => {
    it("button has overflow-hidden for truncation", () => {
      expect(source).toContain('data-testid="project-switcher-trigger"');
      expect(source).toContain("overflow-hidden");
    });

    it("project name span has truncate class", () => {
      expect(source).toContain("min-w-0 truncate text-xs tracking-wide text-daintree-text");
      expect(source).toContain('currentProject ? "font-semibold" : "font-medium"');
    });

    it("emoji span has shrink-0 so it is not squeezed before name truncates", () => {
      expect(source).toContain("text-base leading-none shrink-0");
    });

    it("branch badge has shrink-0 to stay visible during truncation", () => {
      expect(source).toContain("shrink-0 inline-flex items-center gap-1 rounded-full border");
    });

    it("chevron icons have shrink-0", () => {
      const chevronMatches = source.match(/ml-0\.5 h-3 w-3 shrink-0/g);
      expect(chevronMatches).not.toBeNull();
    });

    it("empty-state pill displays action-verb label, not brand text", () => {
      expect(source).toContain("Open project");
      expect(source).not.toContain("Daintree");
    });

    it("empty-state pill has no Beta badge", () => {
      expect(source).not.toMatch(/>Beta</);
    });

    it("project switcher button has an accessible aria-label", () => {
      expect(source).toMatch(
        /aria-label=\{[\s\S]*currentProject[\s\S]*Open project switcher for \$\{currentProject\.name\}[\s\S]*"Open project"[\s\S]*\}/
      );
    });
  });

  describe("Titlebar drag regions — secondary window project hydration", () => {
    it("keeps project-scoped toolbar controls in the first-paint button set", () => {
      expect(source).toContain("PROJECT_SCOPED_TOOLBAR_IDS");
      expect(source).toContain('"dev-server", "github-stats"');
      expect(source).not.toContain("isAvailable: !!currentProject");
    });

    it("renders inert placeholders before a project is available", () => {
      expect(source).toContain("GitHubStatsPlaceholder");
      expect(source).toContain("DevServerPlaceholder");
      expect(source).toContain("data-toolbar-placeholder");
      expect(source).toContain("!currentProject && PROJECT_SCOPED_TOOLBAR_IDS.has(id)");
      expect(source).toContain("opacity-0 pointer-events-none");
    });

    it("reserves the loaded GitHub stats width before counts arrive", () => {
      expect(source).toContain("w-[13rem] shrink-0");
      expect(source).toContain('<div className="h-8 flex-1" />');
    });

    it("marks the whole project switcher grid cell as no-drag", () => {
      expect(source).toContain(
        "app-no-drag flex items-center justify-center min-w-0 max-w-full pointer-events-none justify-self-center"
      );
    });

    it("does not depend on renderer or main-process drag-region recompute hooks", () => {
      expect(source).not.toContain("recomputeDragRegions");
      expect(source).not.toContain("onRecomputeDragRegions");
    });
  });

  describe("Windows caption control spacer — issues #7951 / #8167", () => {
    it("imports isWindows from the platform helper", () => {
      expect(source).toMatch(/import\s*{[^}]*\bisWindows\b[^}]*}\s*from\s*"@\/lib\/platform"/);
    });

    it("does not inline navigator.platform checks", () => {
      expect(source).not.toContain("navigator.platform");
    });

    it("guards the trailing spacer with isWindows()", () => {
      expect(source).toMatch(/isWindows\(\)\s*&&\s*\(/);
    });

    it("derives spacer width from the WCO env(titlebar-area-width) expression", () => {
      expect(source).toContain("calc(100vw - env(titlebar-area-width, calc(100vw - 138px)))");
      expect(source).not.toContain("var(--win-caption-width");
    });

    it("collapses the spacer to zero width when entering fullscreen", () => {
      expect(source).toMatch(/isFullscreen\s*&&\s*"w-0"/);
    });

    it("places the spacer inside the right toolbar group, after the portal toggle", () => {
      const rightGroupIndex = source.indexOf('aria-label="Tools and settings"');
      const spacerIndex = source.indexOf("env(titlebar-area-width");
      const portalToggleIndex = source.indexOf('buttonRegistry["portal-toggle"]');
      expect(rightGroupIndex).toBeGreaterThan(-1);
      expect(spacerIndex).toBeGreaterThan(-1);
      expect(portalToggleIndex).toBeGreaterThan(-1);
      expect(spacerIndex).toBeGreaterThan(rightGroupIndex);
      expect(spacerIndex).toBeGreaterThan(portalToggleIndex);
    });

    it("uses scoped transition-[width] motion, not transition-all", () => {
      expect(source).toContain("transition-[width]");
      expect(source).not.toContain("transition-all");
    });

    it("uses Tier 3 panel timing (200ms restore / 120ms collapse), not Tier 1", () => {
      expect(source).toMatch(
        /transition-\[width\]\s+duration-200\s+data-\[fullscreen=true\]:duration-\[120ms\]/
      );
      expect(source).not.toContain("duration-150");
    });

    it("drives the asymmetric collapse duration via a data-fullscreen attribute", () => {
      expect(source).toMatch(/data-fullscreen=\{isFullscreen \? "true" : undefined\}/);
    });

    it("applies the Tier 3 timing to both the macOS and Windows spacers", () => {
      const tier3 = /duration-200 data-\[fullscreen=true\]:duration-\[120ms\]/g;
      expect((source.match(tier3) ?? []).length).toBeGreaterThanOrEqual(2);
    });

    it("spacer is decorative (aria-hidden) and not focusable as a toolbar item", () => {
      const spacerBlock = source.slice(
        source.indexOf("isWindows() &&"),
        source.indexOf("env(titlebar-area-width") + 200
      );
      expect(spacerBlock).toContain('aria-hidden="true"');
      expect(spacerBlock).not.toContain("data-toolbar-item");
    });
  });
});
