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

export interface StepListboxCursorOptions {
  /**
   * Past either end, go round to the other. On for pickers and suggestion
   * lists, which are short and transient; off for a persistent list, where one
   * press too many would otherwise throw the user to the far end of a long list.
   */
  wrap?: boolean;
  /**
   * The list has a resting position of no row at all (`-1`), which in a
   * combobox is the text the user typed. Up from the first row returns to it,
   * and a wrapping list passes through it on the way round.
   */
  allowNone?: boolean;
}

/**
 * Where a list cursor goes for a navigation key: arrows step, Home/End jump to
 * the ends. Returns `null` for any other key, and for an empty list, so the
 * caller leaves the key alone.
 *
 * The one stepping rule every picker shares, so a list cannot clamp at its ends
 * or forget Home/End while its neighbours do neither. `index` may be `-1` or
 * out of range: Down then enters at the first row and Up at the last.
 */
export function stepListboxCursor(
  key: string,
  index: number,
  count: number,
  { wrap = true, allowNone = false }: StepListboxCursorOptions = {}
): number | null {
  if (count <= 0) return null;
  const inRange = index >= 0 && index < count;
  switch (key) {
    case "Home":
      return 0;
    case "End":
      return count - 1;
    case "ArrowDown":
      if (!inRange) return 0;
      if (index < count - 1) return index + 1;
      return wrap ? (allowNone ? -1 : 0) : index;
    case "ArrowUp":
      if (!inRange) return count - 1;
      if (index > 0) return index - 1;
      if (allowNone) return -1;
      return wrap ? count - 1 : index;
    default:
      return null;
  }
}

/**
 * Whether a key arrived with a modifier. The list steps on bare keys only:
 * Shift+Home selects the field's text, Cmd+Arrow moves its caret, and a chord
 * belongs to whatever bound it.
 */
export function hasKeyModifier(e: {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}): boolean {
  return e.shiftKey || e.metaKey || e.ctrlKey || e.altKey;
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

      const next = stepListboxCursor(e.key, activeIndex, itemCount);
      if (next !== null) {
        consume();
        setCursorIndex(next);
        return;
      }

      if (e.key === "Enter") {
        consume();
        if (activeIndex >= 0) onSelect(activeIndex);
      }
    },
    [activeIndex, itemCount, onClose, onSelect]
  );

  return { activeIndex, setActiveIndex: setCursorIndex, listRef, handleKeyDown };
}
