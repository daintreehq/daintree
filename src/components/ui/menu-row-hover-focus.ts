import type * as React from "react";

/**
 * Hover-time focus policy shared by every menu row primitive (`DropdownMenu`,
 * `ContextMenu`, `Select`), the open-menu counterpart to the close-time policy
 * in `overlay-focus-restore.ts`.
 *
 * Radix moves DOM focus to a row on mouse hover — `item.focus({ preventScroll:
 * true })` from its own `onPointerMove`. That is script focus, so Chromium
 * decides `:focus-visible` from a per-document heuristic that nothing about
 * opening a menu updates: `last_focus_type_` only tracks user-driven focus and
 * `had_keyboard_event_` flips true on any plain keypress. So the keyboard ring
 * paints on hover or not depending on whether the user last typed or last
 * clicked something focusable, and each project view carries its own copy of
 * that state (#12383).
 *
 * `focusVisible: false` settles it, but the call belongs to Radix and only a
 * real focus transition re-runs the decision — re-focusing an already focused
 * element bails out early, so there is nothing to correct after the fact.
 * Focusing the row ourselves first is worse than it looks: Radix deliberately
 * does NOT focus a row the pointer is only crossing on its way into an open
 * submenu (`onItemEnter` preventDefaults inside the grace area), and taking
 * that focus closes the submenu the user was reaching for. Disabled rows and
 * non-mouse pointers are skipped by Radix for their own reasons.
 *
 * So the row's own `focus` is decorated for the length of the pointer event
 * instead. Radix keeps every decision about whether to focus at all; only the
 * options it asks with change.
 *
 * Known edge: because the state is decided per focus transition, a keystroke
 * that lands on the row already under the pointer — Home on the first row, an
 * unlooped Arrow at either end — leaves it ringless until focus actually moves.
 * Restoring the ring there needs document-wide modality tracking, which is a
 * much bigger mechanism than one dead keypress is worth.
 */
export function menuRowPointerMove<T extends HTMLElement>(
  event: React.PointerEvent<T>,
  onPointerMove?: React.PointerEventHandler<T>
): void {
  onPointerMove?.(event);

  // Radix gates its own hover focus the same two ways: a cancelled event skips
  // its composed handler entirely, and `whenMouse` ignores touch and pen.
  if (event.defaultPrevented || event.pointerType !== "mouse") return;

  const row: HTMLElement = event.currentTarget;
  if (Object.hasOwn(row, "focus")) return;

  Object.defineProperty(row, "focus", {
    configurable: true,
    value(this: HTMLElement, options?: FocusOptions) {
      // Resolved at call time so a prototype spy still observes the call.
      HTMLElement.prototype.focus.call(this, { ...options, focusVisible: false });
    },
  });

  // The dispatch Radix focuses in is synchronous, so the first microtask after
  // it is the earliest moment the decoration is no longer needed.
  queueMicrotask(() => {
    Reflect.deleteProperty(row, "focus");
  });
}
