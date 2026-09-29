import type { TourShortcuts } from "@daintreehq/tour/kit";
import { fleetExitChordLabel } from "@/components/Fleet/fleetKeys";
import { pilotParkKeys } from "@/components/Pilot/pilotKeys";
import { tourKeycaps, tourShortcutHint, type TourKeyboard } from "./tourKeys";

/**
 * Shortcuts the app draws from its own label helpers rather than a default
 * keybinding, so the scene shows exactly what the real chrome does.
 */
const APP_LABELS: Readonly<Record<string, (mac: boolean) => string>> = {
  "fleet.exit": fleetExitChordLabel,
  "pilot.park": pilotParkKeys,
};

function appLabel(shortcut: string, mac: boolean): string | undefined {
  return Object.hasOwn(APP_LABELS, shortcut) ? APP_LABELS[shortcut]!(mac) : undefined;
}

/** The built-in tour's shortcuts, handed to its scenes through the mockup kit. */
export function daintreeTourShortcuts(keyboard: TourKeyboard): TourShortcuts {
  const mac = keyboard === "mac";
  return {
    keyboard,
    hint: (shortcut) => appLabel(shortcut, mac) ?? tourShortcutHint(shortcut, keyboard),
    keycaps: (shortcut) => {
      const label = appLabel(shortcut, mac);
      if (label === undefined) return tourKeycaps(shortcut, keyboard);
      // The label's own keys ("⌥↵", "Alt+↵"), one cap each.
      return mac ? Array.from(label) : label.split("+");
    },
  };
}
