import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type React from "react";
import type { VirtuosoHandle } from "react-virtuoso";

export type SidebarRowItemRef = {
  kind: "row";
  worktreeId: string;
  /**
   * Pinned rows — currently just the main worktree — live outside the
   * virtualized list; they're always mounted, so navigating to one must
   * NOT call `virtuosoRef.scrollToIndex`.
   */
  isPinned?: boolean;
};
export type SidebarHeaderItemRef = { kind: "header" };
export type SidebarKeyboardItem = SidebarRowItemRef | SidebarHeaderItemRef;

type GridMode = "list" | "toolbar";

const TOOLBAR_SELECTOR = "[data-worktree-row-toolbar]";
const TOOLBAR_ITEM_SELECTOR =
  "button:not(:disabled), [role='button']:not([aria-disabled='true']), [tabindex]:not([tabindex='-1'])";

const ROW_DOM_ID_PREFIX = "worktree-sidebar-row-";

/**
 * Stable DOM id used by aria-activedescendant on every worktree row wrapper.
 *
 * Worktree ids are filesystem paths; on macOS especially these often contain
 * spaces, which produce invalid HTML `id` attributes (and break the
 * activeDescendant lookup downstream). encodeURIComponent normalizes the path
 * into an id-safe string while remaining a pure, deterministic function of
 * the worktree id so the same id resolves to the same DOM node every render.
 */
export function getWorktreeSidebarRowId(worktreeId: string): string {
  return `${ROW_DOM_ID_PREFIX}${encodeURIComponent(worktreeId)}`;
}

function isElementVisible(el: HTMLElement): boolean {
  return el.offsetParent !== null || el.getClientRects().length > 0;
}

const PAGE_SIZE_FALLBACK = 10;
const ESTIMATED_ROW_HEIGHT_PX = 180;

function computePageSize(scroller: HTMLElement | null | undefined): number {
  if (!scroller) return PAGE_SIZE_FALLBACK;
  const viewportHeight = scroller.clientHeight;
  if (viewportHeight <= 0) return PAGE_SIZE_FALLBACK;
  return Math.max(1, Math.floor(viewportHeight / ESTIMATED_ROW_HEIGHT_PX));
}

export interface UseWorktreeSidebarKeyboardOptions {
  items: readonly SidebarKeyboardItem[];
  virtuosoRef: React.RefObject<VirtuosoHandle | null>;
  scrollerRef: React.RefObject<HTMLElement | null>;
  onKeyboardReorder?: (worktreeId: string, delta: -1 | 1) => void;
  onSelectWorktree?: (worktreeId: string) => void;
}

export interface UseWorktreeSidebarKeyboardReturn {
  gridRef: React.RefObject<HTMLDivElement | null>;
  activeDescendantId: string | undefined;
  /**
   * Worktree id the keyboard navigation cursor currently points at, or null.
   *
   * The grid uses aria-activedescendant, so rows never take real DOM focus and
   * `:focus-visible` never fires for arrow-key navigation. Rows consume this id
   * to render a visible cursor ring on the active row. Null in toolbar mode
   * (focus has moved into a real DOM button, which carries its own focus ring).
   */
  keyboardCursorId: string | null;
  handleGridKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  handleGridFocus: (e: React.FocusEvent<HTMLDivElement>) => void;
  handleGridFocusCapture: (e: React.FocusEvent<HTMLDivElement>) => void;
}

/**
 * Keyboard model for the virtualized worktree sidebar.
 *
 * The sidebar uses aria-activedescendant in list mode so off-screen rows never
 * need DOM presence to participate in navigation. The grid container holds the
 * single tab stop and tracks the active row via state. When the user enters a
 * row's action toolbar (Enter / ArrowRight), focus moves into the real DOM
 * toolbar buttons (the active row is always within Virtuoso's overscan when
 * this fires, so the toolbar is mounted) and tabIndex mutation handles the
 * toolbar's roving tab stop. Escape returns to list mode.
 */
