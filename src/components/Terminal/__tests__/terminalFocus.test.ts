import { describe, it, expect } from "vitest";
import {
  getTerminalFocusTarget,
  isLikelyAtSynthesizedPointer,
  resolveTerminalTabEscape,
  shouldShowHybridInputBar,
  shouldSuppressUnfocusedClick,
} from "../terminalFocus";

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
  it("honors a hybridInput preference when the surface is available", () => {
    expect(
      getTerminalFocusTarget({
        preferredTarget: "hybridInput",
        hasHybridInputSurface: true,
        isInputDisabled: false,
        hybridInputEnabled: true,
      })
    ).toBe("hybridInput");
  });

  it("honors an xterm preference even when the surface exists", () => {
    expect(
      getTerminalFocusTarget({
        preferredTarget: "xterm",
        hasHybridInputSurface: true,
        isInputDisabled: false,
        hybridInputEnabled: true,
      })
    ).toBe("xterm");
  });

  it("falls back to xterm when input is disabled despite preferring hybridInput", () => {
    expect(
      getTerminalFocusTarget({
        preferredTarget: "hybridInput",
        hasHybridInputSurface: true,
        isInputDisabled: true,
        hybridInputEnabled: true,
      })
    ).toBe("xterm");
  });

  it("falls back to xterm when no hybrid input surface is mounted", () => {
    expect(
      getTerminalFocusTarget({
        preferredTarget: "hybridInput",
        hasHybridInputSurface: false,
        isInputDisabled: false,
        hybridInputEnabled: true,
      })
    ).toBe("xterm");
  });

  it("falls back to xterm when hybrid input is disabled globally", () => {
    expect(
      getTerminalFocusTarget({
        preferredTarget: "hybridInput",
        hasHybridInputSurface: true,
        isInputDisabled: false,
        hybridInputEnabled: false,
      })
    ).toBe("xterm");
  });
});

describe("shouldSuppressUnfocusedClick", () => {
  it("suppresses an unfocused grid click on a non-pointer cell", () => {
    expect(
      shouldSuppressUnfocusedClick({
        location: "grid",
        isFocused: false,
        isCursorPointer: false,
        isShiftKey: false,
      })
    ).toBe(true);
  });

  it("does not suppress when the pane is already focused — the click should pass through to xterm", () => {
    expect(
      shouldSuppressUnfocusedClick({
        location: "grid",
        isFocused: true,
        isCursorPointer: false,
        isShiftKey: false,
      })
    ).toBe(false);
  });

  it("does not suppress on link/cursor-pointer cells so the link click registers", () => {
    expect(
      shouldSuppressUnfocusedClick({
        location: "grid",
        isFocused: false,
        isCursorPointer: true,
        isShiftKey: false,
      })
    ).toBe(false);
  });

  it("does not suppress in dock — popovers handle focus differently", () => {
    expect(
      shouldSuppressUnfocusedClick({
        location: "dock",
        isFocused: false,
        isCursorPointer: false,
        isShiftKey: false,
      })
    ).toBe(false);
  });

  it("does not suppress shift+click — xterm uses shift to bypass PTY mouse reporting for native selection", () => {
    expect(
      shouldSuppressUnfocusedClick({
        location: "grid",
        isFocused: false,
        isCursorPointer: false,
        isShiftKey: true,
      })
    ).toBe(false);
  });
});

describe("isLikelyAtSynthesizedPointer", () => {
  it("treats a pointerdown with no recorded move as AT-synthesized", () => {
    expect(isLikelyAtSynthesizedPointer(null, 1000)).toBe(true);
  });

  it("treats a click shortly after a move as a physical pointer", () => {
    expect(isLikelyAtSynthesizedPointer(1000, 1050)).toBe(false);
  });

  it("treats a move exactly at the threshold as physical (boundary, inclusive)", () => {
    expect(isLikelyAtSynthesizedPointer(1000, 1100)).toBe(false);
  });

  it("treats a click more than the threshold after the last move as AT-synthesized", () => {
    expect(isLikelyAtSynthesizedPointer(1000, 1101)).toBe(true);
  });

  it("honors a custom threshold", () => {
    expect(isLikelyAtSynthesizedPointer(1000, 1030, 20)).toBe(true);
    expect(isLikelyAtSynthesizedPointer(1000, 1010, 20)).toBe(false);
  });
});

describe("resolveTerminalTabEscape", () => {
  const base = {
    key: "Tab",
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    keyCode: 9,
  };

  it("moves to the next region on plain Tab", () => {
    expect(resolveTerminalTabEscape(base)).toBe("next");
  });

  it("moves to the previous region on Shift+Tab", () => {
    expect(resolveTerminalTabEscape({ ...base, shiftKey: true })).toBe("prev");
  });

  it("ignores non-Tab keys", () => {
    expect(resolveTerminalTabEscape({ ...base, key: "Enter" })).toBeNull();
  });

  it("ignores Tab during IME composition", () => {
    expect(resolveTerminalTabEscape({ ...base, isComposing: true })).toBeNull();
    expect(resolveTerminalTabEscape({ ...base, keyCode: 229 })).toBeNull();
  });

  it("ignores Tab combined with Ctrl/Alt/Meta so the TUI or global keybindings handle it", () => {
    expect(resolveTerminalTabEscape({ ...base, ctrlKey: true })).toBeNull();
    expect(resolveTerminalTabEscape({ ...base, altKey: true })).toBeNull();
    expect(resolveTerminalTabEscape({ ...base, metaKey: true })).toBeNull();
  });
});
