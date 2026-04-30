import { describe, it, expect } from "vitest";
import { getTerminalFocusTarget, shouldShowHybridInputBar } from "../terminalFocus";

describe("shouldShowHybridInputBar", () => {
  it("shows for agent terminals when enabled", () => {
    expect(
      shouldShowHybridInputBar({
        hasAgentIdentity: true,
        hybridInputEnabled: true,
        isFleetArmed: false,
        fleetSize: 0,
      })
    ).toBe(true);
  });

  it("shows for normal terminals only while they are in a 2+ Fleet", () => {
    expect(
      shouldShowHybridInputBar({
        hasAgentIdentity: false,
        hybridInputEnabled: true,
        isFleetArmed: true,
        fleetSize: 2,
      })
    ).toBe(true);
    expect(
      shouldShowHybridInputBar({
        hasAgentIdentity: false,
        hybridInputEnabled: true,
        isFleetArmed: true,
        fleetSize: 1,
      })
    ).toBe(false);
  });

  it("hides when hybrid input is disabled", () => {
    expect(
      shouldShowHybridInputBar({
        hasAgentIdentity: true,
        hybridInputEnabled: false,
        isFleetArmed: true,
        fleetSize: 2,
      })
    ).toBe(false);
  });
});

describe("getTerminalFocusTarget", () => {
  it("focuses hybrid input for enabled agent terminals", () => {
    expect(
      getTerminalFocusTarget({
        hasHybridInputSurface: true,
        isInputDisabled: false,
        hybridInputEnabled: true,
        hybridInputAutoFocus: true,
      })
    ).toBe("hybridInput");
  });

  it("falls back to xterm when input is disabled", () => {
    expect(
      getTerminalFocusTarget({
        hasHybridInputSurface: true,
        isInputDisabled: true,
        hybridInputEnabled: true,
        hybridInputAutoFocus: true,
      })
    ).toBe("xterm");
  });

  it("focuses xterm when no hybrid input surface is mounted", () => {
    expect(
      getTerminalFocusTarget({
        hasHybridInputSurface: false,
        isInputDisabled: false,
        hybridInputEnabled: true,
        hybridInputAutoFocus: true,
      })
    ).toBe("xterm");
  });

  it("focuses hybrid input for normal terminals when Fleet mounts the bar", () => {
    expect(
      getTerminalFocusTarget({
        hasHybridInputSurface: true,
        isInputDisabled: false,
        hybridInputEnabled: true,
        hybridInputAutoFocus: true,
      })
    ).toBe("hybridInput");
  });

  it("focuses xterm when hybrid input is disabled", () => {
    expect(
      getTerminalFocusTarget({
        hasHybridInputSurface: true,
        isInputDisabled: false,
        hybridInputEnabled: false,
        hybridInputAutoFocus: true,
      })
    ).toBe("xterm");
  });

  it("focuses xterm when hybrid input auto-focus is disabled", () => {
    expect(
      getTerminalFocusTarget({
        hasHybridInputSurface: true,
        isInputDisabled: false,
        hybridInputEnabled: true,
        hybridInputAutoFocus: false,
      })
    ).toBe("xterm");
  });
});
