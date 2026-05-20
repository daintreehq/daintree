export type TerminalFocusTarget = "hybridInput" | "xterm";

export function shouldShowHybridInputBar(options: {
  hasAgentIdentity: boolean;
  hybridInputEnabled: boolean;
  isFleetArmed: boolean;
  fleetSize: number;
}): boolean {
  return (
    options.hybridInputEnabled &&
    (options.hasAgentIdentity || (options.isFleetArmed && options.fleetSize >= 2))
  );
}

/**
 * Resolve which child component should receive focus when the terminal pane
 * gains focus.
 *
 * This is an *availability resolver*: it takes the user's current preference
 * and gates it on whether the hybrid input is actually focusable. The hybrid
 * input renders for live agent terminals and for normal terminals temporarily
 * participating in a Fleet broadcast; when it's missing, disabled, or the
 * feature is turned off, focus falls back to xterm.
 *
 * `preferredTarget` is session state owned by `panelStore` — it tracks which
 * sub-element the user is currently using so navigation (Cmd-Opt-Arrow) stays
 * in the same mode across panes.
 */
export function getTerminalFocusTarget(options: {
  preferredTarget: TerminalFocusTarget;
  hasHybridInputSurface: boolean;
  isInputDisabled: boolean;
  hybridInputEnabled: boolean;
}): TerminalFocusTarget {
  if (
    options.preferredTarget === "hybridInput" &&
    options.hasHybridInputSurface &&
    !options.isInputDisabled &&
    options.hybridInputEnabled
  ) {
    return "hybridInput";
  }
  return "xterm";
}

/**
 * Whether a pointerdown on the xterm area of an *unfocused* grid pane should
 * be swallowed before xterm sees it. Prevents stray clicks from poking at
 * cursor positions, mouse-mode handlers, or kicking off selection on a pane
 * that the user is just trying to activate.
 *
 * Intentionally narrow: only applies to the unfocused grid case, only for
 * non-pointer (non-link) cells, and never for shift+click — xterm's
 * SelectionService treats shift as the override gesture to bypass PTY mouse
 * reporting and force native text selection, so the event must reach xterm.
 * The redirect to hybrid input vs xterm is *not* decided here — callers
 * consult `getTerminalFocusTarget` separately.
 */
export function shouldSuppressUnfocusedClick(options: {
  location: string;
  isFocused: boolean;
  isCursorPointer: boolean;
  isShiftKey: boolean;
}): boolean {
  if (options.location !== "grid") return false;
  if (options.isFocused) return false;
  if (options.isCursorPointer) return false;
  if (options.isShiftKey) return false;
  return true;
}
