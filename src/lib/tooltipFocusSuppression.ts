// Element-scoped tooltip suppression for overlay focus restoration.
//
// Radix opens tooltips on FOCUS as well as hover, and every overlay hands
// focus back when it closes — a dropdown and a popover call `.focus()` on
// their own trigger, a context menu lets its focus scope restore whatever was
// focused before it opened. Either way the element that receives that focus
// drags its tooltip open under a pointer that is nowhere near it.
//
// Deliberately NOT `dismissAllTooltips()`. That call force-closes every
// registered tooltip in the app and arms a global window; it is the right
// hammer for a dialog, which can strand a tooltip anywhere, and the wrong one
// for a menu that knows exactly which tooltip is about to reopen — blanket
// popover wiring was rejected in #11034. This is the scoped alternative: one
// element, one short window, nothing else in the app touched.
//
// The element is discovered rather than plumbed. `armTooltipFocusSuppression`
// runs from the overlay's close-autofocus handler, immediately before focus
// moves, and installs a one-shot CAPTURE `focusin` listener on `document`.
// React attaches its own listeners to the root container, which is below
// `document`, so the capture listener always sees the focus first and can mark
// the element before any tooltip reacts to it. That covers the focus-scope
// restore path too, where there is no trigger ref to plumb in the first place.

import { TOOLTIP_FOCUS_SUPPRESS_MS } from "./tooltipDismissRegistry";

// WeakMap so an element that is unmounted while suppressed (a menu closing
// into a row that re-renders away) cannot keep itself alive. Reassignable
// rather than `const` because a WeakMap cannot be emptied, and the test reset
// below has to actually drop the marks, not just stop listening.
let suppressedUntil = new WeakMap<Element, number>();

let armedHandler: ((event: FocusEvent) => void) | null = null;
let armedTimer: ReturnType<typeof setTimeout> | null = null;

function disarm(): void {
  if (armedHandler) {
    // The 0ms timer below can outlive the document that armed it — a test
    // environment torn down before it fires, a window closing mid-restore —
    // so this mirrors the guard in `armTooltipFocusSuppression`.
    if (typeof document !== "undefined") {
      document.removeEventListener("focusin", armedHandler, true);
    }
    armedHandler = null;
  }
  if (armedTimer !== null) {
    clearTimeout(armedTimer);
    armedTimer = null;
  }
}

/**
 * Suppress the focus-driven tooltip open on whichever element is focused next.
 *
 * Call it from an overlay's close-autofocus handler. The restoration is
 * synchronous with that handler in every Radix path, so the listener resolves
 * within the same task; the timer only exists so a close that restores nothing
 * doesn't leave a listener armed for the next unrelated focus.
 */
export function armTooltipFocusSuppression(): void {
  if (typeof document === "undefined") return;
  disarm();
  const handler = (event: FocusEvent) => {
    const target = event.target;
    if (target instanceof Element) {
      suppressedUntil.set(target, Date.now() + TOOLTIP_FOCUS_SUPPRESS_MS);
    }
    disarm();
  };
  armedHandler = handler;
  document.addEventListener("focusin", handler, true);
  armedTimer = setTimeout(disarm, 0);
}

export function isTooltipSuppressedForElement(element: Element | null | undefined): boolean {
  if (!element) return false;
  const until = suppressedUntil.get(element);
  return until !== undefined && Date.now() < until;
}

/**
 * A genuine hover over the element ends its suppression — the user is pointing
 * at it, so a tooltip is wanted again. Fired from the tooltip trigger's own
 * pointer handlers, which always precede the open Radix would perform.
 */
export function clearTooltipSuppressionForElement(element: Element | null | undefined): void {
  if (!element) return;
  suppressedUntil.delete(element);
}

/** True while a close-autofocus listener is waiting for the restored focus. */
export function isTooltipFocusSuppressionArmed(): boolean {
  return armedHandler !== null;
}

export function _resetTooltipFocusSuppressionForTests(): void {
  disarm();
  // A fresh map, since the marks outlive the listener: a suppressed element
  // reused across cases in the same file would otherwise carry its window over.
  suppressedUntil = new WeakMap<Element, number>();
}
