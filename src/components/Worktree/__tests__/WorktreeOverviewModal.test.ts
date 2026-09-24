// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const MODAL_PATH = path.resolve(__dirname, "../WorktreeOverviewModal.tsx");
const ROW_PATH = path.resolve(__dirname, "../WorktreeOverviewRow.tsx");

describe("WorktreeOverviewModal — clickable aggregate stats (#8385)", () => {
  let source: string;
  let rowSource: string;

  beforeEach(async () => {
    source = await fs.readFile(MODAL_PATH, "utf-8");
    rowSource = await fs.readFile(ROW_PATH, "utf-8");
  });

  describe("imports", () => {
    it("imports matchesQuickStateFilter from worktreeFilters", () => {
      expect(source).toMatch(/matchesQuickStateFilter/);
    });

    it("imports setQuickStateFilter from the filter store", () => {
      expect(source).toContain("setQuickStateFilter");
    });
  });

  describe("store selector", () => {
    it("reads quickStateFilter from the store", () => {
      expect(source).toMatch(/quickStateFilter:\s*state\.quickStateFilter/);
    });
  });

  describe("filteredWorktrees computation", () => {
    it("gates on matchesQuickStateFilter when quickStateFilter is not 'all'", () => {
      expect(source).toMatch(
        /quickStateFilter\s*!==\s*"all"\s*&&\s*!matchesQuickStateFilter\(quickStateFilter,\s*derived\)/
      );
    });

    it("includes quickStateFilter in the useMemo dep array", () => {
      // Find the dep array that closes the filteredWorktrees useMemo
      const depArrayMatch = source.match(
        /const\s*\{\s*filteredWorktrees,\s*groupedSections[^}]*\}\s*=\s*useMemo[\s\S]*?\]\s*\);/
      );
      expect(depArrayMatch).not.toBeNull();
      expect(depArrayMatch![0]).toContain("quickStateFilter");
    });

    it("lets the always-show bypasses fire only when nothing is narrowing the list", () => {
      expect(source).toMatch(
        /bypassesNarrowing\s*=\s*!hasActiveQuery\s*&&\s*quickStateFilter\s*===\s*"all"\s*&&\s*!hasFacetFiltersActive/
      );
      expect(source).toMatch(/alwaysShowActive\s*&&\s*isActive\s*&&\s*bypassesNarrowing/);
      expect(source).toMatch(
        /alwaysShowWaiting\s*&&\s*derived\.hasWaitingAgent\s*&&\s*bypassesNarrowing/
      );
    });

    it("filters on the field's live query, not the debounced persisted one", () => {
      expect(source).toMatch(/liveQuery:\s*state\.liveQuery/);
      expect(source).not.toMatch(/\bquery:\s*state\.query\b/);
    });
  });

  describe("multi-select and keyboard navigation (#8653)", () => {
    it("imports the overview keyboard hook", () => {
      expect(source).toMatch(/useWorktreeOverviewKeyboard/);
    });

    it("imports getWorktreeOverviewCellId for stable cell ids", () => {
      expect(source).toMatch(/getWorktreeOverviewCellId/);
    });

    it("declares modal-local selection state (Set of worktree ids)", () => {
      expect(source).toMatch(/useState<Set<string>>/);
    });

    it("anchors range selection in a ref so it survives filter changes", () => {
      expect(source).toMatch(/selectionAnchorRef\s*=\s*useRef<string\s*\|\s*null>/);
    });

    it("renders a single role='grid' wrapper around the cards", () => {
      expect(source).toContain('role="grid"');
    });

    it("declares aria-multiselectable on the grid", () => {
      expect(source).toContain('aria-multiselectable="true"');
    });

    it("threads aria-activedescendant through the grid container", () => {
      expect(source).toContain("aria-activedescendant={activeDescendantId}");
    });

    it("renders each worktree as a row owning a gridcell that carries aria-selected", () => {
      expect(rowSource).toContain('role="row"');
      expect(rowSource).toContain('role="gridcell"');
      expect(rowSource).toMatch(/aria-selected=\{isSelected\}/);
    });

    it("passes isSelected as boolean (not the Set) to each cell", () => {
      // Avoid #4749 — never pass the Set or an index down; only the boolean
      // result of `.has()` so memoization narrows re-renders to changed cells.
      expect(source).toMatch(/isSelected=\{selectedIds\.has\(worktree\.id\)\}/);
    });

    it("marks membership neutrally — a raised fill and a checked box, never accent", () => {
      // Accent belongs to the cursor alone in this arrow-key domain. The fill
      // step is far below SC 1.4.11's 3:1, so the checked box is the actual
      // non-text indicator and must show whenever the row is selected.
      const fill = rowSource.match(/isSelected\s*\?\s*"([^"]+)"/)?.[1] ?? "";
      expect(fill).toMatch(/\bbg-overlay-\w+/);
      expect(fill).not.toMatch(/accent/);
      expect(rowSource).toMatch(/isSelecting\s*\|\|\s*isSelected\s*\|\|\s*!TypeIcon\s*\?\s*"flex"/);
    });

    it("does not introduce any forbidden accent token for selection treatment", () => {
      // Composite assertion — accentGuard.contract.test.ts is the source of
      // truth, but a local guard catches regressions before that contract
      // test runs.
      const selectionAccentTokens = [
        "bg-accent-primary",
        "bg-accent-primary",
        "bg-accent-soft",
        "text-accent-primary",
        "text-accent-primary",
      ];
      for (const token of selectionAccentTokens) {
        const usagePattern = new RegExp(`isSelected[^"]*${token}|${token}[^"]*isSelected`);
        expect(source).not.toMatch(usagePattern);
      }
    });

    it("reconciles selection when the visible worktree set changes", () => {
      expect(source).toMatch(/setSelectedIds\(\(prev\)\s*=>/);
      expect(source).toMatch(/visibleIdSet\.has\(id\)/);
    });

    it("Escape with selection clears it instead of closing the modal", () => {
      expect(source).toMatch(
        /reason\s*===\s*"escape"\s*&&\s*hasSelection\)\s*\{[\s\S]*?clearSelection\(\)/
      );
    });

    it("scopes the two-stage clear-then-close guard to Escape by the palette's reason", () => {
      // A scrim click has to dismiss in one click with a selection active, so
      // the guard reads the reason the palette gives, never a key flag timed
      // against the dismissal (the flag's clearing raced the backstop).
      expect(source).toMatch(/\(reason\?:\s*PaletteCloseReason\)/);
      expect(source).not.toMatch(/markEscapeDismissal/);
    });

    it("Cmd/Ctrl+A triggers selectAllVisible", () => {
      expect(source).toMatch(/selectAllVisible\(\)/);
    });

    it("Cmd/Ctrl+A does not steal text-input Select-All", () => {
      // Editable check guards against hijacking Cmd+A in a text input.
      expect(source).toMatch(/isEditable/);
    });

    it("section headers render with role='presentation' inside the grid", () => {
      expect(source).toContain('role="presentation"');
    });

    it("resets the anchor on window blur to avoid stuck Shift from Cmd+Tab (#4591)", () => {
      expect(source).toMatch(/handleWindowBlur[\s\S]*?selectionAnchorRef\.current\s*=\s*null/);
    });

    it("does NOT set aria-rowcount on the grid (rows are not virtualized — spec says omit)", () => {
      // aria-rowcount is only meaningful when some rows aren't in the DOM.
      // For the overview grid every cell is rendered, so the attribute must
      // not be present — including it would announce the wrong row count
      // since each card maps to one ARIA row in this layout.
      expect(source).not.toContain("aria-rowcount");
    });

    it("passes sectionSizes to the keyboard hook so arrow navigation crosses section boundaries correctly", () => {
      // The hook needs section sizes to compute visually-adjacent cells
      // across col-[1/-1] header breaks; without it, ArrowDown miscounts
      // whenever a section ends on a partial row.
      expect(source).toMatch(/sectionSizes/);
      expect(source).toMatch(
        /sectionSizes\s*=\s*useMemo[\s\S]*?groupedSections\.map[\s\S]*?\.worktrees\.length/
      );
    });
  });

  describe("bulk action bar (#8655)", () => {
    let modalSource: string;

    beforeEach(async () => {
      modalSource = await fs.readFile(MODAL_PATH, "utf-8");
    });

    it("imports the bulk-remove hook so the modal owns the orchestrator state", () => {
      // Matches the named import wherever it sits in the specifier list. The
      // original pattern required `useWorktreeBulkRemove` to be the ONLY name
      // in the braces, which asserted the punctuation of an import statement
      // rather than the fact under test — adding a second export from the same
      // module broke it without changing any behaviour.
      expect(modalSource).toMatch(
        /import\s*\{[^}]*\buseWorktreeBulkRemove\b[^}]*\}\s*from\s*"\.\/useWorktreeBulkRemove"/
      );
    });

    it("imports ConfirmDialog for the D1 close-sessions and D3 remove gates", () => {
      expect(modalSource).toMatch(/from\s*"@\/components\/ui\/ConfirmDialog"/);
    });

    it("swaps the standard header for a contextual bar when hasSelection is true", () => {
      expect(modalSource).toMatch(/\{hasSelection\s*\?\s*\(/);
    });

    it("renders 'N selected' inside the contextual bar with aria-live for SR feedback", () => {
      expect(modalSource).toMatch(/aria-live="polite"[\s\S]{0,200}selectedIds\.size\s*}/);
    });

    it("exposes a Close sessions button wired to handleCloseSessionsClick", () => {
      expect(modalSource).toMatch(
        /data-testid="worktree-bulk-close-sessions"[\s\S]{0,400}|onClick=\{handleCloseSessionsClick\}/
      );
      expect(modalSource).toContain("Close sessions");
    });

    it("exposes a Remove worktrees button wired to the bulk-remove hook", () => {
      expect(modalSource).toMatch(/data-testid="worktree-bulk-remove"/);
      expect(modalSource).toMatch(/onClick=\{bulkRemove\.handleRemoveClick\}/);
    });

    it("uses variant='destructive' on the Remove button so the styling matches the D3 classification", () => {
      const removeButtonSlice = modalSource.slice(
        modalSource.indexOf("worktree-bulk-remove") - 200,
        modalSource.indexOf("worktree-bulk-remove") + 200
      );
      expect(removeButtonSlice).toMatch(/variant="destructive"/);
    });

    it("hands the whole hook to the extracted bulk-remove dialog", () => {
      // The confirm moved out of this 1,500-line modal when it grew a real
      // per-target preview (#12416). The modal still owns the hook; the D3
      // gate itself is contracted in `WorktreeBulkRemoveDialog.test.tsx`,
      // which asserts the rendered DOM rather than this file's source.
      expect(modalSource).toMatch(
        /import\s*\{[^}]*\bWorktreeBulkRemoveDialog\b[^}]*\}\s*from\s*"\.\/WorktreeBulkRemoveDialog"/
      );
      expect(modalSource).toMatch(/<WorktreeBulkRemoveDialog\s+bulkRemove=\{bulkRemove\}/);
    });

    it("keeps the D3 typed-count gate wired in the extracted dialog", async () => {
      const dialogSource = await fs.readFile(
        path.resolve(__dirname, "../WorktreeBulkRemoveDialog.tsx"),
        "utf-8"
      );
      expect(dialogSource).toMatch(/typedNameTarget=\{[^}]*bulkRemove\.typedNameTarget/);
      expect(dialogSource).toMatch(/variant="destructive"/);
    });

    it("renders a separate ConfirmDialog for the D1 close-sessions gate (variant='default')", () => {
      expect(modalSource).toMatch(/isCloseSessionsConfirmOpen/);
      expect(modalSource).toMatch(/handleCloseSessionsConfirm/);
    });

    it("snapshots the selection into a ref at click time so it survives reactive selectedIds drift (#4729)", () => {
      // handleCloseSessionsClick must freeze the selected ids before the
      // user has a chance to deselect/reselect mid-confirm. The handler
      // for confirm then iterates the ref, not the live closure.
      expect(modalSource).toMatch(/closeSessionsIdsRef\s*=\s*useRef/);
      // Click handler must materialize the live selection into a snapshot
      // (Array.from / new Set / .slice all work) before assigning to the ref.
      const clickHandlerMatch = modalSource.match(
        /handleCloseSessionsClick[\s\S]{0,400}?closeSessionsIdsRef\.current\s*=/
      );
      expect(clickHandlerMatch).not.toBeNull();
      expect(modalSource).toMatch(/Array\.from\(selectedIds\)/);
      // Confirm handler must iterate the snapshot, NOT the live selectedIds.
      expect(modalSource).toMatch(/for\s*\(const\s+id\s+of\s+closeSessionsIdsRef\.current\)/);
    });

    it("builds worktreeMap by id so the hook can snapshot targets at confirm-click time", () => {
      expect(modalSource).toMatch(/worktreeMap\s*=\s*useMemo/);
      expect(modalSource).toMatch(/map\.set\(w\.id,\s*w\)/);
    });

    it("passes selectedIds, worktreeMap, and clearSelection to useWorktreeBulkRemove", () => {
      expect(modalSource).toMatch(
        /useWorktreeBulkRemove\(\{\s*selectedIds,\s*worktreeMap,\s*clearSelection,?\s*\}\)/
      );
    });
  });
});
