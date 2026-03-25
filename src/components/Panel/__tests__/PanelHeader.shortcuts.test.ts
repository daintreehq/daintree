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

    it("does not hardcode shortcut strings in createTooltipWithShortcut calls", () => {
      expect(source).not.toMatch(/createTooltipWithShortcut\([^)]*"Cmd\+/);
      expect(source).not.toMatch(/createTooltipWithShortcut\([^)]*"Ctrl\+Shift\+F"/);
    });
  });

  describe("createTooltipWithShortcut usage", () => {
    it("uses createTooltipWithShortcut for duplicate tooltip", () => {
      expect(source).toContain(
        'createTooltipWithShortcut("Duplicate panel as new tab", duplicateShortcut)'
      );
    });

    it("uses createTooltipWithShortcut for Move to Dock tooltip", () => {
      expect(source).toContain('createTooltipWithShortcut("Move to Dock", moveToDockShortcut)');
    });

    it("uses createTooltipWithShortcut for Collapse to Dock tooltip", () => {
      expect(source).toContain('createTooltipWithShortcut("Collapse to Dock", toggleDockShortcut)');
    });

    it("uses createTooltipWithShortcut for Maximize tooltip", () => {
      expect(source).toContain('createTooltipWithShortcut("Maximize", maximizeShortcut)');
    });

    it("uses createTooltipWithShortcut for Restore Grid View tooltip", () => {
      expect(source).toContain('createTooltipWithShortcut("Restore Grid View", maximizeShortcut)');
    });

    it("uses createTooltipWithShortcut for Close Session tooltip", () => {
      expect(source).toContain('createTooltipWithShortcut("Close Session", closeShortcut)');
    });
  });
});
