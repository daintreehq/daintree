import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const PORTAL_TOOLBAR_PATH = path.resolve(__dirname, "../PortalToolbar.tsx");

describe("PortalToolbar shortcut tooltips — issue #3819", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(PORTAL_TOOLBAR_PATH, "utf-8");
  });

  describe("useKeybindingDisplay hooks", () => {
    it("uses dynamic hook for panel.togglePortal", () => {
      expect(source).toContain('useKeybindingDisplay("panel.togglePortal")');
    });

    it("uses dynamic hook for portal.newTab", () => {
      expect(source).toContain('useKeybindingDisplay("portal.newTab")');
    });
  });

  describe("createTooltipWithShortcut usage", () => {
    it("uses createTooltipWithShortcut for Close portal tooltip", () => {
      expect(source).toContain('createTooltipWithShortcut("Close portal", closePortalShortcut)');
    });

    it("uses createTooltipWithShortcut for New Tab tooltip", () => {
      expect(source).toContain('createTooltipWithShortcut("New Tab", newTabShortcut)');
    });
  });

  describe("buttons without keybindings remain plain text", () => {
    it("Go back tooltip is plain text", () => {
      expect(source).toContain(">Go back</TooltipContent>");
    });

    it("Go forward tooltip is plain text", () => {
      expect(source).toContain(">Go forward</TooltipContent>");
    });

    it("Reload tooltip is plain text", () => {
      expect(source).toContain(">Reload</TooltipContent>");
    });

    it("Copy URL tooltip is plain text", () => {
      expect(source).toContain(">Copy URL</TooltipContent>");
    });

    it("Open in external browser tooltip is plain text", () => {
      expect(source).toContain(">Open in external browser</TooltipContent>");
    });
  });
});
