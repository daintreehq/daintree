import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const SIDEBAR_CONTENT_PATH = path.resolve(__dirname, "../SidebarContent.tsx");

describe("SidebarContent shortcut tooltips — issue #5843", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
  });

  describe("useKeybindingDisplay hooks", () => {
    it("uses dynamic hook for worktree.overview", () => {
      expect(source).toContain('useKeybindingDisplay("worktree.overview")');
    });

    it("uses dynamic hook for fleet.armFocused", () => {
      expect(source).toContain('useKeybindingDisplay("fleet.armFocused")');
    });

    it("uses dynamic hook for worktree.refresh", () => {
      expect(source).toContain('useKeybindingDisplay("worktree.refresh")');
    });

    it("uses dynamic hook for worktree.createDialog.open", () => {
      expect(source).toContain('useKeybindingDisplay("worktree.createDialog.open")');
    });
  });

  describe("no hardcoded shortcut strings in tooltips", () => {
    it("does not hardcode shortcut strings in createTooltipContent calls", () => {
      expect(source).not.toMatch(/createTooltipContent\([^)]*"Cmd\+/);
      expect(source).not.toMatch(/createTooltipContent\([^)]*"Ctrl\+/);
    });

    it("does not assign hardcoded shortcut literals to *Shortcut variables", () => {
      expect(source).not.toMatch(/const\s+\w*Shortcut\s*=\s*["'](Cmd|Ctrl|Shift|Alt|Option)/);
    });
  });

  describe("createTooltipContent usage", () => {
    it("uses createTooltipContent for Open worktrees overview tooltip", () => {
      expect(source).toContain('createTooltipContent("Open worktrees overview", overviewShortcut)');
    });

    it("uses createTooltipContent for Select terminals to arm tooltip", () => {
      expect(source).toContain(
        'createTooltipContent("Select terminals to arm", armFocusedShortcut)'
      );
    });

    it("uses createTooltipContent for Refresh sidebar tooltip", () => {
      expect(source).toContain('createTooltipContent("Refresh sidebar", refreshShortcut)');
    });

    it("uses createTooltipContent for Create new worktree tooltip", () => {
      expect(source).toContain(
        'createTooltipContent("Create new worktree", createWorktreeShortcut)'
      );
    });
  });
});
