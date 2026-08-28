import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";

const CELL_DOM_ID_PREFIX = "worktree-overview-cell-";

/**
 * Stable DOM id used by aria-activedescendant on every overview grid cell.
 *
 * Worktree ids are filesystem paths; on macOS especially these often contain
 * spaces, which produce invalid HTML `id` attributes (and break the
 * activeDescendant lookup downstream). encodeURIComponent normalizes the path
 * into an id-safe string while remaining a pure, deterministic function of
 * the worktree id so the same id resolves to the same DOM node every render.
 */
export function getWorktreeOverviewCellId(worktreeId: string): string {
  return `${CELL_DOM_ID_PREFIX}${encodeURIComponent(worktreeId)}`;
}

function parseColumnCount(template: string): number {
  const trimmed = template.trim();
  if (!trimmed || trimmed === "none") return 1;
  // gridTemplateColumns resolves to "200px 200px 200px" in Chromium when
  // computed — split on whitespace runs and count tracks.
  return Math.max(1, trimmed.split(/\s+/).length);
}

/**
 * Resolve the target index for ArrowUp/Down across section-aware layouts.
 *
 * When `sectionSizes` is provided, section breaks render as full-width
 * separators (CSS `col-[1/-1]`) that force a row break. A naive
 * `currentIndex ± columnCount` jump miscounts whenever a section ends on a
 * partial row, because the visually-adjacent cell in the next section is
 * not `columnCount` away in the flat ordering.
 *
 * Algorithm:
 *  - Locate which section contains `fromIndex` and the local row/column.
 *  - Try to stay in the same section: target row ± 1 at the same column.
 *  - If that row doesn't exist in the current section, fall through to the
 *    neighbouring section: target = first/last visual row at the same
 *    column (clamped to that section's actual width).
 *  - If no neighbour exists, return `fromIndex` (caller clamps).
 *
 * `delta` is +1 for ArrowDown, -1 for ArrowUp.
 */
/**
 * The first or last cell of the row `fromIndex` sits in.
 *
 * The WAI-ARIA grid pattern gives Home/End the CURRENT ROW and reserves the
 * whole grid for Control+Home / Control+End. This grid did the opposite: both
 * keys jumped to the flat extremes, so in a 13-card, 4-column grid the only
 * thing Home could do was what Control+Home should, and there was no way at
 * all to reach the end of the row you were on.
 *
 * Rows are section-local for the same reason vertical movement is: a section
 * break renders as a full-width separator, so it forces a row break that the
 * flat ordering does not encode. `End` on the last row of a short section
 * clamps to that section's last cell, not to a cell that visually sits on the
 * row below.
 *
 * `edge` is -1 for Home (row start) and +1 for End (row end).
 */
/** Elements the browser will actually give a Tab stop to, in DOM order. */
function tabbablesWithin(root: Element): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/**
 * Move focus to the tab stop immediately before or after the grid, skipping
 * everything inside it.
 *
 * The grid advertises itself as a single tab stop — that is the whole point of
 * `role="grid"` with `aria-activedescendant` — but the cards inside it are real
 * markup with real buttons, so an unassisted Tab walked into the first card's
 * "More actions" and then through seven to nine controls per card, thirteen
 * cards deep. The APG answer is a roving `tabIndex={-1}` on every descendant;
 * doing that would take the same controls off the keyboard in the SIDEBAR,
 * where they are the only path to them. Stepping over the grid from the
 * outside gets the same result for this surface and leaves the other alone,
 * and `F2` (below) is what reaches the controls deliberately.
 */
function focusPastGrid(grid: HTMLElement, backwards: boolean): boolean {
  const scope = grid.closest('[role="dialog"],[role="alertdialog"]') ?? document.body;
  const all = tabbablesWithin(scope);
  const outside = all.filter((el) => !grid.contains(el));
  if (outside.length === 0) return false;

  // The grid itself is a tab stop, so find where it sits among the others by
  // document position rather than by index in a list it may not be in.
  let next: HTMLElement | undefined;
  if (backwards) {
    for (const el of outside) {
      if (el.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING) next = el;
    }
    next ??= outside[outside.length - 1];
  } else {
    next = outside.find(
      (el) => el.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_PRECEDING
    );
    next ??= outside[0];
  }
  next?.focus();
  return next !== undefined;
}

