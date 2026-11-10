import type { TourShortcuts } from "@daintreehq/tour/kit";
import { fleetExitChordLabel } from "@/components/Fleet/fleetKeys";
import { PILOT_PARK_COMBO } from "@/components/Pilot/pilotKeys";
import type { KeyLabels } from "@/lib/keyboardLayout";
import { tourKeycaps, tourShortcutHint, type TourKeyboard } from "./tourKeys";

/**
 * Shortcuts the app draws from its own label helpers rather than a default
 * keybinding, so the scene shows exactly what the real chrome does.
 */
const APP_LABELS: Readonly<Record<string, (mac: boolean) => string>> = {
  "fleet.exit": fleetExitChordLabel,
};

/**
 * Chrome chords the app names by a fixed combo rather than a keybinding. They
 * draw through the same keycaps as every other shortcut, so the scene follows
 * the platform and the keyboard layout the way the real footer does.
 */
const APP_COMBOS: Readonly<Record<string, string>> = {
  "pilot.park": PILOT_PARK_COMBO,
};

function appLabel(shortcut: string, mac: boolean): string | undefined {
  return Object.hasOwn(APP_LABELS, shortcut) ? APP_LABELS[shortcut]!(mac) : undefined;
}

function appCombo(shortcut: string): string {
  return Object.hasOwn(APP_COMBOS, shortcut) ? APP_COMBOS[shortcut]! : shortcut;
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
    hint: (shortcut) =>
      appLabel(shortcut, mac) ?? tourShortcutHint(appCombo(shortcut), keyboard, keyLabels),
    keycaps: (shortcut) => tourKeycaps(appCombo(shortcut), keyboard, keyLabels),
  };
}
