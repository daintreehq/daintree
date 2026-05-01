import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const PANEL_HEADER_PATH = path.resolve(__dirname, "../PanelHeader.tsx");

describe("PanelHeader shortcut tooltips — issue #3819", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(PANEL_HEADER_PATH, "utf-8");
  });

  describe("useKeybindingDisplay hooks", () => {
    it("uses dynamic hook for terminal.duplicate", () => {
      expect(source).toContain('useKeybindingDisplay("terminal.duplicate")');
    });

    it("uses dynamic hook for terminal.moveToDock", () => {
      expect(source).toContain('useKeybindingDisplay("terminal.moveToDock")');
    });

    it("uses dynamic hook for terminal.toggleDock", () => {
      expect(source).toContain('useKeybindingDisplay("terminal.toggleDock")');
    });

    it("uses dynamic hook for terminal.maximize", () => {
      expect(source).toContain('useKeybindingDisplay("terminal.maximize")');
    });

    it("uses dynamic hook for terminal.close", () => {
      expect(source).toContain('useKeybindingDisplay("terminal.close")');
    });
  });

  describe("no hardcoded shortcut strings in tooltips", () => {
    it("does not hardcode Ctrl+Shift+F in formatShortcutForTooltip", () => {
      expect(source).not.toMatch(/formatShortcutForTooltip\("Ctrl\+Shift\+F"\)/);
    });

    it("does not hardcode shortcut strings in createTooltipContent calls", () => {
      expect(source).not.toMatch(/createTooltipContent\([^)]*"Cmd\+/);
      expect(source).not.toMatch(/createTooltipContent\([^)]*"Ctrl\+Shift\+F"/);
    });
  });

  describe("createTooltipContent usage", () => {
    it("uses createTooltipContent for duplicate tooltip", () => {
      expect(source).toContain(
        'createTooltipContent("Duplicate panel as new tab", duplicateShortcut)'
      );
    });

    it("uses createTooltipContent for Move to Dock tooltip", () => {
      expect(source).toContain('createTooltipContent("Move to Dock", moveToDockShortcut)');
    });

    it("uses createTooltipContent for Collapse to Dock tooltip", () => {
      expect(source).toContain('createTooltipContent("Collapse to Dock", toggleDockShortcut)');
    });

    it("uses createTooltipContent for Maximize tooltip", () => {
      expect(source).toContain('createTooltipContent("Maximize", maximizeShortcut)');
    });

    it("uses createTooltipContent for Restore Grid View tooltip", () => {
      expect(source).toContain('createTooltipContent("Restore Grid View", maximizeShortcut)');
    });

    it("uses createTooltipContent for Close Session tooltip", () => {
      expect(source).toContain('createTooltipContent("Close Session", closeShortcut)');
    });

    it("includes Alt+Click force close hint in close tooltip", () => {
      expect(source).toContain('formatShortcutForTooltip("Alt+Click to force close")');
    });

    it("wraps close tooltip content in flex-col layout", () => {
      expect(source).toContain('className="flex flex-col gap-1"');
    });
  });

  describe("imports", () => {
    it("imports createTooltipContent from tooltipShortcut lib", () => {
      expect(source).toContain('import { createTooltipContent } from "@/lib/tooltipShortcut"');
    });

    it("no longer imports createTooltipWithShortcut", () => {
      expect(source).not.toContain("createTooltipWithShortcut");
    });
  });
});