export function computeRowExtreme(
  fromIndex: number,
  edge: 1 | -1,
  columnCount: number,
  total: number,
  sectionSizes: readonly number[] | undefined
): number {
  if (total <= 0 || fromIndex < 0 || fromIndex >= total) return fromIndex;
  if (columnCount <= 0) columnCount = 1;

  const sizes = sectionSizes && sectionSizes.length > 0 ? sectionSizes : [total];

  let sectionStart = 0;
  let sectionSize = 0;
  for (const size of sizes) {
    sectionSize = size ?? 0;
    if (fromIndex < sectionStart + sectionSize) break;
    sectionStart += sectionSize;
  }
  if (sectionSize === 0) return fromIndex;

  const localIdx = fromIndex - sectionStart;
  const rowStart = Math.floor(localIdx / columnCount) * columnCount;
  const local = edge === -1 ? rowStart : Math.min(rowStart + columnCount - 1, sectionSize - 1);
  return sectionStart + local;
}

export function computeVerticalMove(
  fromIndex: number,
  delta: 1 | -1,
  columnCount: number,
  total: number,
  sectionSizes: readonly number[] | undefined
): number {
  if (total <= 0 || fromIndex < 0 || fromIndex >= total) return fromIndex;
  if (columnCount <= 0) columnCount = 1;

  // No section grouping → single-section stride math.
  const sizes = sectionSizes && sectionSizes.length > 0 ? sectionSizes : [total];

  // Find which section owns fromIndex and the local offset within it.
  let sectionIdx = 0;
  let sectionStart = 0;
  for (; sectionIdx < sizes.length; sectionIdx++) {
    const size = sizes[sectionIdx] ?? 0;
    if (fromIndex < sectionStart + size) break;
    sectionStart += size;
  }
  const sectionSize = sizes[sectionIdx] ?? 0;
  if (sectionSize === 0) return fromIndex;
  const localIdx = fromIndex - sectionStart;
  const localRow = Math.floor(localIdx / columnCount);
  const localCol = localIdx % columnCount;

  // Try staying in the current section.
  const nextLocalRow = localRow + delta;
  if (nextLocalRow >= 0) {
    const nextLocal = nextLocalRow * columnCount + localCol;
    if (nextLocal < sectionSize) {
      return sectionStart + nextLocal;
    }
    // ArrowDown past last row of this section but the row exists past the
    // column boundary — fall through to the last cell of this section
    // before moving to the next section.
    if (delta === 1) {
      const lastLocal = sectionSize - 1;
      // Only step partway down if it's strictly below the current row;
      // otherwise let the cross-section branch handle it.
      const lastLocalRow = Math.floor(lastLocal / columnCount);
      if (lastLocalRow > localRow) {
        return sectionStart + lastLocal;
      }
    }
  }

  // Cross-section move.
  if (delta === 1) {
    const nextSectionIdx = sectionIdx + 1;
    if (nextSectionIdx >= sizes.length) return fromIndex;
    const nextSectionStart = sectionStart + sectionSize;
    const nextSectionSize = sizes[nextSectionIdx] ?? 0;
    if (nextSectionSize === 0) return fromIndex;
    const targetLocal = Math.min(localCol, nextSectionSize - 1);
    return nextSectionStart + targetLocal;
  }

  // ArrowUp — previous section's last visual row, same column where
  // available, otherwise the last cell of that section's final row.
  const prevSectionIdx = sectionIdx - 1;
  if (prevSectionIdx < 0) return fromIndex;
  let prevSectionStart = 0;
  for (let i = 0; i < prevSectionIdx; i++) prevSectionStart += sizes[i] ?? 0;
  const prevSectionSize = sizes[prevSectionIdx] ?? 0;
  if (prevSectionSize === 0) return fromIndex;
  const prevLastRow = Math.floor((prevSectionSize - 1) / columnCount);
  const candidateLocal = prevLastRow * columnCount + localCol;
  if (candidateLocal < prevSectionSize) {
    return prevSectionStart + candidateLocal;
  }
  // Column has no cell in that visual row (partial-tail row) — clamp to
  // last cell of the previous section.
  return prevSectionStart + prevSectionSize - 1;
}

