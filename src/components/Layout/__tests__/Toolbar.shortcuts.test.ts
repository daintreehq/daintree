import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const TOOLBAR_PATH = path.resolve(__dirname, "../Toolbar.tsx");
const PROBLEMS_BUTTON_PATH = path.resolve(__dirname, "../ToolbarProblemsButton.tsx");
const PORTAL_BUTTON_PATH = path.resolve(__dirname, "../ToolbarPortalButton.tsx");
const SETTINGS_BUTTON_PATH = path.resolve(__dirname, "../ToolbarSettingsButton.tsx");
const LAUNCHER_BUTTON_PATH = path.resolve(__dirname, "../ToolbarLauncherButton.tsx");

describe("Toolbar shortcut tooltips — issue #3443", () => {
  let source: string;
  let problemsSource: string;
  let portalSource: string;
  let settingsSource: string;
  let launcherSource: string;

  beforeEach(async () => {
    [source, problemsSource, portalSource, settingsSource, launcherSource] = await Promise.all([
      fs.readFile(TOOLBAR_PATH, "utf-8"),
      fs.readFile(PROBLEMS_BUTTON_PATH, "utf-8"),
      fs.readFile(PORTAL_BUTTON_PATH, "utf-8"),
      fs.readFile(SETTINGS_BUTTON_PATH, "utf-8"),
      fs.readFile(LAUNCHER_BUTTON_PATH, "utf-8"),
    ]);
  });

  describe("useKeybindingDisplay hooks", () => {
    it("uses dynamic hook for nav.toggleSidebar", () => {
      expect(source).toContain('useKeybindingDisplay("nav.toggleSidebar")');
    });

    it("uses dynamic hook for panel.toggleDiagnostics", () => {
      expect(problemsSource).toContain('useKeybindingDisplay("panel.toggleDiagnostics")');
    });

    it("uses dynamic hook for panel.togglePortal", () => {
      expect(portalSource).toContain('useKeybindingDisplay("panel.togglePortal")');
    });

    it("uses dynamic hook for notes.openPalette", () => {
      expect(source).toContain('useKeybindingDisplay("notes.openPalette")');
    });

    it("uses dynamic hook for worktree.copyTree", () => {
      expect(source).toContain('useKeybindingDisplay("worktree.copyTree")');
    });

    it("uses dynamic hook for app.settings", () => {
      expect(settingsSource).toContain('useKeybindingDisplay("app.settings")');
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
      // Terminal shortcut is now in the launcher button component
      expect(source).not.toContain("terminalShortcut ?");
      expect(launcherSource).not.toContain("terminalShortcut ?");
    });

    it("does not use manual ternary for browser shortcut", () => {
      expect(source).not.toContain("browserShortcut ?");
      expect(launcherSource).not.toContain("browserShortcut ?");
    });
  });

  describe("createTooltipWithShortcut usage", () => {
    it("uses createTooltipWithShortcut for terminal tooltip", () => {
      expect(launcherSource).toContain('tooltipLabel: "Open Terminal"');
      expect(launcherSource).toContain("createTooltipWithShortcut(config.tooltipLabel, shortcut)");
    });

    it("uses createTooltipWithShortcut for browser tooltip", () => {
      expect(launcherSource).toContain('tooltipLabel: "Open Browser"');
      expect(launcherSource).toContain("createTooltipWithShortcut(config.tooltipLabel, shortcut)");
    });

    it("uses createTooltipWithShortcut for notes tooltip", () => {
      expect(source).toContain('createTooltipWithShortcut("Notes", notesShortcut)');
    });

    it("uses createTooltipWithShortcut for settings tooltip", () => {
      expect(settingsSource).toContain(
        'createTooltipWithShortcut("Open Settings", settingsShortcut)'
      );
    });

    it("uses createTooltipWithShortcut for problems tooltip with dynamic shortcut", () => {
      expect(problemsSource).toContain(
        'createTooltipWithShortcut("Show Problems Panel", diagnosticsShortcut)'
      );
    });

    it("uses createTooltipWithShortcut for portal tooltip", () => {
      expect(portalSource).toContain("createTooltipWithShortcut");
      expect(portalSource).toContain("portalShortcut");
    });

    it("uses createTooltipWithShortcut for copy-tree tooltip", () => {
      expect(source).toContain('createTooltipWithShortcut("Copy Context", copyTreeShortcut)');
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

    it("includes notesShortcut in useMemo deps", () => {
      const depsMatch = source.match(/\}\),\s*\[([^\]]+)\]\s*\);/s);
      expect(depsMatch).not.toBeNull();
      const deps = depsMatch![1];
      expect(deps).toContain("notesShortcut");
    });

    it("includes copyTreeShortcut in useMemo deps", () => {
      const depsMatch = source.match(/\}\),\s*\[([^\]]+)\]\s*\);/s);
      expect(depsMatch).not.toBeNull();
      const deps = depsMatch![1];
      expect(deps).toContain("copyTreeShortcut");
    });

    it("diagnosticsShortcut is in ToolbarProblemsButton", () => {
      expect(problemsSource).toContain('useKeybindingDisplay("panel.toggleDiagnostics")');
    });

    it("portalShortcut is in ToolbarPortalButton", () => {
      expect(portalSource).toContain('useKeybindingDisplay("panel.togglePortal")');
    });

    it("settingsShortcut is in ToolbarSettingsButton", () => {
      expect(settingsSource).toContain('useKeybindingDisplay("app.settings")');
    });
  });
});
