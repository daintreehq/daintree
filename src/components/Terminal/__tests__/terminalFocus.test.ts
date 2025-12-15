import { describe, it, expect } from "vitest";
import { getTerminalFocusTarget } from "../terminalFocus";

describe("getTerminalFocusTarget", () => {
  it("focuses hybrid input for enabled agent terminals", () => {
    expect(getTerminalFocusTarget({ isAgentTerminal: true, isInputDisabled: false })).toBe(
      "hybridInput"
    );
  });

  it("falls back to xterm when input is disabled", () => {
    expect(getTerminalFocusTarget({ isAgentTerminal: true, isInputDisabled: true })).toBe("xterm");
  });

  it("focuses xterm for non-agent terminals", () => {
    expect(getTerminalFocusTarget({ isAgentTerminal: false, isInputDisabled: false })).toBe(
      "xterm"
    );
  });
});
