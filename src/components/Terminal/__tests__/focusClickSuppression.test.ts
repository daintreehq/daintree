import { describe, it, expect } from "vitest";
import { isLikelyAtSynthesizedPointer, shouldSuppressUnfocusedClick } from "../terminalFocus";

describe("shouldSuppressUnfocusedClick", () => {
  it("suppresses click on unfocused xterm grid panel", () => {
    expect(
      shouldSuppressUnfocusedClick({
        location: "grid",
        isFocused: false,
        isCursorPointer: false,
        isShiftKey: false,
      })
    ).toBe(true);
  });

  it("passes through when panel is already focused", () => {
    expect(
      shouldSuppressUnfocusedClick({
        location: "grid",
        isFocused: true,
        isCursorPointer: false,
        isShiftKey: false,
      })
    ).toBe(false);
  });

  it("passes through for dock location", () => {
    expect(
      shouldSuppressUnfocusedClick({
        location: "dock",
        isFocused: false,
        isCursorPointer: false,
        isShiftKey: false,
      })
    ).toBe(false);
  });

  it("passes through when xterm-cursor-pointer is active (URL link click)", () => {
    expect(
      shouldSuppressUnfocusedClick({
        location: "grid",
        isFocused: false,
        isCursorPointer: true,
        isShiftKey: false,
      })
    ).toBe(false);
  });

  it("passes through shift+click on unfocused grid pane — xterm uses shift to bypass PTY mouse reporting", () => {
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

describe("AT-synthesized vs physical suppression on unfocused panes", () => {
  // A suppressed unfocused click only stops propagation / captures the pointer
  // when the click is a physical one (preceded by movement). When the click is
  // likely AT cursor routing, the pane still activates but the event is allowed
  // to reach xterm for cursor positioning.
  it("a physical click (recent move) is still fully suppressed", () => {
    const suppress = shouldSuppressUnfocusedClick({
      location: "grid",
      isFocused: false,
      isCursorPointer: false,
      isShiftKey: false,
    });
    const atSynthesized = isLikelyAtSynthesizedPointer(1000, 1016);
    expect(suppress && !atSynthesized).toBe(true);
  });

  it("an AT-routed click (no preceding move) skips capture/stopPropagation", () => {
    const suppress = shouldSuppressUnfocusedClick({
      location: "grid",
      isFocused: false,
      isCursorPointer: false,
      isShiftKey: false,
    });
    const atSynthesized = isLikelyAtSynthesizedPointer(null, 1000);
    expect(suppress && atSynthesized).toBe(true);
  });
});
