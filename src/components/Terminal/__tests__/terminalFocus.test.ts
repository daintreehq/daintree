import { describe, it, expect } from "vitest";
import { getTerminalFocusTarget } from "../terminalFocus";

describe("getTerminalFocusTarget", () => {
  it("focuses hybrid input for enabled agent terminals", () => {
    expect(
      getTerminalFocusTarget({
        hasChromeAgentIdentity: true,
        isInputDisabled: false,
        hybridInputEnabled: true,
        hybridInputAutoFocus: true,
      })
    ).toBe("hybridInput");
  });

  it("falls back to xterm when input is disabled", () => {
    expect(
      getTerminalFocusTarget({
        hasChromeAgentIdentity: true,
        isInputDisabled: true,
        hybridInputEnabled: true,
        hybridInputAutoFocus: true,
      })
    ).toBe("xterm");
  });

  it("focuses xterm for non-agent terminals", () => {
    expect(
      getTerminalFocusTarget({
        hasChromeAgentIdentity: false,
        isInputDisabled: false,
        hybridInputEnabled: true,
        hybridInputAutoFocus: true,
      })
    ).toBe("xterm");
  });

  // #5804 regression: an observational shell (plain terminal where an agent
  // was runtime-detected) must NOT focus the hybrid input — the bar isn't
  // rendered for it, so suppressing xterm focus would swallow clicks with no
  // effect. Capability mode is sealed at spawn; runtime detection can flip
  // chrome-facing fields (icon, badge) but not capability.
  it("focuses xterm for observational shells with no full capability", () => {
    expect(
      getTerminalFocusTarget({
        hasChromeAgentIdentity: false,
        isInputDisabled: false,
        hybridInputEnabled: true,
        hybridInputAutoFocus: true,
      })
    ).toBe("xterm");
  });

  it("focuses xterm when hybrid input is disabled", () => {
    expect(
      getTerminalFocusTarget({
        hasChromeAgentIdentity: true,
        isInputDisabled: false,
        hybridInputEnabled: false,
        hybridInputAutoFocus: true,
      })
    ).toBe("xterm");
  });

  it("focuses xterm when hybrid input auto-focus is disabled", () => {
    expect(
      getTerminalFocusTarget({
        hasChromeAgentIdentity: true,
        isInputDisabled: false,
        hybridInputEnabled: true,
        hybridInputAutoFocus: false,
      })
    ).toBe("xterm");
  });
});
