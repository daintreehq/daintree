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

export interface UseWorktreeOverviewKeyboardOptions {
  /** Ordered list of worktree ids visible in the current filter set. */
  worktreeIds: readonly string[];
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
  gridRef,
  selectionAnchorRef,
  onActivate,
  onToggleSelection,
  onSelectRange,
  onSelectAll,
  onClearSelection,
  onEscapeWithoutSelection,
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
  });
  useEffect(() => {
    callbacksRef.current = {
      onActivate,
      onToggleSelection,
      onSelectRange,
      onSelectAll,
      onClearSelection,
      onEscapeWithoutSelection,
    };
  });
  const worktreeIdsRef = useRef(worktreeIds);
  useEffect(() => {
    worktreeIdsRef.current = worktreeIds;
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
      const ids = worktreeIdsRef.current;
      const callbacks = callbacksRef.current;

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
        case "ArrowDown": {
          const next = currentIndex + columnCount;
          targetIndex = next < total ? next : total - 1;
          break;
        }
        case "ArrowUp": {
          const next = currentIndex - columnCount;
          targetIndex = next >= 0 ? next : 0;
          break;
        }
        case "Home":
          targetIndex = 0;
          break;
        case "End":
          targetIndex = total - 1;
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
      }

      if (targetIndex === null) return;
      e.preventDefault();
      e.stopPropagation();
      const targetId = ids[targetIndex];
      if (targetId === undefined) return;

      // Shift+Arrow extends selection from the persistent anchor; pure arrow
      // movement just moves focus without touching selection. The anchor is
      // set when the user makes their first deliberate selection action
      // (Space, click, Ctrl/Cmd+A) — Shift+Arrow without a prior anchor
      // bootstraps it at the current cell so the range has a stable origin.
      if (e.shiftKey && targetIndex !== currentIndex) {
        if (selectionAnchorRef.current === null) {
          selectionAnchorRef.current = currentId;
        }
        callbacks.onSelectRange(selectionAnchorRef.current, targetId);
      }

      if (targetIndex !== currentIndex) {
        setActiveWorktreeId(targetId);
      }
    },
    [activeWorktreeId, selectionAnchorRef]
  );

  return {
    activeWorktreeId,
    activeDescendantId,
    handleGridKeyDown,
    handleGridFocus,
    setActiveWorktreeId,
  };
}
