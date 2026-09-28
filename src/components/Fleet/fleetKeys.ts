/** The ribbon's exit chord, as a canonical combo for `KbdChord`. */
export const FLEET_EXIT_COMBO = "Cmd+Escape";

/** The exit chord as the Daintree Tour's mock-up of the ribbon labels it. */
export function fleetExitChordLabel(mac: boolean): string {
  return mac ? "⌘Esc" : "Ctrl+Esc";
}
