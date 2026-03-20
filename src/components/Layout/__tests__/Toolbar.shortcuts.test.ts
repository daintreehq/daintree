import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const TOOLBAR_PATH = path.resolve(__dirname, "../Toolbar.tsx");

describe("Toolbar shortcut tooltips — issue #3443", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(TOOLBAR_PATH, "utf-8");
  });

  describe("useKeybindingDisplay hooks", () => {
    it("uses dynamic hook for nav.toggleSidebar", () => {
      expect(source).toContain('useKeybindingDisplay("nav.toggleSidebar")');
    });

    it("uses dynamic hook for panel.toggleDiagnostics", () => {
      expect(source).toContain('useKeybindingDisplay("panel.toggleDiagnostics")');
    });

    it("uses dynamic hook for panel.togglePortal", () => {
      expect(source).toContain('useKeybindingDisplay("panel.togglePortal")');
    });

    it("uses dynamic hook for notes.openPalette", () => {
      expect(source).toContain('useKeybindingDisplay("notes.openPalette")');
    });

    it("uses dynamic hook for app.settings", () => {
      expect(source).toContain('useKeybindingDisplay("app.settings")');
    });
  });

  describe("no hardcoded shortcut strings in tooltips", () => {
    it("does not hardcode Cmd+B as a tooltip argument", () => {
      expect(source).not.toMatch(/createTooltipWithShortcut\([^)]*"Cmd\+B"/);
    });

    it("does not hardcode Ctrl+Shift+M as a tooltip argument", () => {
      expect(source).not.toMatch(/createTooltipWithShortcut\([^)]*"Ctrl\+Shift\+M"/);
    });
  });

  describe("no manual ternary tooltip patterns", () => {
    it("does not use manual ternary for terminal shortcut", () => {
      expect(source).not.toContain("terminalShortcut ?");
    });

    it("does not use manual ternary for browser shortcut", () => {
      expect(source).not.toContain("browserShortcut ?");
    });
  });

  describe("createTooltipWithShortcut usage", () => {
    it("uses createTooltipWithShortcut for terminal tooltip", () => {
      expect(source).toContain('createTooltipWithShortcut("Open Terminal", terminalShortcut)');
    });

    it("uses createTooltipWithShortcut for browser tooltip", () => {
      expect(source).toContain('createTooltipWithShortcut("Open Browser", browserShortcut)');
    });

    it("uses createTooltipWithShortcut for notes tooltip", () => {
      expect(source).toContain('createTooltipWithShortcut("Notes", notesShortcut)');
    });

    it("uses createTooltipWithShortcut for settings tooltip", () => {
      expect(source).toContain('createTooltipWithShortcut("Open Settings", settingsShortcut)');
    });

    it("uses createTooltipWithShortcut for problems tooltip with dynamic shortcut", () => {
      expect(source).toContain(
        'createTooltipWithShortcut("Show Problems Panel", diagnosticsShortcut)'
      );
    });

    it("uses createTooltipWithShortcut for portal tooltip", () => {
      const portalBlock = source.match(/"portal-toggle":\s*\{[\s\S]*?isAvailable/);
      expect(portalBlock).not.toBeNull();
      expect(portalBlock![0]).toContain("createTooltipWithShortcut");
      expect(portalBlock![0]).toContain("portalShortcut");
    });

    it("uses createTooltipWithShortcut for sidebar tooltip with dynamic shortcut", () => {
      const sidebarBlock = source.match(/"sidebar-toggle":\s*\{[\s\S]*?isAvailable/);
      expect(sidebarBlock).not.toBeNull();
      expect(sidebarBlock![0]).toContain("createTooltipWithShortcut");
      expect(sidebarBlock![0]).toContain("sidebarShortcut");
    });
  });

  describe("useMemo dependency array", () => {
    it("includes sidebarShortcut in useMemo deps", () => {
      const depsMatch = source.match(/\}\),\s*\[([^\]]+)\]\s*\);/s);
      expect(depsMatch).not.toBeNull();
      const deps = depsMatch![1];
      expect(deps).toContain("sidebarShortcut");
    });

    it("includes diagnosticsShortcut in useMemo deps", () => {
      const depsMatch = source.match(/\}\),\s*\[([^\]]+)\]\s*\);/s);
      expect(depsMatch).not.toBeNull();
      const deps = depsMatch![1];
      expect(deps).toContain("diagnosticsShortcut");
    });

    it("includes portalShortcut in useMemo deps", () => {
      const depsMatch = source.match(/\}\),\s*\[([^\]]+)\]\s*\);/s);
      expect(depsMatch).not.toBeNull();
      const deps = depsMatch![1];
      expect(deps).toContain("portalShortcut");
    });

    it("includes notesShortcut in useMemo deps", () => {
      const depsMatch = source.match(/\}\),\s*\[([^\]]+)\]\s*\);/s);
      expect(depsMatch).not.toBeNull();
      const deps = depsMatch![1];
      expect(deps).toContain("notesShortcut");
    });

    it("includes settingsShortcut in useMemo deps", () => {
      const depsMatch = source.match(/\}\),\s*\[([^\]]+)\]\s*\);/s);
      expect(depsMatch).not.toBeNull();
      const deps = depsMatch![1];
      expect(deps).toContain("settingsShortcut");
    });
  });
});
