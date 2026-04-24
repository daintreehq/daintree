export type TerminalFocusTarget = "hybridInput" | "xterm";

/**
 * Resolve which child component should receive focus when the terminal pane
 * gains focus.
 *
 * Under the unified identity model (see
 * `docs/architecture/terminal-identity.md`), there is no "full capability"
 * vs "observational" distinction — the HybridInputBar is available whenever
 * chrome identity resolves to an agent. `hasChromeAgentIdentity` is the
 * caller's computed `resolveChromeAgentId(...) !== undefined`: this
 * covers both a live-detected agent and the boot-window launch hint.
 */
export function getTerminalFocusTarget(options: {
  hasChromeAgentIdentity: boolean;
  isInputDisabled: boolean;
  hybridInputEnabled: boolean;
  hybridInputAutoFocus: boolean;
}): TerminalFocusTarget {
  if (
    options.hasChromeAgentIdentity &&
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
