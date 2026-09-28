/**
 * Whether a list row was just claimed by the pointer, so revealing it with
 * `scrollIntoView` would scroll it out from under the pointer.
 *
 * Two facts, both needed. The row has to be under the pointer (`:hover`), and
 * the pointer has to be the last thing the user moved — a keyboard step that
 * lands on a half-visible row beneath a resting pointer still owes the reveal.
 * The last input is tracked once, at the window, the way the browser's own
 * focus-visible heuristic is; module state rather than a per-list ref, so a
 * reveal effect can read it without threading anything through render.
 */

let lastInput: "pointer" | "keyboard" = "keyboard";

if (typeof window !== "undefined") {
  window.addEventListener(
    "pointermove",
    () => {
      lastInput = "pointer";
    },
    { capture: true, passive: true }
  );
  window.addEventListener(
    "keydown",
    () => {
      lastInput = "keyboard";
    },
    { capture: true }
  );
}

export function isPointerClaimed(row: Element | null | undefined): boolean {
  return lastInput === "pointer" && row != null && row.matches(":hover");
}
