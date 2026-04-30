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
 * The HybridInputBar can render for live agent terminals and for normal
 * terminals that are temporarily participating in a Fleet broadcast.
 */
export function getTerminalFocusTarget(options: {
  hasHybridInputSurface: boolean;
  isInputDisabled: boolean;
  hybridInputEnabled: boolean;
  hybridInputAutoFocus: boolean;
}): TerminalFocusTarget {
  if (
    options.hasHybridInputSurface &&
    !options.isInputDisabled &&
    options.hybridInputEnabled &&
    options.hybridInputAutoFocus
  ) {
    return "hybridInput";
  }
  return "xterm";
}

/**
 * Determines whether a pointerdown event on the xterm area should be
 * suppressed to prevent it from reaching xterm.js during a focus-acquiring
 * click. Returns the focus target to use after suppression, or false if the
 * event should pass through normally.
 */
export function shouldSuppressUnfocusedClick(options: {
  location: string;
  isFocused: boolean;
  isCursorPointer: boolean;
  focusTarget: TerminalFocusTarget;
}): TerminalFocusTarget | false {
  if (options.location !== "grid") return false;
  if (options.isFocused) return false;
  if (options.isCursorPointer) return false;
  return options.focusTarget;
}
