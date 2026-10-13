import { afterEach, describe, expect, it, vi } from "vitest";
import * as platform from "@/lib/platform";
import { fleetExitChordLabel } from "@/components/Fleet/fleetKeys";
import { pilotParkKeys } from "@/components/Pilot/pilotKeys";
import { daintreeTourShortcuts } from "../daintreeTourShortcuts";
import { tourCombo, tourKeycaps, tourShortcutHint } from "../tourKeys";

vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isLinux: vi.fn(() => false),
}));

afterEach(() => {
  vi.mocked(platform.isLinux).mockReturnValue(false);
});

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

  // Linux replaces New terminal's Ctrl+Alt+T, which the desktop opens its own
  // terminal on. The keycaps follow; the spoken "pc" recording can't.
  it("draws Linux's own default on Linux, leaving the spoken combo shared", () => {
    const shared = tourShortcutHint("terminal.new", "pc");
    const mac = tourKeycaps("terminal.new", "mac");
    vi.mocked(platform.isLinux).mockReturnValue(true);
    expect(tourKeycaps("terminal.new", "pc")).toEqual(["Ctrl", "Shift", "Alt", "T"]);
    expect(tourShortcutHint("terminal.new", "pc")).not.toBe(shared);
    expect(tourKeycaps("terminal.new", "mac")).toEqual(mac);
    expect(tourCombo("terminal.new")).toBe("Cmd+Alt+T");
  });
});
