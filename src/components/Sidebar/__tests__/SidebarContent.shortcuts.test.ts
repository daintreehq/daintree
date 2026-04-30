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
  });

  describe("no hardcoded shortcut strings in tooltips", () => {
    it("does not hardcode shortcut strings in createTooltipWithShortcut calls", () => {
      expect(source).not.toMatch(/createTooltipWithShortcut\([^)]*"Cmd\+/);
      expect(source).not.toMatch(/createTooltipWithShortcut\([^)]*"Ctrl\+/);
    });

    it("does not assign hardcoded shortcut literals to *Shortcut variables", () => {
      expect(source).not.toMatch(/const\s+\w*Shortcut\s*=\s*["'](Cmd|Ctrl|Shift|Alt|Option)/);
    });
  });

  describe("createTooltipWithShortcut usage", () => {
    it("uses createTooltipWithShortcut for Open worktrees overview tooltip", () => {
      expect(source).toContain(
        'createTooltipWithShortcut("Open worktrees overview", overviewShortcut)'
      );
    });
  });
});
