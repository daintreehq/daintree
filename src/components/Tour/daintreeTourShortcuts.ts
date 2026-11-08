import type { TourShortcuts } from "@daintreehq/tour/kit";
import { fleetExitChordLabel } from "@/components/Fleet/fleetKeys";
import { pilotParkKeys } from "@/components/Pilot/pilotKeys";
import type { KeyLabels } from "@/lib/keyboardLayout";
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

/**
 * The built-in tour's shortcuts, handed to its scenes through the mockup kit.
 * The caps follow the keyboard layout like the app's own chips; the narration
 * is prerecorded and keeps naming the US keys.
 */
export function daintreeTourShortcuts(
  keyboard: TourKeyboard,
  keyLabels?: KeyLabels
): TourShortcuts {
  const mac = keyboard === "mac";
  return {
    keyboard,
    hint: (shortcut) => appLabel(shortcut, mac) ?? tourShortcutHint(shortcut, keyboard, keyLabels),
    keycaps: (shortcut) => {
      const label = appLabel(shortcut, mac);
      if (label === undefined) return tourKeycaps(shortcut, keyboard, keyLabels);
      // The label's own keys ("⌥↵", "Alt+↵"), one cap each.
      return mac ? Array.from(label) : label.split("+");
    },
  };
}
