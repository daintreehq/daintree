import { describe, expect, it } from "vitest";
import { humanizeComponentName, resolveBoundaryDisplayName } from "../boundaryDisplayName";

// Every componentName a boundary in the app passes today, plus the dynamic shapes.
const IN_USE = [
  "App",
  "ContentGrid",
  "Sidebar",
  "MainContent",
  "HelpPanel",
  "DiagnosticsDock",
  "ThemeBrowser",
  "PortalDock",
  "ContentDock",
  "ReviewPane",
  "FilePane",
  "DiffPane",
  "FileBrowserPane",
  "DevPreviewPane",
  "WorktreeCard",
  "GitPushConfirmDialog",
  "McpConfirmDialog",
  "PanelDialog:terminal",
  "PluginView:acme.dashboard",
];

describe("resolveBoundaryDisplayName", () => {
  it("never shows a code identifier to the user", () => {
    for (const componentName of IN_USE) {
      const name = resolveBoundaryDisplayName(undefined, componentName, "This panel");
      // No camel-case join, no id suffix — something a sentence can carry.
      expect(name, componentName).not.toMatch(/[a-z][A-Z]/);
      expect(name, componentName).not.toContain(":");
      expect(name.length, componentName).toBeGreaterThan(0);
    }
  });

  it("prefers an explicit display name over anything derived", () => {
    expect(resolveBoundaryDisplayName("feature/login", "WorktreeCard", "x")).toBe("feature/login");
  });

  it("ignores a blank display name", () => {
    expect(resolveBoundaryDisplayName("   ", undefined, "This area")).toBe("This area");
  });

  it("falls back when there is nothing to name", () => {
    expect(resolveBoundaryDisplayName(undefined, undefined, "This area")).toBe("This area");
    expect(resolveBoundaryDisplayName(undefined, ":", "This area")).toBe("This area");
  });
});

describe("humanizeComponentName", () => {
  it("keeps acronyms whole and sentence-cases the rest", () => {
    expect(humanizeComponentName("MCPServerList")).toBe("MCP server list");
  });

  it("leaves already-human names alone", () => {
    expect(humanizeComponentName("Git panel")).toBe("Git panel");
  });
});
