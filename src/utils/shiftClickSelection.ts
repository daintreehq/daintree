import type React from "react";

const TEXT_ENTRY_SELECTOR =
  "input, textarea, select, [contenteditable]:not([contenteditable='false'])";
const FOCUSABLE_SELECTOR = "button, a[href], [tabindex]";

/**
 * Stops a Shift+click on a multi-select surface from extending the page's
 * text selection. Chromium extends the selection on Shift+mousedown, before
 * any click handler runs, so a click-time `preventDefault` is too late and
 * `user-select: none` does not help when the selection is anchored elsewhere.
 * The stretched selection can cross terminals, and xterm's screen-reader
 * `selectionchange` handler throws "invalid range" on it (#12926).
 *
 * Cancelling mousedown also cancels the focus the click would have moved, so
 * the nearest focusable element inside the surface is focused by hand.
 * Text fields keep native Shift+click behaviour.
 */
export function suppressShiftClickTextSelection(event: React.MouseEvent<HTMLElement>): void {
  if (!event.shiftKey || event.button !== 0) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest(TEXT_ENTRY_SELECTOR)) return;
  event.preventDefault();
  const focusable = target?.closest<HTMLElement>(FOCUSABLE_SELECTOR);
  if (focusable && event.currentTarget.contains(focusable)) {
    focusable.focus({ preventScroll: true });
  }
}
