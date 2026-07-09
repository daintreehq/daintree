// Global dismiss registry for Radix tooltips (issue #11030).
//
// Radix opens tooltips on focus as well as hover, and dialogs move focus
// around (autofocus into the dialog on open, focus restoration to the
// trigger on close), so tooltips strand open or appear hover-less around
// every dialog transition. Radix ships no provider-level "close all" API,
// so each mounted Tooltip registers a dismiss callback here and the dialog
// primitives (AppDialog / AppPaletteDialog) invoke `dismissAllTooltips()`
// on every open and close.
//
// Dismissing alone isn't enough: the focus move the dialog performs AFTER
// the dismiss re-opens a tooltip through Radix's focus path. Each dismiss
// therefore arms a short suppression window during which focus-driven
// opens are ignored. Genuine pointer interaction clears the window
// immediately (a hover open is always preceded by pointerenter on a
// trigger), so only the hover-less focus-restoration opens are blocked.

// Long enough to cover the dialog's RAF-deferred autofocus (~1 frame) and
// the exit-animation-deferred focus restore, which both re-arm right
// before focusing anyway; short enough that a keyboard user tabbing after
// a dialog closes gets focus tooltips back almost immediately.
export const TOOLTIP_FOCUS_SUPPRESS_MS = 250;

const dismissHandlers: Array<() => void> = [];

let suppressedUntil = 0;

export function registerTooltipDismiss(handler: () => void): () => void {
  dismissHandlers.push(handler);
  return () => {
    const idx = dismissHandlers.lastIndexOf(handler);
    if (idx !== -1) dismissHandlers.splice(idx, 1);
  };
}

/**
 * Close every registered tooltip and arm the focus-open suppression
 * window. Idempotent and cheap — nested dialogs may each fire it.
 */
export function dismissAllTooltips(): void {
  suppressedUntil = Date.now() + TOOLTIP_FOCUS_SUPPRESS_MS;
  // Iterate over a snapshot: a dismiss can unmount tooltips (controlled
  // consumers re-rendering), which unregisters mid-walk.
  for (const handler of [...dismissHandlers]) {
    handler();
  }
}

export function isTooltipFocusOpenSuppressed(): boolean {
  return Date.now() < suppressedUntil;
}

/**
 * A genuine pointer interaction ends suppression early — the user is
 * actually hovering, so tooltip opens are wanted again.
 */
export function notifyTooltipPointerActivity(): void {
  suppressedUntil = 0;
}

export function _resetForTests(): void {
  dismissHandlers.length = 0;
  suppressedUntil = 0;
}
