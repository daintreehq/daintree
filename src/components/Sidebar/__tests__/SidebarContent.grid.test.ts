import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const SIDEBAR_CONTENT_PATH = path.resolve(__dirname, "../SidebarContent.tsx");
const SORTABLE_CARD_PATH = path.resolve(__dirname, "../../DragDrop/SortableWorktreeCard.tsx");
const WORKTREE_CARD_PATH = path.resolve(__dirname, "../../Worktree/WorktreeCard.tsx");
const WORKTREE_HEADER_PATH = path.resolve(
  __dirname,
  "../../Worktree/WorktreeCard/WorktreeHeader.tsx"
);
const HOOK_PATH = path.resolve(__dirname, "../useWorktreeGridRovingFocus.ts");

describe("Worktree list keyboard grid — issue #6422", () => {
  describe("SortableWorktreeCard ARIA contract", () => {
    let source: string;
    beforeEach(async () => {
      source = await fs.readFile(SORTABLE_CARD_PATH, "utf-8");
    });

    it("strips dnd-kit's tabIndex from spread attributes so the row never gets a stray tab stop", () => {
      // dnd-kit's useSortable returns attributes that include `tabIndex: 0`.
      // Spreading them onto the row would defeat the single-tab-stop contract.
      expect(source).toMatch(/tabIndex:\s*_tabIndex/);
    });

    it('uses role="row" (not listitem) so the wrapper participates in the grid', () => {
      expect(source).toContain('role="row"');
      expect(source).not.toContain('role="listitem"');
    });

    it("exposes data-worktree-row so the roving controller can query rows", () => {
      expect(source).toContain("data-worktree-row={worktreeId}");
    });

    it('wraps children in role="gridcell" for valid grid > row > gridcell semantics', () => {
      expect(source).toContain('role="gridcell"');
    });

    it("starts with tabIndex={-1}; the controller promotes one row to 0", () => {
      expect(source).toContain("tabIndex={-1}");
    });
  });

  describe("WorktreeCard role conditional", () => {
    let source: string;
    beforeEach(async () => {
      source = await fs.readFile(WORKTREE_CARD_PATH, "utf-8");
    });

    it('only applies role="group" in the overview grid variant — sidebar rows defer to the row wrapper', () => {
      expect(source).toContain('role={variant === "grid" ? "group" : undefined}');
    });
  });

  describe("WorktreeHeader actions toolbar", () => {
    let source: string;
    beforeEach(async () => {
      source = await fs.readFile(WORKTREE_HEADER_PATH, "utf-8");
    });

    it("marks the actions wrapper with data-worktree-row-toolbar so the controller can find it", () => {
      expect(source).toContain('data-worktree-row-toolbar=""');
    });

    it('declares role="toolbar" and an accessible label', () => {
      expect(source).toMatch(/role="toolbar"/);
      expect(source).toMatch(/aria-label="Worktree actions"/);
    });
  });

  describe("SidebarContent grid wiring", () => {
    let source: string;
    beforeEach(async () => {
      source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
    });

    it("imports the roving-focus hook", () => {
      expect(source).toContain('from "./useWorktreeGridRovingFocus"');
      expect(source).toContain("useWorktreeGridRovingFocus");
    });

    it('wires gridRef + handlers from the hook into a role="grid" container', () => {
      expect(source).toContain(
        "const { gridRef, handleGridKeyDown, handleGridFocusCapture } = useWorktreeGridRovingFocus();"
      );
      expect(source).toContain('role="grid"');
      expect(source).toContain('aria-label="Worktrees"');
      expect(source).toContain("ref={gridRef}");
      expect(source).toContain("onKeyDown={handleGridKeyDown}");
      expect(source).toContain("onFocusCapture={handleGridFocusCapture}");
    });

    it('wraps StaticWorktreeRow\'s WorktreeCard in role="row" + data-worktree-row + role="gridcell"', () => {
      // The static (pinned/grouped) rows don't go through SortableWorktreeCard,
      // so the row + gridcell roles must be added explicitly here.
      expect(source).toContain('<div role="row" data-worktree-row={worktreeId} tabIndex={-1}>');
      // Ensure the static path also has a gridcell wrapper
      const staticRowMatch = source.match(
        /const StaticWorktreeRow[\s\S]*?<\/div>\s*\)\s*;\s*\}\s*\)\s*;/
      );
      expect(staticRowMatch).toBeTruthy();
      expect(staticRowMatch?.[0]).toContain('role="gridcell"');
    });
  });

  describe("useWorktreeGridRovingFocus hook", () => {
    let source: string;
    beforeEach(async () => {
      source = await fs.readFile(HOOK_PATH, "utf-8");
    });

    it("queries rows via [data-worktree-row]", () => {
      expect(source).toContain("[data-worktree-row]");
    });

    it("queries the per-row toolbar via [data-worktree-row-toolbar]", () => {
      expect(source).toContain("[data-worktree-row-toolbar]");
    });

    it("syncs tab stops by mutating element.tabIndex directly (not via React state)", () => {
      // Mirrors Toolbar.tsx's DOM-mutation pattern to avoid re-rendering 50–200
      // worktree cards on every arrow keypress.
      expect(source).toMatch(/\.tabIndex\s*=\s*-1/);
      expect(source).toMatch(/\.tabIndex\s*=\s*0/);
    });

    it("resets to list mode on window blur (lesson #4591)", () => {
      expect(source).toContain('window.addEventListener("blur"');
      expect(source).toMatch(/modeRef\.current\s*=\s*"list"/);
    });

    it("handles Enter / ArrowRight to enter toolbar mode and Escape to return to list mode", () => {
      expect(source).toMatch(/"Enter"/);
      expect(source).toMatch(/"ArrowRight"/);
      expect(source).toMatch(/"Escape"/);
    });

    it("handles Space to select the row's primary worktree button", () => {
      expect(source).toMatch(/aria-label\^='Select worktree'/);
    });
  });
});
