import type React from "react";

const TEXT_ENTRY_SELECTOR =
  "input:not([type='checkbox']):not([type='radio']), textarea, select, [contenteditable]:not([contenteditable='false'])";
const FOCUSABLE_SELECTOR = "button, input, a[href], [tabindex]";

/**
 * Stops a Shift+click on a multi-select surface from extending the page's
 * text selection. Chromium extends the selection on Shift+mousedown, before
 * any click handler runs, so a click-time `preventDefault` is too late and
 * `user-select: none` does not help when the selection is anchored elsewhere.
 * The stretched selection can cross terminals, and xterm's screen-reader
 * `selectionchange` handler throws "invalid range" on it (#12926).
 *
 * Cancelling mousedown also cancels its focus change, so that is replayed by
 * hand: the nearest focusable ancestor takes focus — even one outside the
 * surface, like a listbox around its rows — and with none, focus is dropped,
 * as a native click on inert content would. Text fields keep native
 * Shift+click behaviour.
 */
export function suppressShiftClickTextSelection(event: React.MouseEvent<HTMLElement>): void {
  if (!event.shiftKey || event.button !== 0) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest(TEXT_ENTRY_SELECTOR)) return;
  event.preventDefault();
  const focusable = target?.closest<HTMLElement>(FOCUSABLE_SELECTOR);
  if (focusable) {
    focusable.focus({ preventScroll: true });
  } else if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
}
