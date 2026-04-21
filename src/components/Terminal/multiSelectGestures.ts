/**
 * Pure helpers that decide how fleet multi-select gestures resolve for a
 * terminal pane. The UI layer (TerminalPane) reads the decision and dispatches
 * to `fleetArmingStore`. Keeping the logic pure lets us test each gesture path
 * without mounting the full pane.
 */

export interface GestureModifiers {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

export type SelectHandleAction = { type: "toggle" } | { type: "extend" };

export type ChromeAction = { type: "toggle" } | { type: "bump-primary" } | { type: "none" };

/**
 * Resolve a click on the dedicated selection handle button.
 *
 * - Shift-click (with a non-empty `orderedEligibleIds` list) extends the
 *   current selection to the target using grid visual order.
 * - All other clicks toggle the target.
 *
 * The handle is only rendered for eligible panels, so there's no eligibility
 * gate here — the caller has already decided.
 */
export function decideSelectHandleAction(
  modifiers: GestureModifiers,
  orderedEligibleIds: string[] | undefined
): SelectHandleAction {
  if (modifiers.shiftKey && orderedEligibleIds && orderedEligibleIds.length > 0) {
    return { type: "extend" };
  }
  return { type: "toggle" };
}

/**
 * Resolve a click on the pane chrome (the container surface handled by
 * `ContentPanel.onClick`, which flows through `TerminalPane.handleClick`).
 *
 * - Cmd/Ctrl-click on an eligible pane toggles fleet selection (power-user
 *   shortcut retained after the rework).
 * - Plain click on an already-armed eligible pane bumps the primary-selection
 *   anchor so subsequent shift-clicks on handles range-extend from here.
 * - Everything else is a normal focus click (caller handles it).
 *
 * Shift-click on chrome is deliberately NOT a fleet gesture — that slot is
 * reserved for xterm's native selection-extend. See issue #5748.
 */
export function decideChromeAction(
  modifiers: GestureModifiers,
  options: { isEligible: boolean; isArmed: boolean }
): ChromeAction {
  if (!options.isEligible) return { type: "none" };
  if (modifiers.metaKey || modifiers.ctrlKey) return { type: "toggle" };
  if (options.isArmed) return { type: "bump-primary" };
  return { type: "none" };
}
