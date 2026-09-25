import { describe, expect, it } from "vitest";
import { fleetExitChordLabel } from "@/components/Fleet/fleetKeys";
import { pilotParkKeys } from "@/components/Pilot/pilotKeys";
import { daintreeTourShortcuts } from "../daintreeTourShortcuts";
import { tourKeycaps, tourShortcutHint } from "../tourKeys";

describe("daintreeTourShortcuts", () => {
  it("draws the app's own labels for the chrome shortcuts it has no keybinding for", () => {
    for (const keyboard of ["mac", "pc"] as const) {
      const shortcuts = daintreeTourShortcuts(keyboard);
      expect(shortcuts.keyboard).toBe(keyboard);
      expect(shortcuts.hint("fleet.exit")).toBe(fleetExitChordLabel(keyboard === "mac"));
      expect(shortcuts.hint("pilot.park")).toBe(pilotParkKeys(keyboard === "mac"));
    }
    expect(daintreeTourShortcuts("mac").keycaps("pilot.park")).toEqual(["⌥", "↵"]);
    expect(daintreeTourShortcuts("pc").keycaps("pilot.park")).toEqual(["Alt", "↵"]);
  });

  it("draws every other shortcut from its default keybinding", () => {
    for (const keyboard of ["mac", "pc"] as const) {
      const shortcuts = daintreeTourShortcuts(keyboard);
      expect(shortcuts.hint("terminal.new")).toBe(tourShortcutHint("terminal.new", keyboard));
      expect(shortcuts.keycaps("action.palette.open")).toEqual(
        tourKeycaps("action.palette.open", keyboard)
      );
    }
  });
});
