import { describe, it, expect } from "vitest";
import { shouldSuppressUnfocusedClick } from "../terminalFocus";

describe("shouldSuppressUnfocusedClick", () => {
  it("suppresses click on unfocused xterm grid panel", () => {
    expect(
      shouldSuppressUnfocusedClick({
        location: "grid",
        isFocused: false,
        isCursorPointer: false,
        focusTarget: "xterm",
      })
    ).toBe("xterm");
  });

  it("suppresses click on unfocused hybridInput grid panel", () => {
    expect(
      shouldSuppressUnfocusedClick({
        location: "grid",
        isFocused: false,
        isCursorPointer: false,
        focusTarget: "hybridInput",
      })
    ).toBe("hybridInput");
  });

  it("passes through when panel is already focused", () => {
    expect(
      shouldSuppressUnfocusedClick({
        location: "grid",
        isFocused: true,
        isCursorPointer: false,
        focusTarget: "xterm",
      })
    ).toBe(false);
  });

  it("passes through for dock location", () => {
    expect(
      shouldSuppressUnfocusedClick({
        location: "dock",
        isFocused: false,
        isCursorPointer: false,
        focusTarget: "xterm",
      })
    ).toBe(false);
  });

  it("passes through when xterm-cursor-pointer is active (URL link click)", () => {
    expect(
      shouldSuppressUnfocusedClick({
        location: "grid",
        isFocused: false,
        isCursorPointer: true,
        focusTarget: "xterm",
      })
    ).toBe(false);
  });

  it("passes through cursor-pointer even for hybridInput focus target", () => {
    expect(
      shouldSuppressUnfocusedClick({
        location: "grid",
        isFocused: false,
        isCursorPointer: true,
        focusTarget: "hybridInput",
      })
    ).toBe(false);
  });
});
