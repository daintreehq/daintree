import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type React from "react";

type GridMode = "list" | "toolbar";

const ROW_SELECTOR = "[data-worktree-row]";
const TOOLBAR_SELECTOR = "[data-worktree-row-toolbar]";
const TOOLBAR_ITEM_SELECTOR =
  "button:not(:disabled), [role='button']:not([aria-disabled='true']), [tabindex]:not([tabindex='-1'])";

function isElementVisible(el: HTMLElement): boolean {
  return el.offsetParent !== null || el.getClientRects().length > 0;
}

export interface UseWorktreeGridRovingFocusReturn {
  gridRef: React.RefObject<HTMLDivElement | null>;
  handleGridKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  handleGridFocusCapture: (e: React.FocusEvent<HTMLDivElement>) => void;
}

export function useWorktreeGridRovingFocus(): UseWorktreeGridRovingFocusReturn {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const modeRef = useRef<GridMode>("list");
  const activeRowIndexRef = useRef<number>(0);
  const activeToolbarIndexRef = useRef<number>(0);

  const getRows = useCallback((): HTMLElement[] => {
    if (!gridRef.current) return [];
    return Array.from(gridRef.current.querySelectorAll<HTMLElement>(ROW_SELECTOR)).filter(
      isElementVisible
    );
  }, []);

  const getRowToolbarItems = useCallback((row: HTMLElement): HTMLElement[] => {
    const toolbar = row.querySelector<HTMLElement>(TOOLBAR_SELECTOR);
    if (!toolbar) return [];
    return Array.from(toolbar.querySelectorAll<HTMLElement>(TOOLBAR_ITEM_SELECTOR)).filter(
      isElementVisible
    );
  }, []);

  const syncRowTabStops = useCallback((rows: HTMLElement[], activeIdx: number) => {
    for (const row of rows) row.tabIndex = -1;
    if (rows[activeIdx]) rows[activeIdx].tabIndex = 0;
  }, []);

  const syncToolbarTabStops = useCallback((items: HTMLElement[], activeIdx: number) => {
    for (const el of items) el.tabIndex = -1;
    if (items[activeIdx]) items[activeIdx].tabIndex = 0;
  }, []);

  const selectRow = useCallback(
    (row: HTMLElement | undefined, e: React.KeyboardEvent | React.SyntheticEvent) => {
      if (!row) return;
      const selectBtn = row.querySelector<HTMLElement>("button[aria-label^='Select worktree']");
      if (selectBtn) {
        e.preventDefault();
        e.stopPropagation();
        selectBtn.click();
      }
    },
    []
  );

  const enterListMode = useCallback(
    (rows: HTMLElement[], rowIdx: number) => {
      modeRef.current = "list";
      activeRowIndexRef.current = rowIdx;
      // Reset toolbar items in the previously active row so they are no longer
      // tab-reachable from outside the grid.
      const previousRow = rows[rowIdx];
      if (previousRow) {
        const items = getRowToolbarItems(previousRow);
        for (const el of items) el.tabIndex = -1;
      }
      syncRowTabStops(rows, rowIdx);
    },
    [getRowToolbarItems, syncRowTabStops]
  );

  const enterToolbarMode = useCallback(
    (rows: HTMLElement[], rowIdx: number): boolean => {
      const row = rows[rowIdx];
      if (!row) return false;
      const items = getRowToolbarItems(row);
      if (items.length === 0) return false;
      modeRef.current = "toolbar";
      activeToolbarIndexRef.current = 0;
      // Hand the tab stop off from the row to the first toolbar button so a
      // re-entrant Tab still hits this row's actions.
      row.tabIndex = -1;
      syncToolbarTabStops(items, 0);
      items[0]!.focus();
      return true;
    },
    [getRowToolbarItems, syncToolbarTabStops]
  );

  // After every render, re-sync the tab stops so a single row owns tabIndex=0.
  // Mirrors Toolbar.tsx's approach — survives re-renders without storing the
  // active index in React state.
  useLayoutEffect(() => {
    const rows = getRows();
    if (rows.length === 0) return;
    const clamped = Math.min(activeRowIndexRef.current, rows.length - 1);
    activeRowIndexRef.current = clamped;
    if (modeRef.current === "list") {
      syncRowTabStops(rows, clamped);
    } else {
      const row = rows[clamped];
      if (row) {
        const items = getRowToolbarItems(row);
        if (items.length === 0) {
          // Toolbar disappeared (e.g., row no longer hover/focus visible) —
          // fall back to list mode.
          enterListMode(rows, clamped);
        } else {
          row.tabIndex = -1;
          const itemIdx = Math.min(activeToolbarIndexRef.current, items.length - 1);
          activeToolbarIndexRef.current = itemIdx;
          syncToolbarTabStops(items, itemIdx);
        }
      }
    }
  });

  // Reset to list mode when the window loses focus so re-entering the grid
  // always starts on a row, never inside a toolbar (lesson #4591).
  useEffect(() => {
    const handleBlur = () => {
      modeRef.current = "list";
    };
    window.addEventListener("blur", handleBlur);
    return () => window.removeEventListener("blur", handleBlur);
  }, []);

  const handleGridFocusCapture = useCallback(
    (e: React.FocusEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      const rows = getRows();
      if (rows.length === 0) return;

      const rowIdx = rows.findIndex((row) => row === target);
      if (rowIdx !== -1) {
        // Focus landed on the row wrapper itself.
        activeRowIndexRef.current = rowIdx;
        if (modeRef.current === "toolbar") {
          enterListMode(rows, rowIdx);
        } else {
          syncRowTabStops(rows, rowIdx);
        }
        return;
      }

      // Focus landed inside a row — find which one.
      const containingRowIdx = rows.findIndex((row) => row.contains(target));
      if (containingRowIdx === -1) return;

      activeRowIndexRef.current = containingRowIdx;
      const row = rows[containingRowIdx]!;

      // If the focus target is inside the per-row action toolbar, switch to
      // toolbar mode and remember which item is active.
      const toolbar = row.querySelector<HTMLElement>(TOOLBAR_SELECTOR);
      if (toolbar && toolbar.contains(target)) {
        const items = getRowToolbarItems(row);
        const itemIdx = items.indexOf(target);
        if (itemIdx !== -1) {
          modeRef.current = "toolbar";
          activeToolbarIndexRef.current = itemIdx;
          row.tabIndex = -1;
          syncToolbarTabStops(items, itemIdx);
          return;
        }
      }
      // Focus landed somewhere inside the row but outside the toolbar (e.g.,
      // the underlying full-card "Select worktree" button). Stay in list mode
      // but hand the row's tabIndex off so re-entering the grid lands here.
      syncRowTabStops(rows, containingRowIdx);
    },
    [enterListMode, getRowToolbarItems, getRows, syncRowTabStops, syncToolbarTabStops]
  );

  const handleGridKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.metaKey || e.altKey || e.ctrlKey) return;

      const rows = getRows();
      if (rows.length === 0) return;

      const mode = modeRef.current;
      const target = e.target as HTMLElement;
      const isOnRow = rows.some((row) => row === target);

      if (mode === "list") {
        // If focus isn't on a row wrapper, skip — the user is interacting with
        // some other in-grid element (e.g., a scroll indicator).
        if (!isOnRow) return;

        const currentIdx = Math.min(activeRowIndexRef.current, rows.length - 1);
        let newIdx: number | null = null;

        if (e.key === "Enter" || e.key === "ArrowRight") {
          // Try to enter toolbar mode. If the row has no toolbar items
          // (e.g., the actions wrapper is hidden), fall back to selecting
          // the row's primary worktree (the absolute "Select worktree" button).
          if (enterToolbarMode(rows, currentIdx)) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          selectRow(rows[currentIdx], e);
          return;
        }

        if (e.key === " " || e.key === "Spacebar") {
          selectRow(rows[currentIdx], e);
          return;
        }

        switch (e.key) {
          case "ArrowDown":
            newIdx = (currentIdx + 1) % rows.length;
            break;
          case "ArrowUp":
            newIdx = (currentIdx - 1 + rows.length) % rows.length;
            break;
          case "Home":
            newIdx = 0;
            break;
          case "End":
            newIdx = rows.length - 1;
            break;
        }
        if (newIdx !== null) {
          e.preventDefault();
          activeRowIndexRef.current = newIdx;
          syncRowTabStops(rows, newIdx);
          rows[newIdx]!.focus();
        }
        return;
      }

      // Toolbar mode
      const rowIdx = activeRowIndexRef.current;
      const row = rows[rowIdx];
      if (!row) return;
      const items = getRowToolbarItems(row);
      if (items.length === 0) {
        enterListMode(rows, rowIdx);
        return;
      }
      const currentIdx = Math.min(activeToolbarIndexRef.current, items.length - 1);

      if (e.key === "Escape") {
        enterListMode(rows, rowIdx);
        row.focus();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        // Up/Down in toolbar mode bounces back to list mode and moves rows.
        enterListMode(rows, rowIdx);
        const nextIdx =
          e.key === "ArrowDown"
            ? (rowIdx + 1) % rows.length
            : (rowIdx - 1 + rows.length) % rows.length;
        e.preventDefault();
        activeRowIndexRef.current = nextIdx;
        syncRowTabStops(rows, nextIdx);
        rows[nextIdx]!.focus();
        return;
      }

      let newIdx: number | null = null;
      switch (e.key) {
        case "ArrowRight":
          newIdx = (currentIdx + 1) % items.length;
          break;
        case "ArrowLeft":
          newIdx = (currentIdx - 1 + items.length) % items.length;
          break;
        case "Home":
          newIdx = 0;
          break;
        case "End":
          newIdx = items.length - 1;
          break;
      }
      if (newIdx !== null) {
        e.preventDefault();
        activeToolbarIndexRef.current = newIdx;
        syncToolbarTabStops(items, newIdx);
        items[newIdx]!.focus();
      }
    },
    [
      enterListMode,
      enterToolbarMode,
      getRowToolbarItems,
      getRows,
      selectRow,
      syncRowTabStops,
      syncToolbarTabStops,
    ]
  );

  return { gridRef, handleGridKeyDown, handleGridFocusCapture };
}
