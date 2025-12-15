export type TerminalFocusTarget = "hybridInput" | "xterm";

export function getTerminalFocusTarget(options: {
  isAgentTerminal: boolean;
  isInputDisabled: boolean;
}): TerminalFocusTarget {
  if (options.isAgentTerminal && !options.isInputDisabled) {
    return "hybridInput";
  }
  return "xterm";
}
