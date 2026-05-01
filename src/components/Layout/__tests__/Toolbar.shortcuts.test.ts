import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const TOOLBAR_PATH = path.resolve(__dirname, "../Toolbar.tsx");
const PROBLEMS_BUTTON_PATH = path.resolve(__dirname, "../ToolbarProblemsButton.tsx");
const PORTAL_BUTTON_PATH = path.resolve(__dirname, "../ToolbarPortalButton.tsx");
const SETTINGS_BUTTON_PATH = path.resolve(__dirname, "../ToolbarSettingsButton.tsx");
const LAUNCHER_BUTTON_PATH = path.resolve(__dirname, "../ToolbarLauncherButton.tsx");
const AGENT_BUTTON_PATH = path.resolve(__dirname, "../AgentButton.tsx");

describe("Toolbar shortcut tooltips — issue #3443", () => {
  let source: string;
  let problemsSource: string;
  let portalSource: string;
  let settingsSource: string;
  let launcherSource: string;
  let agentSource: string;

  beforeEach(async () => {
    [source, problemsSource, portalSource, settingsSource, launcherSource, agentSource] =
      await Promise.all([
        fs.readFile(TOOLBAR_PATH, "utf-8"),
        fs.readFile(PROBLEMS_BUTTON_PATH, "utf-8"),
        fs.readFile(PORTAL_BUTTON_PATH, "utf-8"),
        fs.readFile(SETTINGS_BUTTON_PATH, "utf-8"),
        fs.readFile(LAUNCHER_BUTTON_PATH, "utf-8"),
        fs.readFile(AGENT_BUTTON_PATH, "utf-8"),
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

    it("uses dynamic hook for worktree.copyTree", () => {
      expect(source).toContain('useKeybindingDisplay("worktree.copyTree")');
    });

    it("uses dynamic hook for app.settings", () => {
      expect(settingsSource).toContain('useKeybindingDisplay("app.settings")');
    });

    it("uses dynamic hook for devServer.start", () => {
      expect(source).toContain('useKeybindingDisplay("devServer.start")');
    });
  });

  describe("no hardcoded shortcut strings in tooltips", () => {
    it("does not hardcode Cmd+B as a tooltip argument", () => {
      expect(source).not.toMatch(/createTooltipContent\([^)]*"Cmd\+B"/);
    });

    it("does not hardcode Ctrl+Shift+M as a tooltip argument", () => {
      expect(source).not.toMatch(/createTooltipContent\([^)]*"Ctrl\+Shift\+M"/);
    });
  });

  describe("no manual ternary tooltip patterns", () => {
    it("does not use manual ternary for terminal shortcut", () => {
      expect(source).not.toContain("terminalShortcut ?");
      expect(launcherSource).not.toContain("terminalShortcut ?");
    });

    it("does not use manual ternary for browser shortcut", () => {
      expect(source).not.toContain("browserShortcut ?");
      expect(launcherSource).not.toContain("browserShortcut ?");
    });
  });

  describe("createTooltipContent usage", () => {
    it("uses createTooltipContent for terminal tooltip", () => {
      expect(launcherSource).toContain('tooltipLabel: "Open Terminal"');
      expect(launcherSource).toContain("createTooltipContent(config.tooltipLabel, shortcut)");
    });

    it("uses createTooltipContent for browser tooltip", () => {
      expect(launcherSource).toContain('tooltipLabel: "Open Browser"');
      expect(launcherSource).toContain("createTooltipContent(config.tooltipLabel, shortcut)");
    });

    it("uses createTooltipContent for settings tooltip", () => {
      expect(settingsSource).toContain('createTooltipContent("Open Settings", settingsShortcut)');
    });

    it("uses createTooltipContent for problems tooltip with dynamic shortcut", () => {
      expect(problemsSource).toContain(
        'createTooltipContent("Show Problems Panel", diagnosticsShortcut)'
      );
    });

    it("uses createTooltipContent for portal tooltip", () => {
      expect(portalSource).toContain("createTooltipContent");
      expect(portalSource).toContain("portalShortcut");
    });

    it("uses createTooltipContent for copy-tree tooltip", () => {
      expect(source).toContain('createTooltipContent("Copy Context", copyTreeShortcut)');
    });

    it("uses createTooltipContent for dev-server tooltip", () => {
      expect(source).toContain('createTooltipContent("Open Dev Preview", devServerShortcut)');
    });

    it("uses createTooltipContent for sidebar tooltip with dynamic shortcut", () => {
      const sidebarBlock = source.match(/"sidebar-toggle":\s*\{[\s\S]*?isAvailable/);
      expect(sidebarBlock).not.toBeNull();
      expect(sidebarBlock![0]).toContain("createTooltipContent");
      expect(sidebarBlock![0]).toContain("sidebarShortcut");
    });

    it("uses createTooltipContent for AgentButton primary tooltip", () => {
      expect(agentSource).toContain("createTooltipContent(tooltipLabel, tooltipShortcut)");
      expect(agentSource).toContain("const tooltipLabel");
      expect(agentSource).toContain("const tooltipShortcut");
    });
  });

  describe("useMemo dependency array", () => {
    it("includes sidebarShortcut in useMemo deps", () => {
      const depsMatch = source.match(/\}\),\s*\[([^\]]+)\]\s*\);/s);
      expect(depsMatch).not.toBeNull();
      const deps = depsMatch![1];
      expect(deps).toContain("sidebarShortcut");
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
