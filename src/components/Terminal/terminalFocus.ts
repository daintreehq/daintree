export type TerminalFocusTarget = "hybridInput" | "xterm";

export function getTerminalFocusTarget(options: {
  isAgentTerminal: boolean;
  isInputDisabled: boolean;
  hybridInputEnabled: boolean;
  hybridInputAutoFocus: boolean;
}): TerminalFocusTarget {
  if (
    options.isAgentTerminal &&
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
