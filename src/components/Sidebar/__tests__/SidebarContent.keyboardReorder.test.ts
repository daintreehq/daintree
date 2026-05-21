import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const SIDEBAR_CONTENT_PATH = path.resolve(__dirname, "../SidebarContent.tsx");

// Static-source assertions for the SR announcement plumbing on top of
// keyboard reorder (issue #8013). The keystroke→callback path itself is
// covered behaviorally by useWorktreeSidebarKeyboard.altArrow.test.tsx.
describe("SidebarContent keyboard reorder announcement — issue #8013", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
  });

  describe("worktree name in the announcement", () => {
    it("captures the latest worktrees in a ref so the callback identity stays stable", () => {
      expect(source).toMatch(
        /const\s+worktreesRef\s*=\s*useRef<readonly WorktreeState\[\]>\(\[\]\)/
      );
      expect(source).toContain("worktreesRef.current = worktrees;");
    });

    it("resolves the moved row's display name, falling back to its id", () => {
      expect(source).toMatch(
        /worktreesRef\.current\.find\(\(w\)\s*=>\s*w\.id\s*===\s*worktreeId\)\?\.name\s*\?\?\s*worktreeId/
      );
    });

    it("announces the worktree name alongside the position", () => {
      expect(source).toContain(
        "`Moved '${name}' to position ${targetIdx + 1} of ${visible.length}`"
      );
      expect(source).not.toMatch(/`Moved to position \$\{targetIdx \+ 1\}/);
    });
  });

  describe("debounced live-region update", () => {
    it("holds a timer ref for the trailing debounce", () => {
      expect(source).toMatch(
        /const\s+reorderAnnouncementTimerRef\s*=\s*useRef<ReturnType<typeof setTimeout>\s*\|\s*null>\(null\)/
      );
    });

    it("clears any pending timer before scheduling the next announcement", () => {
      expect(source).toMatch(
        /if\s*\(reorderAnnouncementTimerRef\.current\s*!==\s*null\)\s*\{\s*clearTimeout\(reorderAnnouncementTimerRef\.current\)/
      );
    });

    it("defers setKeyboardReorderAnnouncement behind a 150ms trailing timeout", () => {
      expect(source).toMatch(/const\s+KEYBOARD_REORDER_ANNOUNCEMENT_DEBOUNCE_MS\s*=\s*150/);
      expect(source).toMatch(
        /reorderAnnouncementTimerRef\.current\s*=\s*setTimeout\(\(\)\s*=>\s*\{[\s\S]*?reorderAnnouncementTimerRef\.current\s*=\s*null;[\s\S]*?setKeyboardReorderAnnouncement\(message\);[\s\S]*?\},\s*KEYBOARD_REORDER_ANNOUNCEMENT_DEBOUNCE_MS\)/
      );
    });

    it("does not call setKeyboardReorderAnnouncement synchronously in the callback", () => {
      const synchronousCall =
        /setKeyboardReorderAnnouncement\(`Moved/.test(source) ||
        /setOrderBy\("manual"\);\s*setKeyboardReorderAnnouncement/.test(source);
      expect(synchronousCall).toBe(false);
    });
  });

  describe("reorder callback signature — virtualized rewrite", () => {
    it("accepts a worktreeId string (not a DOM row element) from the keyboard hook", () => {
      // The virtualized sidebar may have the source row unmounted outside
      // Virtuoso's overscan; the hook resolves the id from items, not the DOM.
      expect(source).toMatch(
        /handleKeyboardReorder = useCallback\(\(worktreeId: string, delta: -1 \| 1\)/
      );
      expect(source).not.toMatch(/rowEl: HTMLElement/);
      expect(source).not.toContain("rowEl.dataset.worktreeRow");
    });
  });

  describe("unmount safety", () => {
    it("clears a pending announcement timer when the sidebar unmounts", () => {
      expect(source).toMatch(
        /useEffect\(\(\)\s*=>\s*\{\s*return\s*\(\)\s*=>\s*\{\s*if\s*\(reorderAnnouncementTimerRef\.current\s*!==\s*null\)\s*\{\s*clearTimeout\(reorderAnnouncementTimerRef\.current\)/
      );
    });
  });
});

// Issue #8395 — When isSortDisabled transitions from true to false (filter
// cleared or group-by-type toggled off), fire an sr-only announcement so
// screen-reader users know reorder is available again.
describe("SidebarContent reorder re-enable announcement — issue #8395", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
  });

  it("tracks the previous sort-disabled state in a ref", () => {
    expect(source).toMatch(
      /const\s+isSortDisabledPrevRef\s*=\s*useRef\(isGroupedByType\s*\|\|\s*query\.trim\(\)\.length\s*>\s*0\)/
    );
  });

  it("fires useEffect when isGroupedByType or query changes", () => {
    expect(source).toMatch(
      /useEffect\(\(\)\s*=>\s*\{[\s\S]*isSortDisabledPrevRef[\s\S]*\},\s*\[isGroupedByType,\s*query\]\)/
    );
  });

  it("announces 'Manual reorder available' on the enable transition", () => {
    expect(source).toContain('setKeyboardReorderAnnouncement("Manual reorder available")');
  });

  it("debounces the re-enable announcement via the shared timer ref", () => {
    expect(source).toMatch(
      /reorderAnnouncementTimerRef\.current\s*=\s*setTimeout[\s\S]*"Manual reorder available"/
    );
  });

  it("clears any pending reorder announcement before scheduling the re-enable", () => {
    expect(source).toMatch(
      /if\s*\(reorderAnnouncementTimerRef\.current\s*!==\s*null\)[\s\S]*clearTimeout[\s\S]*reorderAnnouncementTimerRef\.current\s*=\s*setTimeout[\s\S]*"Manual reorder available"/
    );
  });

  it("gates on prev===true && current===false transition", () => {
    expect(source).toMatch(/prev\s*&&\s*!current/);
  });

  it("cleans up the pending timer on effect teardown", () => {
    expect(source).toMatch(
      /return\s*\(\)\s*=>\s*\{[\s\S]*clearTimeout\(reorderAnnouncementTimerRef\.current\)[\s\S]*reorderAnnouncementTimerRef\.current\s*=\s*null/
    );
  });
});
