import { describe, it, expect } from "vitest";
import { decideChromeAction } from "../multiSelectGestures";

const noMods = { shiftKey: false, metaKey: false, ctrlKey: false };

describe("decideChromeAction", () => {
  it("shift-click on an eligible pane toggles membership (additive single add)", () => {
    expect(
      decideChromeAction(
        { ...noMods, shiftKey: true },
        { isEligible: true, isArmed: false, armedSize: 0 }
      )
    ).toEqual({ type: "toggle" });
    expect(
      decideChromeAction(
        { ...noMods, shiftKey: true },
        { isEligible: true, isArmed: true, armedSize: 2 }
      )
    ).toEqual({ type: "toggle" });
  });

  it("⌘-click on an eligible pane toggles membership", () => {
    expect(
      decideChromeAction(
        { ...noMods, metaKey: true },
        { isEligible: true, isArmed: false, armedSize: 0 }
      )
    ).toEqual({ type: "toggle" });
  });

  it("Ctrl-click on an eligible pane toggles membership", () => {
    expect(
      decideChromeAction(
        { ...noMods, ctrlKey: true },
        { isEligible: true, isArmed: false, armedSize: 0 }
      )
    ).toEqual({ type: "toggle" });
  });

  it("modifier-click on an ineligible pane does nothing", () => {
    expect(
      decideChromeAction(
        { ...noMods, shiftKey: true },
        { isEligible: false, isArmed: false, armedSize: 2 }
      )
    ).toEqual({ type: "none" });
    expect(
      decideChromeAction(
        { ...noMods, metaKey: true },
        { isEligible: false, isArmed: true, armedSize: 2 }
      )
    ).toEqual({ type: "none" });
  });

  it("plain click with a non-empty fleet clears it (exclusive single-select behavior)", () => {
    expect(decideChromeAction(noMods, { isEligible: true, isArmed: true, armedSize: 2 })).toEqual({
      type: "clear",
    });
    expect(decideChromeAction(noMods, { isEligible: true, isArmed: false, armedSize: 3 })).toEqual({
      type: "clear",
    });
  });

  it("plain click on an ineligible pane still clears the fleet when non-empty", () => {
    expect(decideChromeAction(noMods, { isEligible: false, isArmed: false, armedSize: 2 })).toEqual(
      { type: "clear" }
    );
  });

  it("plain click with an empty fleet does nothing (caller focuses)", () => {
    expect(decideChromeAction(noMods, { isEligible: true, isArmed: false, armedSize: 0 })).toEqual({
      type: "none",
    });
  });
});
