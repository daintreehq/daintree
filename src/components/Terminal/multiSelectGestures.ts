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

export type ChromeAction =
  | { type: "toggle" }
  | { type: "extend" }
  | { type: "bump-primary" }
  | { type: "none" };

/**
 * Resolve a click on the pane chrome (title bar + surrounding container
 * surface, everything outside the xterm render area). The xterm region has
 * its own pointer-down-capture path and handles native text selection; by
 * the time this runs, `hasSelection()` has already been consulted upstream.
 *
 * - Shift-click on an eligible pane with an ordered ID list extends the
 *   selection across grid visual order.
 * - Cmd/Ctrl-click on an eligible pane toggles selection.
 * - Plain click on an already-armed pane bumps the primary-selection anchor.
 * - Plain click on an unarmed pane is a normal focus click.
 */
export function decideChromeAction(
  modifiers: GestureModifiers,
  options: { isEligible: boolean; isArmed: boolean; orderedEligibleIds?: string[] }
): ChromeAction {
  if (!options.isEligible) return { type: "none" };
  if (modifiers.shiftKey && options.orderedEligibleIds && options.orderedEligibleIds.length > 0) {
    return { type: "extend" };
  }
  if (modifiers.metaKey || modifiers.ctrlKey) return { type: "toggle" };
  if (modifiers.shiftKey) return { type: "toggle" };
  if (options.isArmed) return { type: "bump-primary" };
  return { type: "none" };
}