export function useWorktreeSidebarKeyboard({
  items,
  virtuosoRef,
  scrollerRef,
  onKeyboardReorder,
  onSelectWorktree,
}: UseWorktreeSidebarKeyboardOptions): UseWorktreeSidebarKeyboardReturn {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const modeRef = useRef<GridMode>("list");
  // Mirror mode in state so render can read it (the ref stays for synchronous
  // reads inside event handlers, where state would be stale within the tick).
  const [mode, setMode] = useState<GridMode>("list");
  const activeToolbarIndexRef = useRef<number>(0);
  const [activeWorktreeId, setActiveWorktreeId] = useState<string | null>(null);

  const setGridMode = useCallback((next: GridMode) => {
    modeRef.current = next;
    setMode(next);
  }, []);

  // Stash callbacks in refs so changing identity doesn't churn the
  // keydown/focus handlers (which would force the grid container to re-bind
  // listeners every render).
  const itemsRef = useRef(items);
  const onKeyboardReorderRef = useRef(onKeyboardReorder);
  const onSelectWorktreeRef = useRef(onSelectWorktree);
  useEffect(() => {
    itemsRef.current = items;
    onKeyboardReorderRef.current = onKeyboardReorder;
    onSelectWorktreeRef.current = onSelectWorktree;
  });

  // Clamp the active worktree to one that still exists in the current items
  // list. Without this, filter or removal events would orphan the
  // aria-activedescendant id (pointing at a row that no longer renders).
  useEffect(() => {
    if (activeWorktreeId === null) return;
    const stillVisible = items.some(
      (item) => item.kind === "row" && item.worktreeId === activeWorktreeId
    );
    if (stillVisible) return;
    const firstRow = items.find((item): item is SidebarRowItemRef => item.kind === "row");
    setActiveWorktreeId(firstRow?.worktreeId ?? null);
  }, [items, activeWorktreeId]);

  const findRowFlatIndex = useCallback((worktreeId: string): number => {
    return itemsRef.current.findIndex(
      (item) => item.kind === "row" && item.worktreeId === worktreeId
    );
  }, []);

  const getActiveRowFlatIndex = useCallback((): number => {
    if (activeWorktreeId === null) return -1;
    return findRowFlatIndex(activeWorktreeId);
  }, [activeWorktreeId, findRowFlatIndex]);

  // Walk items forward/back from the given flat index, skipping headers,
  // returning the first row item index encountered (or null at boundary).
  const advance = useCallback((fromFlatIndex: number, delta: 1 | -1): number | null => {
    const items = itemsRef.current;
    let idx = fromFlatIndex + delta;
    while (idx >= 0 && idx < items.length) {
      if (items[idx]!.kind === "row") return idx;
      idx += delta;
    }
    return null;
  }, []);

  const firstRowFlatIndex = useCallback((): number | null => {
    const items = itemsRef.current;
    for (let i = 0; i < items.length; i++) {
      if (items[i]!.kind === "row") return i;
    }
    return null;
  }, []);

  const lastRowFlatIndex = useCallback((): number | null => {
    const items = itemsRef.current;
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i]!.kind === "row") return i;
    }
    return null;
  }, []);

  const navigateTo = useCallback(
    (flatIndex: number) => {
      const items = itemsRef.current;
      const item = items[flatIndex];
      if (!item || item.kind !== "row") return;
      setActiveWorktreeId(item.worktreeId);
      // Pinned rows are rendered outside the Virtuoso surface — skip
      // scrollToIndex (it'd point at the wrong row), and don't even compute
      // a Virtuoso index for them. They're always in the DOM, so the
      // browser will scroll the role="grid" container into view if needed.
      if (item.isPinned) return;
      // The flat items list interleaves pinned rows ahead of the virtualized
      // items. Subtract the count of preceding pinned rows so scrollToIndex
      // targets the right Virtuoso row.
      let pinnedBefore = 0;
      for (let i = 0; i < flatIndex; i++) {
        const prior = items[i];
        if (prior?.kind === "row" && prior.isPinned) pinnedBefore++;
      }
      virtuosoRef.current?.scrollToIndex({
        index: flatIndex - pinnedBefore,
        align: "center",
        behavior: "auto",
      });
    },
    [virtuosoRef]
  );

  const findRowEl = useCallback((worktreeId: string): HTMLElement | null => {
    const grid = gridRef.current;
    if (!grid) return null;
    // Scan rather than build a selector — `CSS.escape` isn't available in
    // jsdom, and worktree ids are user-supplied (branch names) so a naive
    // attribute selector would break on quotes/escapes.
    const rows = grid.querySelectorAll<HTMLElement>("[data-worktree-row]");
    for (const row of rows) {
      if (row.dataset.worktreeRow === worktreeId) return row;
    }
    return null;
  }, []);

  const getToolbarItemsForRow = useCallback((row: HTMLElement): HTMLElement[] => {
    const toolbar = row.querySelector<HTMLElement>(TOOLBAR_SELECTOR);
    if (!toolbar) return [];
    return Array.from(toolbar.querySelectorAll<HTMLElement>(TOOLBAR_ITEM_SELECTOR)).filter(
      isElementVisible
    );
  }, []);

  const syncToolbarTabStops = useCallback((toolbarItems: HTMLElement[], activeIdx: number) => {
    for (const el of toolbarItems) el.tabIndex = -1;
    if (toolbarItems[activeIdx]) toolbarItems[activeIdx].tabIndex = 0;
  }, []);

  const clearToolbarTabStops = useCallback(
    (worktreeId: string) => {
      const row = findRowEl(worktreeId);
      if (!row) return;
      const items = getToolbarItemsForRow(row);
      for (const el of items) el.tabIndex = -1;
    },
    [findRowEl, getToolbarItemsForRow]
  );

  const enterListMode = useCallback(
    (worktreeId: string | null) => {
      const previous = activeWorktreeId;
      if (modeRef.current === "toolbar" && previous) {
        clearToolbarTabStops(previous);
      }
      setGridMode("list");
      if (worktreeId !== null) setActiveWorktreeId(worktreeId);
      // Restore focus to the grid container so aria-activedescendant takes effect.
      gridRef.current?.focus();
    },
    [activeWorktreeId, clearToolbarTabStops, setGridMode]
  );

  const enterToolbarMode = useCallback(
    (worktreeId: string): boolean => {
      const row = findRowEl(worktreeId);
      if (!row) return false;
      const toolbarItems = getToolbarItemsForRow(row);
      if (toolbarItems.length === 0) return false;
      setGridMode("toolbar");
      activeToolbarIndexRef.current = 0;
      syncToolbarTabStops(toolbarItems, 0);
      toolbarItems[0]!.focus();
      return true;
    },
    [findRowEl, getToolbarItemsForRow, setGridMode, syncToolbarTabStops]
  );

  const selectRow = useCallback((worktreeId: string, e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onSelectWorktreeRef.current?.(worktreeId);
  }, []);

  // Reset to list mode when the window loses focus so re-entering the grid
  // always starts on a row, never inside a toolbar. Mirrors lesson #4591.
  useEffect(() => {
    const handleBlur = () => {
      if (modeRef.current !== "toolbar") return;
      setGridMode("list");
      if (activeWorktreeId !== null) clearToolbarTabStops(activeWorktreeId);
    };
    window.addEventListener("blur", handleBlur);
    return () => window.removeEventListener("blur", handleBlur);
  }, [activeWorktreeId, clearToolbarTabStops, setGridMode]);

  // Re-sync the active toolbar tabIndex after every render so a re-mount of
  // the active row (Virtuoso scrolling it into overscan) doesn't strand the
  // user without a tab stop inside the toolbar.
  useLayoutEffect(() => {
    if (modeRef.current !== "toolbar" || activeWorktreeId === null) return;
    const row = findRowEl(activeWorktreeId);
    if (!row) return;
    const toolbarItems = getToolbarItemsForRow(row);
    if (toolbarItems.length === 0) {
      setGridMode("list");
      gridRef.current?.focus();
      return;
    }
    const idx = Math.min(activeToolbarIndexRef.current, toolbarItems.length - 1);
    activeToolbarIndexRef.current = idx;
    syncToolbarTabStops(toolbarItems, idx);
  });

  const handleGridFocus = useCallback(
    (_e: React.FocusEvent<HTMLDivElement>) => {
      if (modeRef.current !== "list") return;
      if (activeWorktreeId !== null) return;
      const first = firstRowFlatIndex();
      if (first === null) return;
      const item = itemsRef.current[first];
      if (item?.kind === "row") setActiveWorktreeId(item.worktreeId);
    },
    [activeWorktreeId, firstRowFlatIndex]
  );

  const handleGridFocusCapture = useCallback(
    (e: React.FocusEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      // Focus inside a row toolbar — switch to toolbar mode.
      const row = target.closest<HTMLElement>("[data-worktree-row]");
      if (!row) return;
      const worktreeId = row.dataset.worktreeRow;
      if (!worktreeId) return;
      const toolbar = row.querySelector<HTMLElement>(TOOLBAR_SELECTOR);
      if (toolbar && toolbar.contains(target) && target !== row) {
        const toolbarItems = getToolbarItemsForRow(row);
        const itemIdx = toolbarItems.indexOf(target);
        if (itemIdx !== -1) {
          setGridMode("toolbar");
          activeToolbarIndexRef.current = itemIdx;
          syncToolbarTabStops(toolbarItems, itemIdx);
          setActiveWorktreeId(worktreeId);
          return;
        }
      }
      // Focus landed on a non-toolbar element inside a row (e.g., the
      // absolute select-worktree button via mouse). Reflect that as the new
      // active row but stay in list mode.
      setActiveWorktreeId(worktreeId);
      if (modeRef.current === "toolbar") {
        setGridMode("list");
      }
    },
    [getToolbarItemsForRow, setGridMode, syncToolbarTabStops]
  );

  const handleGridKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.metaKey) return;
      const isAltArrowReorder = e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown");
      if (e.altKey && !isAltArrowReorder) return;
      if (e.ctrlKey && e.key !== "Home" && e.key !== "End") return;

      const mode = modeRef.current;

      if (mode === "toolbar") {
        if (activeWorktreeId === null) return;
        const row = findRowEl(activeWorktreeId);
        if (!row) {
          enterListMode(activeWorktreeId);
          return;
        }
        const toolbarItems = getToolbarItemsForRow(row);
        if (toolbarItems.length === 0) {
          enterListMode(activeWorktreeId);
          return;
        }
        const currentIdx = Math.min(activeToolbarIndexRef.current, toolbarItems.length - 1);

        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          enterListMode(activeWorktreeId);
          return;
        }
        if (e.ctrlKey && (e.key === "Home" || e.key === "End")) {
          const target = e.key === "Home" ? firstRowFlatIndex() : lastRowFlatIndex();
          if (target === null) return;
          e.preventDefault();
          enterListMode(null);
          navigateTo(target);
          return;
        }
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          // Bounce back to list mode and move the active row by one.
          const fromIdx = getActiveRowFlatIndex();
          if (fromIdx === -1) return;
          const next = advance(fromIdx, e.key === "ArrowDown" ? 1 : -1);
          e.preventDefault();
          enterListMode(null);
          if (next !== null) navigateTo(next);
          return;
        }

        let newIdx: number | null = null;
        switch (e.key) {
          case "ArrowRight":
            newIdx = (currentIdx + 1) % toolbarItems.length;
            break;
          case "ArrowLeft":
            newIdx = (currentIdx - 1 + toolbarItems.length) % toolbarItems.length;
            break;
          case "Home":
            newIdx = 0;
            break;
          case "End":
            newIdx = toolbarItems.length - 1;
            break;
        }
        if (newIdx !== null) {
          e.preventDefault();
          activeToolbarIndexRef.current = newIdx;
          syncToolbarTabStops(toolbarItems, newIdx);
          toolbarItems[newIdx]!.focus();
        }
        return;
      }

      // List mode
      // Only handle keys originating on the grid container itself. Once focus
      // descends into a row (e.g., mouse-click into a toolbar), the toolbar
      // branch above takes over.
      if (e.target !== gridRef.current) return;

      // Establish an active row on first interaction.
      let currentFlatIdx = getActiveRowFlatIndex();
      if (currentFlatIdx === -1) {
        const first = firstRowFlatIndex();
        if (first === null) return;
        currentFlatIdx = first;
        const item = itemsRef.current[first];
        if (item?.kind === "row") setActiveWorktreeId(item.worktreeId);
      }

      const currentItem = itemsRef.current[currentFlatIdx];
      if (!currentItem || currentItem.kind !== "row") return;
      const currentWorktreeId = currentItem.worktreeId;

      if (isAltArrowReorder) {
        e.preventDefault();
        e.stopPropagation();
        onKeyboardReorderRef.current?.(currentWorktreeId, e.key === "ArrowDown" ? 1 : -1);
        return;
      }

      if (e.key === "Enter" || e.key === "ArrowRight") {
        if (enterToolbarMode(currentWorktreeId)) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        selectRow(currentWorktreeId, e);
        return;
      }

      // j / k aliases for Vim-style navigation, alongside ArrowUp/ArrowDown.
      if (e.key === " " || e.key === "Spacebar") {
        selectRow(currentWorktreeId, e);
        return;
      }

      let nextFlat: number | null = null;
      switch (e.key) {
        case "ArrowDown":
        case "j":
          nextFlat = advance(currentFlatIdx, 1);
          break;
        case "ArrowUp":
        case "k":
          nextFlat = advance(currentFlatIdx, -1);
          break;
        case "PageDown": {
          const pageSize = computePageSize(scrollerRef.current);
          let candidate = currentFlatIdx;
          for (let i = 0; i < pageSize; i++) {
            const next = advance(candidate, 1);
            if (next === null) break;
            candidate = next;
          }
          if (candidate !== currentFlatIdx) nextFlat = candidate;
          break;
        }
        case "PageUp": {
          const pageSize = computePageSize(scrollerRef.current);
          let candidate = currentFlatIdx;
          for (let i = 0; i < pageSize; i++) {
            const next = advance(candidate, -1);
            if (next === null) break;
            candidate = next;
          }
          if (candidate !== currentFlatIdx) nextFlat = candidate;
          break;
        }
        case "Home":
          nextFlat = firstRowFlatIndex();
          break;
        case "End":
          nextFlat = lastRowFlatIndex();
          break;
      }

      if (nextFlat !== null && nextFlat !== currentFlatIdx) {
        e.preventDefault();
        navigateTo(nextFlat);
      } else if (
        e.key === "ArrowDown" ||
        e.key === "ArrowUp" ||
        e.key === "PageDown" ||
        e.key === "PageUp" ||
        e.key === "Home" ||
        e.key === "End" ||
        e.key === "j" ||
        e.key === "k"
      ) {
        // Boundary — still prevent default so a stray ArrowDown doesn't
        // scroll the surrounding page.
        e.preventDefault();
      }
    },
    [
      activeWorktreeId,
      advance,
      enterListMode,
      enterToolbarMode,
      findRowEl,
      firstRowFlatIndex,
      getActiveRowFlatIndex,
      getToolbarItemsForRow,
      lastRowFlatIndex,
      navigateTo,
      scrollerRef,
      selectRow,
      syncToolbarTabStops,
    ]
  );

  const activeDescendantId =
    mode === "list" && activeWorktreeId ? getWorktreeSidebarRowId(activeWorktreeId) : undefined;

  // Mirror the activeDescendant mode-guard: only expose a cursor in list mode.
  // In toolbar mode focus has descended into a real DOM button, which owns the
  // visible focus ring, so the row-level cursor ring would be a duplicate.
  const keyboardCursorId = mode === "list" ? activeWorktreeId : null;

  return {
    gridRef,
    activeDescendantId,
    keyboardCursorId,
    handleGridKeyDown,
    handleGridFocus,
    handleGridFocusCapture,
  };
}