export interface UseWorktreeOverviewKeyboardOptions {
  /** Ordered list of worktree ids visible in the current filter set. */
  worktreeIds: readonly string[];
  /**
   * Sizes of visual section blocks in order, summing to worktreeIds.length.
   * Each entry is the number of cards in one grouped section. When omitted
   * the list is treated as a single section. Section headers force a CSS
   * row break (col-[1/-1]), so naive flat-index stride math (idx ± columns)
   * skips into the wrong column whenever a section ends on a partial row.
   * Passing sizes lets the hook resolve ArrowUp/Down to the visually
   * adjacent cell instead.
   */
  sectionSizes?: readonly number[];
  /** The grid container element that carries the role="grid" + tabIndex. */
  gridRef: React.RefObject<HTMLDivElement | null>;
  /**
   * Anchor for contiguous range selection. The parent owns this ref so the
   * anchor persists across keyboard navigation but survives filter changes
   * (lesson #4729 — don't reset on filtered-set churn).
   */
  selectionAnchorRef: React.MutableRefObject<string | null>;
  onActivate: (worktreeId: string) => void;
  onToggleSelection: (worktreeId: string) => void;
  onSelectRange: (anchorId: string, targetId: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  /** Called when Escape is pressed with no selection — modal close. */
  onEscapeWithoutSelection: () => void;
  /**
   * Hand keyboard control back to the search field: ArrowUp off the top row,
   * `/`, or any printable character typed while the grid has focus.
   *
   * The last of those is the one that matters most on a surface whose search
   * field takes initial focus. Without it, a user who arrows into the results,
   * does not find what they wanted and starts typing a new query gets nothing
   * — the keystrokes land on a grid that has no use for them. `char` is the
   * character to append, or undefined for a bare refocus.
   */
  onReturnToSearch?: (char?: string) => void;
  /** True if anything is currently selected; gates Escape's two-stage close. */
  hasSelection: boolean;
}

export interface UseWorktreeOverviewKeyboardReturn {
  activeWorktreeId: string | null;
  activeDescendantId: string | undefined;
  handleGridKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  handleGridFocus: (e: React.FocusEvent<HTMLDivElement>) => void;
  setActiveWorktreeId: (id: string | null) => void;
}

/**
 * 2D keyboard navigation + selection substrate for the worktree overview grid.
 *
 * Built parallel to {@link useWorktreeSidebarKeyboard}: one tab stop on the
 * grid container, aria-activedescendant points at the focused cell, all
 * keystrokes are intercepted at the container level so we never fight focus
 * with the card's internal buttons. Arrow keys move in a 2D grid whose column
 * count is sampled from `getComputedStyle().gridTemplateColumns` (refreshed
 * via `ResizeObserver`). Selection and range operations are routed to the
 * parent via callbacks — selection state itself is owned by the modal so it
 * resets naturally when the modal unmounts.
 *
 * The hook deliberately holds no store dependencies (lesson
 * `feedback_throwing_context_hooks_break_isolated_tests`) — it is testable
 * standalone in jsdom without provider scaffolding.
 */
export function useWorktreeOverviewKeyboard({
  worktreeIds,
  sectionSizes,
  gridRef,
  selectionAnchorRef,
  onActivate,
  onToggleSelection,
  onSelectRange,
  onSelectAll,
  onClearSelection,
  onEscapeWithoutSelection,
  onReturnToSearch,
  hasSelection,
}: UseWorktreeOverviewKeyboardOptions): UseWorktreeOverviewKeyboardReturn {
  const [activeWorktreeId, setActiveWorktreeId] = useState<string | null>(null);
  // Column count is read inside event handlers only — keeping it in a ref
  // avoids a re-render every ResizeObserver tick.
  const columnCountRef = useRef<number>(1);
  // Mirror callbacks so listener identity doesn't churn the grid container.
  const callbacksRef = useRef({
    onActivate,
    onToggleSelection,
    onSelectRange,
    onSelectAll,
    onClearSelection,
    onEscapeWithoutSelection,
    onReturnToSearch,
  });
  useEffect(() => {
    callbacksRef.current = {
      onActivate,
      onToggleSelection,
      onSelectRange,
      onSelectAll,
      onClearSelection,
      onEscapeWithoutSelection,
      onReturnToSearch,
    };
  });
  const worktreeIdsRef = useRef(worktreeIds);
  useEffect(() => {
    worktreeIdsRef.current = worktreeIds;
  });
  const sectionSizesRef = useRef(sectionSizes);
  useEffect(() => {
    sectionSizesRef.current = sectionSizes;
  });
  const hasSelectionRef = useRef(hasSelection);
  useEffect(() => {
    hasSelectionRef.current = hasSelection;
  });

  // Clamp active id back into the visible set when it shrinks. Without this,
  // a filter change or worktree removal would orphan aria-activedescendant.
  useEffect(() => {
    if (activeWorktreeId === null) return;
    if (worktreeIds.includes(activeWorktreeId)) return;
    setActiveWorktreeId(worktreeIds[0] ?? null);
  }, [worktreeIds, activeWorktreeId]);

  // Track column count from the live grid layout. `getComputedStyle` on the
  // grid container returns resolved track sizes (e.g. "320px 320px 320px"),
  // which is exactly the count we need for ArrowUp/Down stride math.
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || typeof ResizeObserver === "undefined") return;
    const refresh = () => {
      const template = window.getComputedStyle(grid).gridTemplateColumns;
      columnCountRef.current = parseColumnCount(template);
    };
    refresh();
    const observer = new ResizeObserver(refresh);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [gridRef]);

  const activeDescendantId = activeWorktreeId
    ? getWorktreeOverviewCellId(activeWorktreeId)
    : undefined;

  const handleGridFocus = useCallback(
    (_e: React.FocusEvent<HTMLDivElement>) => {
      if (activeWorktreeId !== null) return;
      const first = worktreeIdsRef.current[0];
      if (first) setActiveWorktreeId(first);
    },
    [activeWorktreeId]
  );

  const handleGridKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const gridEl = gridRef.current;
      const ids = worktreeIdsRef.current;
      const callbacks = callbacksRef.current;

      // Focus is INSIDE a card (the user pressed F2 to get there). The only
      // key this handler owns in that state is the way back out: Escape
      // returns focus to the grid container rather than clearing the
      // selection or closing the modal, both of which would be a surprising
      // amount of work for a key the user pressed to leave a button.
      const target = e.target instanceof Node ? e.target : null;
      if (gridEl && target !== null && target !== gridEl && gridEl.contains(target)) {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          gridEl.focus();
        }
        return;
      }

      // Only process events that originated on the grid container itself.
      // Keys typed in an inner card button (terminal action, menu trigger)
      // would otherwise bubble here and re-trigger selection from the
      // grid's perspective — Space on an inner button would both click
      // the button AND toggle the gridcell selection.
      if (e.target !== gridEl) return;

      // Tab steps over the grid's contents, not through them. See
      // `focusPastGrid`.
      if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (gridEl && focusPastGrid(gridEl, e.shiftKey)) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }

      // Back to the search field. Three ways in, all of them conventions this
      // surface's neighbours already use: `/` (GitHub, Gmail, Linear), and any
      // printable character, which types into the field rather than being
      // swallowed. ArrowUp off the top row is handled with the other arrows,
      // where the row geometry is already known.
      if (callbacks.onReturnToSearch) {
        if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          e.stopPropagation();
          callbacks.onReturnToSearch();
          return;
        }
        // A single printable character, not a chord and not a named key.
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && e.key !== " ") {
          e.preventDefault();
          e.stopPropagation();
          callbacks.onReturnToSearch(e.key);
          return;
        }
      }

      // Ctrl/Cmd+A — select all in the current filtered set.
      const isCmdOrCtrl = e.metaKey || e.ctrlKey;
      if (isCmdOrCtrl && (e.key === "a" || e.key === "A")) {
        if (ids.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        // Anchor at the first visible item so a subsequent Shift+Click reads
        // as "extend from the start of the current view."
        selectionAnchorRef.current = ids[0] ?? null;
        callbacks.onSelectAll();
        return;
      }

      // Escape — clear selection first, then propagate to modal close.
      if (e.key === "Escape") {
        if (hasSelectionRef.current) {
          e.preventDefault();
          e.stopPropagation();
          selectionAnchorRef.current = null;
          callbacks.onClearSelection();
          return;
        }
        // No selection — let the modal-level handler close the dialog.
        callbacks.onEscapeWithoutSelection();
        return;
      }

      if (ids.length === 0) return;

      // Lazily establish the active cell so first-keypress navigation starts
      // at index 0 instead of doing nothing.
      let currentIndex = activeWorktreeId ? ids.indexOf(activeWorktreeId) : -1;
      if (currentIndex === -1) {
        currentIndex = 0;
        setActiveWorktreeId(ids[0] ?? null);
      }
      const currentId = ids[currentIndex];
      if (currentId === undefined) return;

      const columnCount = columnCountRef.current;
      const total = ids.length;
      let targetIndex: number | null = null;

      switch (e.key) {
        case "ArrowRight":
          targetIndex = Math.min(total - 1, currentIndex + 1);
          break;
        case "ArrowLeft":
          targetIndex = Math.max(0, currentIndex - 1);
          break;
        case "ArrowDown":
          targetIndex = computeVerticalMove(
            currentIndex,
            1,
            columnCount,
            total,
            sectionSizesRef.current
          );
          break;
        case "ArrowUp": {
          const up = computeVerticalMove(
            currentIndex,
            -1,
            columnCount,
            total,
            sectionSizesRef.current
          );
          // Already on the top row — `computeVerticalMove` returns the input
          // when there is nowhere above. The field is what is above, so go
          // there rather than absorbing the keypress. It mirrors ArrowDown
          // out of the field, so the pair is reversible.
          if (up === currentIndex && !e.shiftKey && callbacks.onReturnToSearch) {
            e.preventDefault();
            e.stopPropagation();
            callbacks.onReturnToSearch();
            return;
          }
          targetIndex = up;
          break;
        }
        case "Home":
          targetIndex = isCmdOrCtrl
            ? 0
            : computeRowExtreme(currentIndex, -1, columnCount, total, sectionSizesRef.current);
          break;
        case "End":
          targetIndex = isCmdOrCtrl
            ? total - 1
            : computeRowExtreme(currentIndex, 1, columnCount, total, sectionSizesRef.current);
          break;
        case "PageDown": {
          const stride = Math.max(1, columnCount * 3);
          targetIndex = Math.min(total - 1, currentIndex + stride);
          break;
        }
        case "PageUp": {
          const stride = Math.max(1, columnCount * 3);
          targetIndex = Math.max(0, currentIndex - stride);
          break;
        }
        case " ":
        case "Spacebar": {
          e.preventDefault();
          e.stopPropagation();
          selectionAnchorRef.current = currentId;
          callbacks.onToggleSelection(currentId);
          return;
        }
        case "Enter": {
          e.preventDefault();
          e.stopPropagation();
          callbacks.onActivate(currentId);
          return;
        }
        case "F2": {
          // The APG grid pattern's "enter the cell": move into the focused
          // card's own controls. Enter is spent on switching to the worktree
          // here — that is this surface's primary verb — so F2 is the only
          // key left for it, and it is the one the pattern names anyway.
          // Escape (above) is the way back.
          // `getElementById`, not `querySelector("#id")`: the latter needs
          // `CSS.escape` for ids that are not bare identifiers, and `CSS` is
          // not defined in every environment this hook is exercised in.
          const cellId = getWorktreeOverviewCellId(currentId);
          const found = document.getElementById(cellId);
          const cell = found && gridRef.current?.contains(found) ? found : null;
          const first = cell ? tabbablesWithin(cell)[0] : undefined;
          if (first) {
            e.preventDefault();
            e.stopPropagation();
            first.focus();
          }
          return;
        }
      }

      if (targetIndex === null) return;
      e.preventDefault();
      e.stopPropagation();
      const targetId = ids[targetIndex];
      if (targetId === undefined) return;

      // Shift+Arrow extends selection from the persistent anchor; pure arrow
      // movement just moves focus without touching selection. The anchor is
      // set when the user makes their first deliberate selection action
      // (Space, click, Ctrl/Cmd+A) — Shift+Arrow without a prior anchor, OR
      // with an anchor that no longer points at a visible cell (filter
      // narrowed it away), bootstraps from the current cell so the range
      // has a stable origin.
      if (e.shiftKey && targetIndex !== currentIndex) {
        const storedAnchor = selectionAnchorRef.current;
        const anchorVisible = storedAnchor !== null && ids.indexOf(storedAnchor) !== -1;
        if (!anchorVisible) {
          selectionAnchorRef.current = currentId;
        }
        callbacks.onSelectRange(selectionAnchorRef.current!, targetId);
      }

      if (targetIndex !== currentIndex) {
        setActiveWorktreeId(targetId);
      }
    },
    [activeWorktreeId, selectionAnchorRef, gridRef]
  );

  return {
    activeWorktreeId,
    activeDescendantId,
    handleGridKeyDown,
    handleGridFocus,
    setActiveWorktreeId,
  };
}
