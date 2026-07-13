import { describe, it, expect } from "vitest";
import {
  getTerminalFocusTarget,
  isLikelyAtSynthesizedPointer,
  resolvePaneFocusAction,
  shouldShowHybridInputBar,
  shouldSuppressUnfocusedClick,
} from "../terminalFocus";

/**
 * The selection guard used to be unconditional: any selection in the pane's
 * xterm cancelled the focus handoff outright. That stranded the keyboard on the
 * pane the user had just left whenever the destination happened to be holding an
 * old selection — highlight on one pane, keystrokes into another (#11133).
 */
describe("resolvePaneFocusAction", () => {
  it("keeps focus in xterm when it holds both the selection and the keyboard", () => {
    expect(
      resolvePaneFocusAction({
        focusTarget: "hybridInput",
        hasSelection: true,
        xtermOwnsDomFocus: true,
      })
    ).toBe("preserve");
  });

  it("hands off to the input bar when the selection sits in an unfocused xterm", () => {
    // The pane is being focused from somewhere else, so this xterm is already
    // blurred — its selection is inert and cannot be disturbed by the handoff.
    expect(
      resolvePaneFocusAction({
        focusTarget: "hybridInput",
        hasSelection: true,
        xtermOwnsDomFocus: false,
      })
    ).toBe("hybridInput");
  });

  it("hands off to the input bar when xterm has focus but no selection", () => {
    expect(
      resolvePaneFocusAction({
        focusTarget: "hybridInput",
        hasSelection: false,
        xtermOwnsDomFocus: true,
      })
    ).toBe("hybridInput");
  });

  it("hands off to the input bar when the pane holds neither", () => {
    expect(
      resolvePaneFocusAction({
        focusTarget: "hybridInput",
        hasSelection: false,
        xtermOwnsDomFocus: false,
      })
    ).toBe("hybridInput");
  });

  it("never preserves when the resolved target is xterm itself", () => {
    // A selection is not a reason to skip focusing xterm — that would leave the
    // keyboard wherever it was.
    for (const hasSelection of [true, false]) {
      for (const xtermOwnsDomFocus of [true, false]) {
        expect(
          resolvePaneFocusAction({ focusTarget: "xterm", hasSelection, xtermOwnsDomFocus })
        ).toBe("xterm");
      }
    }
  });
});

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
