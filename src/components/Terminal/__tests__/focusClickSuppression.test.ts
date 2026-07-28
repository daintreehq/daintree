import { describe, it, expect } from "vitest";
import {
  isLikelyAtSynthesizedPointer,
  shouldRecordXtermFocusPreference,
  shouldSuppressUnfocusedClick,
} from "../terminalFocus";

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

describe("recording the xterm focus preference on pointerdown", () => {
  // Only a click that actually reaches xterm is an explicit "I want the
  // terminal" gesture. Inputs are derived through the production classifiers
  // rather than passed as bare booleans, so these cases exercise the real
  // composition the pane handler performs.
  const classify = (options: { location: string; isFocused: boolean; lastMoveAt: number | null }) =>
    shouldRecordXtermFocusPreference({
      isAtSynthesized: isLikelyAtSynthesizedPointer(options.lastMoveAt, 1000),
      shouldSuppress: shouldSuppressUnfocusedClick({
        location: options.location,
        isFocused: options.isFocused,
        isCursorPointer: false,
        isShiftKey: false,
      }),
    });

  it("records for a physical click on an already-focused pane — the click reaches xterm", () => {
    expect(classify({ location: "grid", isFocused: true, lastMoveAt: 990 })).toBe(true);
  });

  it("preserves the remembered target when the same physical click activates an unfocused pane", () => {
    // Identical gesture to the case above; only the pane's focus state differs,
    // which makes the click suppressed and therefore never seen by xterm.
    expect(classify({ location: "grid", isFocused: false, lastMoveAt: 990 })).toBe(false);
  });

  it("preserves the remembered target for AT cursor routing that does reach xterm", () => {
    // Pass-through click (already focused), but with no preceding pointermove:
    // a screen reader reading terminal output must not switch the user's mode.
    expect(classify({ location: "grid", isFocused: true, lastMoveAt: null })).toBe(false);
  });
});
