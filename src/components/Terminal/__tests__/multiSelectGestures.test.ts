import { describe, it, expect } from "vitest";
import { decideChromeAction, decideSelectHandleAction } from "../multiSelectGestures";

const noMods = { shiftKey: false, metaKey: false, ctrlKey: false };

describe("decideSelectHandleAction", () => {
  it("plain click toggles the target", () => {
    expect(decideSelectHandleAction(noMods, ["a", "b"])).toEqual({ type: "toggle" });
  });

  it("shift-click with an ordered list extends the selection", () => {
    expect(decideSelectHandleAction({ ...noMods, shiftKey: true }, ["a", "b", "c"])).toEqual({
      type: "extend",
    });
  });

  it("shift-click without an ordered list falls back to toggle", () => {
    expect(decideSelectHandleAction({ ...noMods, shiftKey: true }, undefined)).toEqual({
      type: "toggle",
    });
  });

  it("shift-click with an empty ordered list falls back to toggle", () => {
    expect(decideSelectHandleAction({ ...noMods, shiftKey: true }, [])).toEqual({ type: "toggle" });
  });

  it("⌘/Ctrl on the handle are treated as plain toggle (no modifier semantics on the handle)", () => {
    expect(decideSelectHandleAction({ ...noMods, metaKey: true }, ["a"])).toEqual({
      type: "toggle",
    });
    expect(decideSelectHandleAction({ ...noMods, ctrlKey: true }, ["a"])).toEqual({
      type: "toggle",
    });
  });
});

describe("decideChromeAction", () => {
  it("returns none for ineligible panes regardless of modifiers", () => {
    expect(
      decideChromeAction({ ...noMods, metaKey: true }, { isEligible: false, isArmed: true })
    ).toEqual({ type: "none" });
    expect(
      decideChromeAction({ ...noMods, shiftKey: true }, { isEligible: false, isArmed: false })
    ).toEqual({ type: "none" });
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

  it("shift-click on chrome no longer mutates fleet selection (reserved for xterm)", () => {
    expect(
      decideChromeAction({ ...noMods, shiftKey: true }, { isEligible: true, isArmed: false })
    ).toEqual({ type: "none" });
    expect(
      decideChromeAction({ ...noMods, shiftKey: true }, { isEligible: true, isArmed: true })
    ).toEqual({ type: "bump-primary" });
  });
});
