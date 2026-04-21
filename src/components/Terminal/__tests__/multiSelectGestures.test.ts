import { describe, it, expect } from "vitest";
import { decideChromeAction } from "../multiSelectGestures";

const noMods = { shiftKey: false, metaKey: false, ctrlKey: false };

describe("decideChromeAction", () => {
  it("returns none for ineligible panes regardless of modifiers", () => {
    expect(
      decideChromeAction(
        { ...noMods, metaKey: true },
        { isEligible: false, isArmed: true, orderedEligibleIds: ["a", "b"] }
      )
    ).toEqual({ type: "none" });
    expect(
      decideChromeAction(
        { ...noMods, shiftKey: true },
        { isEligible: false, isArmed: false, orderedEligibleIds: ["a", "b"] }
      )
    ).toEqual({ type: "none" });
  });

  it("shift-click with an ordered list extends the selection across grid order", () => {
    expect(
      decideChromeAction(
        { ...noMods, shiftKey: true },
        { isEligible: true, isArmed: false, orderedEligibleIds: ["a", "b", "c"] }
      )
    ).toEqual({ type: "extend" });
  });

  it("shift-click without an ordered list falls back to toggle", () => {
    expect(
      decideChromeAction({ ...noMods, shiftKey: true }, { isEligible: true, isArmed: false })
    ).toEqual({ type: "toggle" });
  });

  it("shift-click with an empty ordered list falls back to toggle", () => {
    expect(
      decideChromeAction(
        { ...noMods, shiftKey: true },
        { isEligible: true, isArmed: false, orderedEligibleIds: [] }
      )
    ).toEqual({ type: "toggle" });
  });

  it("⌘-click on an eligible pane toggles fleet selection", () => {
    expect(
      decideChromeAction({ ...noMods, metaKey: true }, { isEligible: true, isArmed: false })
    ).toEqual({ type: "toggle" });
  });

  it("Ctrl-click on an eligible pane toggles fleet selection", () => {
    expect(
      decideChromeAction({ ...noMods, ctrlKey: true }, { isEligible: true, isArmed: false })
    ).toEqual({ type: "toggle" });
  });

  it("plain click on an armed eligible pane bumps the primary anchor", () => {
    expect(decideChromeAction(noMods, { isEligible: true, isArmed: true })).toEqual({
      type: "bump-primary",
    });
  });

  it("plain click on an unarmed eligible pane does nothing special (caller focuses)", () => {
    expect(decideChromeAction(noMods, { isEligible: true, isArmed: false })).toEqual({
      type: "none",
    });
  });

  it("shift wins over ⌘/Ctrl when both are held (shift is the primary multi-select gesture)", () => {
    expect(
      decideChromeAction(
        { shiftKey: true, metaKey: true, ctrlKey: false },
        { isEligible: true, isArmed: false, orderedEligibleIds: ["a", "b"] }
      )
    ).toEqual({ type: "extend" });
    expect(
      decideChromeAction(
        { shiftKey: true, metaKey: false, ctrlKey: true },
        { isEligible: true, isArmed: true, orderedEligibleIds: ["a", "b"] }
      )
    ).toEqual({ type: "extend" });
  });
});
