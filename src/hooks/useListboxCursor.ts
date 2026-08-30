import { useCallback, useEffect, useRef, useState } from "react";

export interface ListboxCursorKeyEvent {
  key: string;
  /**
   * Read so a modified Enter is left alone. The create-worktree dialog
   * advertises Cmd/Ctrl+Enter as "submit from anywhere, pickers included"; a
   * list that swallowed it would break the shortcut it prints on its own button.
   */
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  nativeEvent: { isComposing: boolean; keyCode: number };
  preventDefault: () => void;
  stopPropagation: () => void;
}

export interface UseListboxCursorArgs {
  /** Number of selectable rows currently rendered. */
  itemCount: number;
  /** Whether the surface holding the list is open — resets the cursor on each session. */
  open: boolean;
  /**
   * Identity of the current result set (a query string, a generation counter).
   * Changing it rewinds the raw cursor, not just the clamped one: clamping hides
   * an out-of-range index without discarding it, so narrowing to one row and
   * then widening again would resurrect the old index on an unrelated row.
   * Omit for a list whose rows never change while it is open.
   */
  resetKey?: unknown;
  onSelect: (index: number) => void;
  onClose: () => void;
}

export interface UseListboxCursorResult {
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  /** Attach to the scroll container; rows carry `data-option-index`. */
  listRef: React.RefObject<HTMLDivElement | null>;
  handleKeyDown: (e: ListboxCursorKeyEvent) => void;
}

/**
 * The roving cursor a popover listbox needs to be usable from the keyboard:
 * arrows wrap, Home/End jump, Enter commits, Escape closes.
 *
 * Extracted because the pickers that lacked it had each grown the same wrong
 * answer instead — a `tabIndex={0}` on every row, which turns a fifty-item list
 * into fifty tab stops and still leaves the arrow keys doing nothing.
 *
 * The index is clamped at read time rather than corrected by an effect: an
 * effect runs a render after the list shrank, so for one frame the highlight,
 * the active descendant and Enter's target could each resolve to a different
 * row. Mirrors `useBranchPicker`, which owns the same model plus a search box.
 */
export function useListboxCursor({
  itemCount,
  open,
  resetKey,
  onSelect,
  onClose,
}: UseListboxCursorArgs): UseListboxCursorResult {
  const [cursorIndex, setCursorIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const activeIndex =
    cursorIndex >= 0 && cursorIndex < itemCount ? cursorIndex : itemCount > 0 ? 0 : -1;

  // Reset on every transition, not just close: Radix cancels the exit animation
  // when a popover reopens inside it, so a reset armed only on the close path
  // would be skipped and fire against the next session instead.
  useEffect(() => {
    setCursorIndex(0);
  }, [open, resetKey]);

  useEffect(() => {
    if (!listRef.current || activeIndex < 0) return;
    listRef.current
      .querySelector<HTMLElement>(`[data-option-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const handleKeyDown = useCallback(
    (e: ListboxCursorKeyEvent) => {
      // Mid-composition, Arrow and Enter belong to the IME: Enter commits the
      // candidate rather than the row. Chromium can emit 229 before
      // `isComposing` flips, so both are checked.
      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;

      // The popover portals to document.body, so an unhandled Enter or Escape
      // reaches the dialog that logically contains it — Enter would submit it.
      const consume = () => {
        e.preventDefault();
        e.stopPropagation();
      };

      if (e.key === "Escape") {
        consume();
        onClose();
        return;
      }

      // The list owns the bare navigation keys only. A modified chord belongs to
      // whatever bound it — Cmd+Enter to the dialog's submit, Alt+Arrow to the
      // app's own bindings.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (itemCount === 0) return;

      switch (e.key) {
        case "ArrowDown":
          consume();
          setCursorIndex((activeIndex + 1) % itemCount);
          break;
        case "ArrowUp":
          consume();
          setCursorIndex((activeIndex - 1 + itemCount) % itemCount);
          break;
        case "Home":
          consume();
          setCursorIndex(0);
          break;
        case "End":
          consume();
          setCursorIndex(itemCount - 1);
          break;
        case "Enter":
          consume();
          if (activeIndex >= 0) onSelect(activeIndex);
          break;
      }
    },
    [activeIndex, itemCount, onClose, onSelect]
  );

  return { activeIndex, setActiveIndex: setCursorIndex, listRef, handleKeyDown };
}
