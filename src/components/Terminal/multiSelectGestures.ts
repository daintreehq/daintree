/**
 * Pure helpers that decide how fleet multi-select gestures resolve for a
 * terminal pane. The UI layer (TerminalPane) reads the decision and
 * dispatches to `fleetArmingStore`. Keeping the logic pure lets us test
 * each gesture path without mounting the full pane.
 *
 * Gesture model (mirrors `<select multiple>` plus a deliberate
 * simplification: shift and cmd both add a single pane, no range-extend).
 *
 * - Shift-click on an eligible pane → toggle membership (additive).
 * - Cmd/Ctrl-click on an eligible pane → toggle membership (additive).
 * - Plain click with a non-empty fleet → clear the fleet (caller then
 *   focuses the clicked pane → exclusive single selection).
 * - Plain click with an empty fleet → no fleet-side effect.
 */

export interface GestureModifiers {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

export type ChromeAction = { type: "toggle" } | { type: "clear" } | { type: "none" };

export function decideChromeAction(
  modifiers: GestureModifiers,
  options: {
    isEligible: boolean;
    isArmed: boolean;
    armedSize: number;
  }
): ChromeAction {
  const hasModifier = modifiers.shiftKey || modifiers.metaKey || modifiers.ctrlKey;
  if (hasModifier && options.isEligible) {
    return { type: "toggle" };
  }
  if (!hasModifier && options.armedSize > 0) {
    return { type: "clear" };
  }
  return { type: "none" };
}
