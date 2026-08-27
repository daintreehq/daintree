import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const SIDEBAR_CONTENT_PATH = path.resolve(__dirname, "../SidebarContent.tsx");
const STATIC_ROW_PATH = path.resolve(__dirname, "../StaticWorktreeRow.tsx");
const SORTABLE_CARD_PATH = path.resolve(__dirname, "../../DragDrop/SortableWorktreeCard.tsx");
const WORKTREE_CARD_PATH = path.resolve(__dirname, "../../Worktree/WorktreeCard.tsx");
const WORKTREE_ACTIONS_TOOLBAR_PATH = path.resolve(
  __dirname,
  "../../Worktree/WorktreeCard/WorktreeActionsToolbar.tsx"
);
const KEYBOARD_HOOK_PATH = path.resolve(__dirname, "../useWorktreeSidebarKeyboard.ts");

describe("Worktree list keyboard grid — issue #6422 / virtualized rewrite", () => {
  describe("SortableWorktreeCard ARIA contract", () => {
    let source: string;
    beforeEach(async () => {
      source = await fs.readFile(SORTABLE_CARD_PATH, "utf-8");
    });

    it("strips dnd-kit's tabIndex from spread attributes so the row never gets a stray tab stop", () => {
      expect(source).toMatch(/tabIndex:\s*_tabIndex/);
    });

    it('uses role="row" (not listitem) so the wrapper participates in the grid', () => {
      expect(source).toContain('role="row"');
      expect(source).not.toContain('role="listitem"');
    });

    it("exposes data-worktree-row so the keyboard controller can locate rows", () => {
      expect(source).toContain("data-worktree-row={worktreeId}");
    });

    it("exposes a stable DOM id via getWorktreeSidebarRowId for aria-activedescendant", () => {
      expect(source).toContain("getWorktreeSidebarRowId");
      expect(source).toContain("id={getWorktreeSidebarRowId(worktreeId)}");
    });

    it('wraps children in role="gridcell" for valid grid > row > gridcell semantics', () => {
      expect(source).toContain('role="gridcell"');
    });

    it("starts with tabIndex={-1}; the grid container holds the single tab stop", () => {
      expect(source).toContain("tabIndex={-1}");
    });

    it("does not apply content-visibility: auto to the row wrapper (lesson #4438 + virtualization)", () => {
      // Virtuoso provides equivalent windowing — keeping content-visibility:auto
      // would only break dnd-kit transforms on the dragged row.
      expect(source).not.toMatch(/contentVisibility:\s*["']auto["']/);
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

    it("keeps outline-hidden on the inner click-target button to preserve forced-colors UA outline (#8094)", () => {
      expect(source).toMatch(/"absolute inset-0 z-0 outline-hidden"/);
    });

    it("does not paint a duplicate accent focus ring on the inner button — card-level :has(> button:focus-visible) ring is canonical (#8094)", () => {
      expect(source).not.toContain("focus-visible:outline-daintree-accent");
      expect(source).not.toContain("focus-visible:ring-daintree-accent");
    });
  });

  describe("WorktreeHeader actions toolbar", () => {
    let source: string;
    beforeEach(async () => {
      source = await fs.readFile(WORKTREE_ACTIONS_TOOLBAR_PATH, "utf-8");
    });

    it("marks the actions wrapper with data-worktree-row-toolbar so the controller can find it", () => {
      expect(source).toContain('data-worktree-row-toolbar=""');
    });

    it('declares role="toolbar" and an accessible label', () => {
      expect(source).toMatch(/role="toolbar"/);
      expect(source).toMatch(/aria-label="Worktree actions"/);
    });
  });

  describe("WorktreeCard drag handle", () => {
    const SIDEBAR_CSS_PATH = path.resolve(__dirname, "../../../styles/components/sidebar.css");

    it("marks the drag handle with data-worktree-row-drag-handle so focus CSS can target it", async () => {
      const cardSource = await fs.readFile(WORKTREE_CARD_PATH, "utf-8");
      expect(cardSource).toContain('data-worktree-row-drag-handle=""');
    });

    it("reveals drag handle on keyboard focus via [data-worktree-row-drag-handle] CSS selector", async () => {
      const cssSource = await fs.readFile(SIDEBAR_CSS_PATH, "utf-8");
      expect(cssSource).toContain("[data-worktree-row-drag-handle]");
    });

    it("uses group-hover/card for mouse row-level reveal (not self-scoped hover)", async () => {
      // Discoverability is row-scoped: hovering anywhere on the card has to
      // surface the grip, or nobody finds it. The grip rests at opacity 0, so
      // the row-level reveal is the fade — not a colour change on something
      // already painted.
      const cardSource = await fs.readFile(WORKTREE_CARD_PATH, "utf-8");
      expect(cardSource).toContain("group-hover/card:opacity-100");
    });

    it("keeps the grip's backplate self-scoped so row hover does not paint a bar", async () => {
      // The grip is a full-height column. When its backplate came up on row
      // hover it painted a bar down the whole card and became the most
      // prominent thing on a row whose subject is the worktree — for a control
      // most hovers never wanted. Brightening the glyph is the row-level
      // affordance; the plate waits for the pointer to reach the grip.
      const cardSource = await fs.readFile(WORKTREE_CARD_PATH, "utf-8");
      expect(cardSource).not.toContain("group-hover/card:bg-overlay-soft");
      expect(cardSource).toContain("hover:bg-overlay-soft");
    });

    it("keeps motion-reduce:transition-none on the drag handle for WCAG reduced-motion", async () => {
      const cardSource = await fs.readFile(WORKTREE_CARD_PATH, "utf-8");
      expect(cardSource).toContain("motion-reduce:transition-none");
    });
  });

  describe("SidebarContent virtualized grid wiring", () => {
    let source: string;
    beforeEach(async () => {
      source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
    });

    it("imports the new aria-activedescendant keyboard hook", () => {
      expect(source).toContain('from "./useWorktreeSidebarKeyboard"');
      expect(source).toContain("useWorktreeSidebarKeyboard");
    });

    it("renders a Virtuoso list (not a flat .map render) for the non-main worktrees", () => {
      expect(source).toContain('from "react-virtuoso"');
      expect(source).toMatch(/<Virtuoso<SidebarFlatItem,\s*SidebarVirtuosoContext>/);
    });

    it("wires gridRef + handlers + aria-activedescendant onto the role='grid' container", () => {
      expect(source).toMatch(/aria-activedescendant=\{activeDescendantId\}/);
      expect(source).toContain('role="grid"');
      expect(source).toContain('aria-label="Worktrees"');
      expect(source).toContain("ref={gridRef}");
      expect(source).toContain("onKeyDown={handleGridKeyDown}");
      expect(source).toContain("onFocus={handleGridFocus}");
      expect(source).toContain("onFocusCapture={handleGridFocusCapture}");
    });

    it("sets a single tab stop on the grid container (not on individual rows)", () => {
      // aria-activedescendant pattern: container holds tabIndex=0, rows stay -1.
      expect(source).toMatch(/role="grid"[\s\S]{0,300}tabIndex=\{0\}/);
    });

    it("passes overscan + skipAnimationFrameInResizeObserver to Virtuoso", () => {
      expect(source).toContain("SIDEBAR_VIRTUOSO_OVERSCAN_PX");
      expect(source).toContain("skipAnimationFrameInResizeObserver");
    });

    it("uses module-level computeSidebarItemKey for stable item identity (past lesson #1992)", () => {
      expect(source).toMatch(/function\s+computeSidebarItemKey\b/);
      expect(source).toContain("computeItemKey={computeSidebarItemKey}");
    });

    it("threads reactive row state through Virtuoso's context prop (React Compiler safety)", () => {
      expect(source).toMatch(/context=\{virtuosoContext\}/);
      expect(source).toMatch(/const\s+virtuosoContext\s*=\s*useMemo</);
    });

    it("wraps Virtuoso in SortableContext only when sort is enabled", () => {
      // Grouped sections disable sort and render static rows that don't call
      // useSortable — wrapping that path in SortableContext would be a no-op
      // and confuse dnd-kit measurement.
      expect(source).toMatch(/groupedSections\s*\?\s*\(\s*<Virtuoso/);
      expect(source).toMatch(/<SortableContext\s+items=\{sortableIds\}/);
    });

    it("wraps StaticWorktreeRow's WorktreeCard in role='row' + data-worktree-row + role='gridcell'", async () => {
      const staticSource = await fs.readFile(STATIC_ROW_PATH, "utf-8");
      expect(staticSource).toMatch(/role="row"/);
      expect(staticSource).toContain("data-worktree-row={worktreeId}");
      expect(staticSource).toContain("tabIndex={-1}");
      expect(staticSource).toContain('role="gridcell"');
    });

    it("applies the stable aria-activedescendant id to StaticWorktreeRow", async () => {
      const staticSource = await fs.readFile(STATIC_ROW_PATH, "utf-8");
      expect(staticSource).toContain("getWorktreeSidebarRowId");
      expect(staticSource).toContain("id={getWorktreeSidebarRowId(worktreeId)}");
    });
  });

  describe("useWorktreeSidebarKeyboard hook", () => {
    let source: string;
    beforeEach(async () => {
      source = await fs.readFile(KEYBOARD_HOOK_PATH, "utf-8");
    });

    it("exports a stable ID generator that pairs with aria-activedescendant", () => {
      expect(source).toContain("export function getWorktreeSidebarRowId");
      expect(source).toMatch(/worktree-sidebar-row-/);
    });

    it("tracks the active row by worktree id (not DOM index) so unmounted rows don't strand focus", () => {
      expect(source).toMatch(
        /\[activeWorktreeId,\s*setActiveWorktreeId\]\s*=\s*useState<string \| null>/
      );
    });

    it("returns an aria-activedescendant id, not a focused DOM element", () => {
      expect(source).toMatch(/activeDescendantId/);
    });

    it("provides j / k aliases alongside ArrowUp / ArrowDown for vim navigation", () => {
      expect(source).toMatch(/case\s+"j"/);
      expect(source).toMatch(/case\s+"k"/);
    });

    it("uses VirtuosoHandle.scrollToIndex to bring the active row into view", () => {
      expect(source).toMatch(/virtuosoRef\.current\?\.scrollToIndex\(/);
    });

    it("preserves the toolbar sub-mode entered via Enter / ArrowRight", () => {
      expect(source).toMatch(/"Enter"/);
      expect(source).toMatch(/"ArrowRight"/);
      expect(source).toMatch(/"Escape"/);
      expect(source).toMatch(/setGridMode\(\s*"toolbar"\s*\)/);
    });

    it("resets to list mode on window blur (lesson #4591)", () => {
      expect(source).toContain('window.addEventListener("blur"');
      expect(source).toMatch(/setGridMode\(\s*"list"\s*\)/);
    });

    it("allows Ctrl+Home and Ctrl+End through the modifier guard", () => {
      expect(source).toMatch(/e\.ctrlKey && e\.key !== "Home" && e\.key !== "End"/);
    });

    it("splits the modifier guard so Alt+Arrow carves through but other Alt combos bail", () => {
      expect(source).toMatch(/if \(e\.metaKey\) return;/);
      expect(source).toMatch(/e\.altKey && \(e\.key === "ArrowUp" \|\| e\.key === "ArrowDown"\)/);
      expect(source).toMatch(/if \(e\.altKey && !isAltArrowReorder\) return;/);
    });

    it("calls the reorder callback with (worktreeId, delta) — not a DOM element", () => {
      expect(source).toMatch(
        /onKeyboardReorderRef\.current\?\.\(\s*currentWorktreeId\s*,\s*e\.key === "ArrowDown" \? 1 : -1\s*\)/
      );
    });

    it("clamps the active worktree to one that still exists in the items list", () => {
      // When a filter removes the previously-active row, the hook must reseat
      // activeWorktreeId so aria-activedescendant doesn't point at a missing id.
      expect(source).toMatch(/stillVisible/);
    });

    it("skips scrollToIndex for pinned rows (they live outside Virtuoso)", () => {
      // Pinned rows are always mounted, so navigating to one must NOT call
      // scrollToIndex — that would point at the wrong Virtuoso row.
      expect(source).toMatch(/item\.isPinned/);
      expect(source).toMatch(/if \(item\.isPinned\) return/);
    });

    it("offsets the Virtuoso scrollToIndex by the number of preceding pinned rows", () => {
      // The flat items list interleaves pinned rows ahead of the virtualized
      // items; subtract the count so scrollToIndex targets the right row.
      expect(source).toMatch(/pinnedBefore/);
      expect(source).toMatch(/index: flatIndex - pinnedBefore/);
    });

    it("encodes worktree ids before composing the DOM id (paths may contain spaces)", () => {
      // Worktree ids are filesystem paths; on macOS they often contain spaces
      // which produce invalid id attributes.
      expect(source).toMatch(/encodeURIComponent\(worktreeId\)/);
    });
  });

  describe("SidebarContent — pinned rows participate in keyboard navigation", () => {
    let source: string;
    beforeEach(async () => {
      source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
    });

    it("prepends the main worktree to keyboardItems when visible", () => {
      expect(source).toMatch(/if \(mainVisible && mainWorktree\)[\s\S]{0,200}isPinned: true/);
    });

    it("keeps the main worktree as the only row pinned outside Virtuoso (#11433)", () => {
      // A second pinned slot used to hold whichever worktree happened to sit on
      // `develop`/`trunk`/`next`, which removed it from the counts and the list.
      // Every other worktree now reaches the grid through sidebarItems. The test
      // above pins down *which* row stays pinned; this one pins the count.
      expect(source.match(/isPinned: true/g)).toHaveLength(1);
    });
  });

  describe("issue #7212 — APG grid attributes and keyboard model", () => {
    describe("aria-rowcount / aria-rowindex threading", () => {
      it("exposes aria-rowcount on the grid container", async () => {
        const source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
        expect(source).toContain("aria-rowcount={ariaRowCount}");
      });

      it("computes ariaRowCount including pinned, group header, and data rows", async () => {
        const source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
        expect(source).toMatch(/const ariaRowCount =/);
        expect(source).toMatch(
          /groupedSections[\s\S]*?\.reduce\([\s\S]*?1 \+ s\.worktrees\.length/
        );
      });

      it("anchors the virtualized rows directly after the single pinned main row", async () => {
        // With only the main row pinned, the first virtualized row sits one slot
        // past it and the row count starts from the same base. A second pinned
        // slot would have to reintroduce an offset here (#11433).
        const source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
        expect(source).toMatch(/const firstScrollableRowIndex = mainRowIndex \+ 1;/);
        expect(source).toMatch(/const ariaRowCount =\s*\n?\s*mainRowIndex \+/);
        expect(source).toMatch(/let nextRowIndex = firstScrollableRowIndex;/);
      });

      it("StaticWorktreeRow applies aria-rowindex to its role='row' div", async () => {
        const source = await fs.readFile(STATIC_ROW_PATH, "utf-8");
        expect(source).toContain("aria-rowindex={ariaRowIndex}");
      });

      it("SortableWorktreeCard applies aria-rowindex to its role='row' div", async () => {
        const source = await fs.readFile(SORTABLE_CARD_PATH, "utf-8");
        expect(source).toContain("aria-rowindex={ariaRowIndex}");
      });

      it("threads ariaRowIndex through SidebarWorktreeRow → SortableWorktreeCard", async () => {
        const sidebarRowSource = await fs.readFile(
          path.resolve(__dirname, "../SidebarWorktreeRow.tsx"),
          "utf-8"
        );
        expect(sidebarRowSource).toMatch(/ariaRowIndex:\s*number/);
        expect(sidebarRowSource).toContain("ariaRowIndex={ariaRowIndex}");
      });
    });

    describe("aria-current on the active row", () => {
      it("StaticWorktreeRow applies aria-current='true' when the row is active", async () => {
        const source = await fs.readFile(STATIC_ROW_PATH, "utf-8");
        expect(source).toContain('aria-current={isActive ? "true" : undefined}');
      });

      it("SortableWorktreeCard applies aria-current='true' when the row is active", async () => {
        const source = await fs.readFile(SORTABLE_CARD_PATH, "utf-8");
        expect(source).toContain('aria-current={isActive ? "true" : undefined}');
      });

      it("removes the (selected) suffix from WorktreeCard's aria-label", async () => {
        const source = await fs.readFile(WORKTREE_CARD_PATH, "utf-8");
        expect(source).not.toContain('" (selected)"');
      });

      it("WorktreeCard sets aria-current on the grid variant (overview modal has no row wrapper)", async () => {
        const source = await fs.readFile(WORKTREE_CARD_PATH, "utf-8");
        expect(source).toContain(
          'aria-current={variant === "grid" && isActive ? "true" : undefined}'
        );
      });
    });

    describe("grouped-by-type section structure", () => {
      let source: string;
      beforeEach(async () => {
        source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
      });

      it("emits header sentinels with role='row' + role='rowheader' from renderSidebarFlatItem", () => {
        // After virtualization, headers are flat items rather than nested
        // role='rowgroup' children. They still carry role='row' + 'rowheader'.
        expect(source).toMatch(/item\.kind === "header"/);
        expect(source).toContain('role="row"');
        expect(source).toContain('role="rowheader"');
        expect(source).toContain("aria-colspan={1}");
      });

      it("threads aria-rowindex onto group header rows", () => {
        // Headers count toward aria-rowcount and carry their own aria-rowindex.
        expect(source).toMatch(/aria-rowindex=\{item\.ariaRowIndex\}/);
      });
    });

    describe("keyboard model — PageUp/PageDown and Ctrl+Home/Ctrl+End", () => {
      let source: string;
      beforeEach(async () => {
        source = await fs.readFile(KEYBOARD_HOOK_PATH, "utf-8");
      });

      it("handles PageDown and PageUp in the list-mode switch", () => {
        expect(source).toMatch(/case "PageDown"/);
        expect(source).toMatch(/case "PageUp"/);
      });

      it("computes the page step from the Virtuoso scroller's viewport height", () => {
        expect(source).toMatch(/computePageSize/);
        expect(source).toMatch(/scrollerRef/);
      });

      it("clamps ArrowUp/ArrowDown at the grid boundary (no wrap)", () => {
        // The advance() helper returns null at the boundary; no modulo arithmetic.
        expect(source).not.toMatch(/%\s*items\.length/);
      });
    });
  });

  describe("issue #9667 — keyboard cursor surfaced as a visible row state", () => {
    const SIDEBAR_CSS_PATH = path.resolve(__dirname, "../../../styles/components/sidebar.css");

    it("exposes keyboardCursorId from the keyboard hook, mode-guarded to list mode", async () => {
      const source = await fs.readFile(KEYBOARD_HOOK_PATH, "utf-8");
      expect(source).toMatch(/keyboardCursorId:\s*string \| null/);
      // Cursor only exists in list mode — toolbar mode hands the focus ring to
      // the real DOM button, so the row-level cursor must read null there.
      expect(source).toMatch(/keyboardCursorId\s*=\s*mode === "list" \? activeWorktreeId : null/);
    });

    it("threads keyboardCursorId through the Virtuoso context into both row paths", async () => {
      const source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
      expect(source).toMatch(/keyboardCursorId:\s*string \| null/);
      expect(source).toContain("keyboardCursorId={context.keyboardCursorId}");
      // The pinned (main + integration) rows live outside the Virtuoso surface
      // and must receive the cursor id directly from the hook return.
      expect(source).toContain("keyboardCursorId={keyboardCursorId}");
    });

    it("flags the cursor row via data-keyboard-cursor in both static and sortable paths", async () => {
      const staticSource = await fs.readFile(STATIC_ROW_PATH, "utf-8");
      const sortableSource = await fs.readFile(SORTABLE_CARD_PATH, "utf-8");
      expect(staticSource).toContain(
        'data-keyboard-cursor={isKeyboardCursor ? "true" : undefined}'
      );
      expect(sortableSource).toContain(
        'data-keyboard-cursor={isKeyboardCursor ? "true" : undefined}'
      );
    });

    it("includes isKeyboardCursor in the SortableWorktreeCard memo comparator so the ring updates", async () => {
      // Without this the React.memo comparator would swallow cursor changes and
      // the ring would stick on a stale row as the user navigates.
      const sortableSource = await fs.readFile(SORTABLE_CARD_PATH, "utf-8");
      expect(sortableSource).toMatch(/prev\.isKeyboardCursor\s*!==\s*next\.isKeyboardCursor/);
    });

    it("ships a forced-colors outline fallback for the cursor ring (box-shadow is stripped there)", async () => {
      const css = await fs.readFile(SIDEBAR_CSS_PATH, "utf-8");
      // Split on each forced-colors media query and inspect the segment up to
      // the next media query — robust to brace indentation, unlike a lazy
      // `\n}` block match which depends on prettier's exact formatting.
      const segments = css.split("@media (forced-colors: active)").slice(1);
      const hasCursorFallback = segments.some((seg) => {
        const block = seg.split("@media")[0]!;
        return (
          block.includes('data-keyboard-cursor="true"') &&
          /outline:\s*2px solid Highlight/.test(block)
        );
      });
      expect(hasCursorFallback).toBe(true);
    });
  });

  describe("issue #8389 — per-row sidebar subscription stops full-list re-renders", () => {
    let source: string;
    let staticSource: string;
    beforeEach(async () => {
      source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
      staticSource = await fs.readFile(STATIC_ROW_PATH, "utf-8");
    });

    it("StaticWorktreeRow subscribes to its own store slice by id (not a prop object)", () => {
      // The row reads exactly its own snapshot via a primitive Map-get
      // selector, so an unrelated worktree changing in the poll cycle does
      // not invalidate this row's selector result.
      expect(staticSource).toMatch(
        /useWorktreeStore\(\s*\(state\)\s*=>\s*state\.worktrees\.get\(worktreeId\)\s*\)/
      );
      // The row's public prop is the id, never a full WorktreeState object.
      expect(staticSource).toContain("worktreeId: string;");
      expect(staticSource).not.toMatch(/worktree:\s*WorktreeState;/);
    });

    it("removes the per-render renderWorktreeCard closure that re-created every row element each poll", () => {
      // A closure rebuilt on every SidebarContent render produced a fresh
      // element factory each poll, defeating the React Compiler's per-row
      // memoization. Rows must be authored as inline JSX so each element is
      // memoized by its own (id-only) props.
      expect(source).not.toMatch(/const renderWorktreeCard\s*=/);
      expect(source).not.toMatch(/renderWorktreeCard\(/);
      // Guard against the same anti-pattern resurfacing under a different
      // name — any per-render closure that returns a <StaticWorktreeRow/>
      // factory re-creates row elements each poll and defeats memoization.
      expect(source).not.toMatch(
        /const \w*(?:render|make|build)\w*(?:Row|Card)\w*\s*=\s*\([^)]*\)\s*=>\s*\(?\s*<StaticWorktreeRow/
      );
    });

    it("threads only the worktreeId (not a full worktree object) into StaticWorktreeRow across all render paths", () => {
      // The main (pinned) row stays as inline JSX outside the Virtuoso
      // surface; its id-only prop shape is preserved.
      expect(source).toMatch(
        /<StaticWorktreeRow\s+key=\{mainWorktree\.id\}\s+worktreeId=\{mainWorktree\.id\}/
      );
      // Virtualized rows are produced by renderSidebarFlatItem which reads
      // `item.worktreeId` off each Virtuoso item — never a full worktree
      // object — and the sidebarItems memo iterates `section.worktrees` to
      // push those items.
      expect(source).toMatch(/<StaticWorktreeRow\s+worktreeId=\{item\.worktreeId\}/);
      expect(source).toMatch(/for \(const w of section\.worktrees\)/);
      expect(source).toMatch(/worktreeId:\s*w\.id/);
      // No render path threads a full worktree object into the row.
      expect(source).not.toMatch(/<StaticWorktreeRow[^>]*\bworktree=\{/);
    });

    it("preserves the side-effecting aria-rowindex counter in the grouped path", () => {
      // The 1-based aria-rowindex slot advances per item the sidebarItems
      // memo emits (header sentinel + each row). Virtuoso renders the items;
      // the counter still post-increments inside the iteration so each
      // emitted item carries the next 1-based row slot.
      expect(source).toMatch(/ariaRowIndex:\s*nextRowIndex\+\+/);
    });
  });

  describe("issue #7972 — sortable sidebar drop indicator and keyboard reorder", () => {
    describe("SortableWorktreeCard directional drop indicator", () => {
      let source: string;
      beforeEach(async () => {
        source = await fs.readFile(SORTABLE_CARD_PATH, "utf-8");
      });

      it("computes drop direction from active vs over rect midpoints", () => {
        expect(source).toContain("active?.rect.current.translated");
        expect(source).toMatch(/translatedRect\.top \+ translatedRect\.height \/ 2/);
        expect(source).toMatch(/over\.rect\.top \+ over\.rect\.height \/ 2/);
      });

      it("gates the insertion line on a worktree-sort drag (not terminal/browser drags)", () => {
        expect(source).toMatch(/active\?\.data\.current\?\.type === "worktree-sort"/);
      });

      it("marks the outer wrapper relative so the absolute indicator positions against the row", () => {
        expect(source).toContain('className="relative"');
      });

      it("uses neutral bg-border-strong (no accent tokens) for the indicator", () => {
        expect(source).toContain("bg-border-strong");
        expect(source).not.toMatch(/daintree-accent|accent-primary/);
      });

      it("renders the indicator above (-top-px) or below (-bottom-px) based on drop direction", () => {
        expect(source).toContain('"-top-px"');
        expect(source).toContain('"-bottom-px"');
      });

      it("marks the indicator pointer-events-none so it never blocks the drop target", () => {
        expect(source).toContain("pointer-events-none");
      });

      it("exposes the indicator via data-worktree-drop-indicator for E2E and DOM assertions", () => {
        expect(source).toContain("data-worktree-drop-indicator");
      });

      it("advertises Alt+ArrowUp/Down via aria-keyshortcuts when the row is sortable", () => {
        expect(source).toMatch(
          /aria-keyshortcuts=\{disabled \? undefined : "Alt\+ArrowUp Alt\+ArrowDown"\}/
        );
      });
    });

    describe("SidebarContent wires keyboard reorder to applyManualWorktreeReorder", () => {
      let source: string;
      beforeEach(async () => {
        source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
      });

      it("imports the shared reorder helper used by drag-end (single source of truth)", () => {
        expect(source).toContain('from "@/lib/worktreeReorder"');
        expect(source).toContain("applyManualWorktreeReorder");
      });

      it("renders a sr-only aria-live polite region for keyboard reorder announcements", () => {
        expect(source).toMatch(/className="sr-only"[\s\S]*?aria-live="polite"/);
        expect(source).toContain("keyboardReorderAnnouncement");
      });

      it("receives a worktreeId (not a DOM element) from the keyboard hook and bounds-clamps the move", () => {
        expect(source).toMatch(
          /handleKeyboardReorder = useCallback\(\(worktreeId: string, delta: -1 \| 1\)/
        );
        expect(source).toMatch(/targetIdx < 0 \|\| targetIdx >= visible\.length/);
      });

      it("routes the reorder through useWorktreeFilterStore (manualOrder + manual sort)", () => {
        expect(source).toMatch(/filterStore\.setManualOrder\(merged\)/);
        expect(source).toMatch(/filterStore\.setOrderBy\("manual"\)/);
      });

      it("guards the reorder against grouped-by-type / active-search modes so it never silently mutates manualOrder when the drag handle is hidden", () => {
        expect(source).toMatch(/isSortDisabledRef\s*=\s*useRef\(false\)/);
        expect(source).toMatch(/isSortDisabledRef\.current\s*=\s*isSortDisabled/);
        const guard = source.match(/handleKeyboardReorder = useCallback\([\s\S]*?\}, \[\]\);/);
        expect(guard).toBeTruthy();
        expect(guard?.[0]).toMatch(/if \(isSortDisabledRef\.current\) return;/);
      });
    });
  });
});
