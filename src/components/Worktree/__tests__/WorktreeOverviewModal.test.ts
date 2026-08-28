// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const MODAL_PATH = path.resolve(__dirname, "../WorktreeOverviewModal.tsx");

describe("WorktreeOverviewModal — clickable aggregate stats (#8385)", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(MODAL_PATH, "utf-8");
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
        /const\s*\{\s*filteredWorktrees,\s*groupedSections\s*\}\s*=\s*useMemo[\s\S]*?\]\s*\);/
      );
      expect(depArrayMatch).not.toBeNull();
      expect(depArrayMatch![0]).toContain("quickStateFilter");
    });

    it("gates alwaysShowActive bypass on quickStateFilter === 'all'", () => {
      expect(source).toMatch(
        /alwaysShowActive\s*&&\s*isActive\s*&&\s*!hasActiveQuery\s*&&\s*quickStateFilter\s*===\s*"all"/
      );
    });

    it("gates alwaysShowWaiting bypass on quickStateFilter === 'all'", () => {
      expect(source).toMatch(
        /alwaysShowWaiting\s*&&\s*derived\.hasWaitingAgent\s*&&\s*!hasActiveQuery\s*&&\s*quickStateFilter\s*===\s*"all"/
      );
    });
  });

  describe("aggregate stats chips", () => {
    // Slice from the aggregate stats section to isolate assertions
    function statsSlice(src: string): string {
      const start = src.indexOf("Aggregate activity statistics");
      // Find the closing of that div
      let depth = 0;
      let i = start;
      let found = false;
      for (; i < src.length; i++) {
        if (src.slice(i, i + 4) === "<div") {
          depth++;
        } else if (src.slice(i, i + 6) === "</div>") {
          depth--;
          if (depth === 0 && found) break;
        }
        if (depth > 0 && !found) found = true;
      }
      return src.slice(start, i + 6);
    }

    it("uses button elements instead of span elements for the stat chips", () => {
      const stats = statsSlice(source);
      // The chips are now <button> elements
      const buttonCount = (stats.match(/<button/g) ?? []).length;
      expect(buttonCount).toBeGreaterThanOrEqual(1);
      // No <span> elements wrapping the chip content (pulse dot spans are fine)
      const spanOpenTags = stats.match(/<span/g) ?? [];
      // There should be span elements for the dot and text, but not the chip wrapper
      expect(spanOpenTags.length).toBeGreaterThan(0);
    });

    it("sets aria-pressed based on quickStateFilter for working chip", () => {
      expect(source).toMatch(/aria-pressed=\{quickStateFilter\s*===\s*"working"\}/);
    });

    it("sets aria-pressed based on quickStateFilter for waiting chip", () => {
      expect(source).toMatch(/aria-pressed=\{quickStateFilter\s*===\s*"waiting"\}/);
    });

    it("working chip onClick toggles between 'working' and 'all'", () => {
      expect(source).toMatch(
        /setQuickStateFilter\(quickStateFilter\s*===\s*"working"\s*\?\s*"all"\s*:\s*"working"\)/
      );
    });

    it("waiting chip onClick toggles between 'waiting' and 'all'", () => {
      expect(source).toMatch(
        /setQuickStateFilter\(quickStateFilter\s*===\s*"waiting"\s*\?\s*"all"\s*:\s*"waiting"\)/
      );
    });

    it("uses transition-colors on chip buttons (not transition-all)", () => {
      const stats = statsSlice(source);
      expect(stats).toContain("transition-colors");
      expect(stats).not.toContain("transition-all");
    });

    it("applies active styling with bg-overlay-subtle when chip is active", () => {
      expect(source).toContain("bg-overlay-subtle");
      expect(source).toContain("shadow-[inset_0_-2px_0_0_var(--color-text-secondary)]");
    });

    it("applies hover background on inactive chips", () => {
      expect(source).toContain("hover:bg-tint/[0.04]");
    });

    it("uses focus-visible:outline-hidden with ring for focus styling", () => {
      const stats = statsSlice(source);
      expect(stats).toContain("focus-visible:outline-hidden");
      expect(stats).toContain("focus-visible:ring-2");
      expect(stats).toContain("focus-visible:ring-accent-primary");
    });

    it("wrapper uses role='group' instead of role='status'", () => {
      // The wrapper div now contains interactive controls; role="group" is appropriate
      const stats = statsSlice(source);
      expect(stats).toContain('role="group"');
      expect(stats).not.toContain('role="status"');
    });

    it("wrapper aria-label describes filter action", () => {
      expect(source).toContain("Filter by agent state");
    });

    it("keeps pulse dot and count text in working chip", () => {
      expect(source).toContain("motion-safe:animate-pulse");
      expect(source).toMatch(/\baggregateStats\.workingCount\b/);
    });

    it("keeps count text in waiting chip", () => {
      expect(source).toMatch(/\baggregateStats\.waitingCount\b/);
    });
  });

  describe("aggregateStats computation (unchanged)", () => {
    it("still computes workingCount and waitingCount from raw worktrees", () => {
      expect(source).toMatch(/workingCount\+\+/);
      expect(source).toMatch(/waitingCount\+\+/);
    });

    it("still respects hideMainWorktree", () => {
      expect(source).toMatch(/hideMainWorktree\s*&&\s*worktree\.isMainWorktree/);
    });
  });

  describe("finished chip (#9607)", () => {
    it("computes finishedCount in the aggregateStats loop", () => {
      expect(source).toMatch(/finishedCount\+\+/);
      expect(source).toMatch(/return\s*\{\s*workingCount,\s*waitingCount,\s*finishedCount\s*\}/);
    });

    it("derives finishedCount from chipState (mirrors matchesQuickStateFilter), not terminal flags", () => {
      // Must match the filter's source of truth so the count and filter stay in sync.
      expect(source).toMatch(
        /derived\.chipState\s*===\s*"complete"\s*\|\|\s*derived\.chipState\s*===\s*"cleanup"\)\s*finishedCount\+\+/
      );
    });

    it("includes finishedCount in the chip-row visibility gate", () => {
      expect(source).toMatch(/aggregateStats\.finishedCount\s*>\s*0/);
    });

    it("sets aria-pressed based on quickStateFilter for finished chip", () => {
      expect(source).toMatch(/aria-pressed=\{quickStateFilter\s*===\s*"finished"\}/);
    });

    it("finished chip onClick toggles between 'finished' and 'all'", () => {
      expect(source).toMatch(
        /setQuickStateFilter\(quickStateFilter\s*===\s*"finished"\s*\?\s*"all"\s*:\s*"finished"\)/
      );
    });

    // Slice tightly around the finished chip's button so assertions can't be
    // satisfied by the working/waiting buttons that share the same group div.
    function finishedChipSlice(src: string): string {
      const start = src.indexOf('aria-pressed={quickStateFilter === "finished"}');
      return src.slice(start, src.indexOf("} finished", start));
    }

    it("reuses the shared neutral selected styling (bg-overlay-subtle underline) on the finished chip", () => {
      const chip = finishedChipSlice(source);
      expect(chip).toContain("bg-overlay-subtle");
      expect(chip).toContain("shadow-[inset_0_-2px_0_0_var(--color-text-secondary)]");
    });

    it("uses a semantic category-blue dot for finished, matching the WorktreeCard complete chip", () => {
      const chip = finishedChipSlice(source);
      expect(chip).toContain("bg-category-blue");
    });

    it("uses neutral (non-state-colored) text on the finished chip label", () => {
      const chip = finishedChipSlice(source);
      // Label text is neutral; only the dot carries semantic color.
      expect(chip).toMatch(/quickStateFilter === "finished"\s*\?\s*"text-text-primary"/);
      expect(chip).not.toContain("text-status-warning");
      expect(chip).not.toContain("text-[var(--color-state-working)]");
      expect(chip).not.toContain("text-accent-primary");
    });

    it("renders the finished count text", () => {
      expect(source).toMatch(/\baggregateStats\.finishedCount\b/);
    });
  });

  describe("neutral chip labels (#9607)", () => {
    // The working/waiting chips previously wrapped their whole label in a
    // per-state color, a one-off treatment. Labels are now neutral; only the
    // dot keeps semantic color (mirrors the sidebar QuickStateFilterBar).
    it("working chip label is neutral, not state-colored", () => {
      const start = source.indexOf('aria-pressed={quickStateFilter === "working"}');
      const chip = source.slice(start, source.indexOf("} working", start));
      expect(chip).toMatch(/quickStateFilter === "working"\s*\?\s*"text-text-primary"/);
      expect(chip).not.toContain("text-[var(--color-state-working)]");
      // The dot keeps its semantic state color.
      expect(chip).toContain("bg-[var(--color-state-working)]");
    });

    it("waiting chip label is neutral, not state-colored", () => {
      const start = source.indexOf('aria-pressed={quickStateFilter === "waiting"}');
      const chip = source.slice(start, source.indexOf("} waiting", start));
      expect(chip).toMatch(/quickStateFilter === "waiting"\s*\?\s*"text-text-primary"/);
      expect(chip).not.toContain("text-status-warning");
      // The dot keeps its semantic color.
      expect(chip).toContain("bg-status-warning");
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

    it("renders cells with role='gridcell' and aria-selected", () => {
      expect(source).toContain('role="gridcell"');
      expect(source).toMatch(/aria-selected=\{isSelected\}/);
    });

    it("passes isSelected as boolean (not the Set) to each cell", () => {
      // Avoid #4749 — never pass the Set or an index down; only the boolean
      // result of `.has()` so memoization narrows re-renders to changed cells.
      expect(source).toMatch(/isSelected=\{selectedIds\.has\(worktree\.id\)\}/);
    });

    it("marks membership with a neutral fill plus a contrast-gated neutral ring", () => {
      // The rule, not the token: membership is NEUTRAL (accent belongs to the
      // cursor alone in this arrow-key domain), and because the fill step
      // between a selected and an unselected cell is a couple of percent —
      // nowhere near SC 1.4.11's 3:1 — the ring has to be the actual non-text
      // indicator. `selection-outline` is the one ink `getThemeContrastWarnings`
      // gates at 3:1 on every theme, which is why it and not a border token.
      const selection = source.match(/isSelected\s*&&\s*"([^"]+)"/)?.[1];
      expect(selection, "no isSelected treatment found on the grid cell").toBeTruthy();
      expect(selection).toMatch(/\bbg-overlay-\w+/);
      expect(selection).toContain("ring-selection-outline");
      expect(selection).not.toMatch(/accent/);
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
        /escapeDismissRef\.current\s*&&\s*hasSelection\)\s*\{[\s\S]*?clearSelection\(\)/
      );
    });

    it("scopes the two-stage clear-then-close guard to Escape", () => {
      // AppDialog routes the close button and a scrim click through
      // `onBeforeClose` as well, and both have to dismiss in one click with a
      // selection active — so the guard reads a flag set only by an Escape
      // keypress, recorded in capture phase ahead of the bubble-phase escape
      // stack.
      expect(source).toMatch(/"keydown",\s*markEscapeDismissal,\s*true\)/);
      expect(source).toMatch(/e\.key\s*!==\s*"Escape"/);
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

    it("section headers span the full grid width via col-[1/-1]", () => {
      expect(source).toContain("col-[1/-1]");
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

    it("renders a ConfirmDialog with typedNameTarget for the D3 bulk remove gate", () => {
      expect(modalSource).toMatch(/typedNameTarget=\{bulkRemove\.typedNameTarget\}/);
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
