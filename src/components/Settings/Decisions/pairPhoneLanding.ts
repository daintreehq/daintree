import { landOnSettingsElement } from "@/components/Settings/settingsLanding";

export const DEVICES_SECTION_ID = "decisions-devices";
export const PAIR_BUTTON_ATTR = "data-decisions-pair-phone";

/** The Pair a phone button on screen now: the empty row's, or the header's once a device is listed. */
export function currentPairButton(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`#${DEVICES_SECTION_ID} [${PAIR_BUTTON_ATTR}]`);
}

/** Takes the person on to pairing a phone: Devices in view, its Pair a phone button focused. */
export function landOnPairPhone(): void {
  const section = document.getElementById(DEVICES_SECTION_ID);
  if (!section) return;
  landOnSettingsElement(section);
  currentPairButton()?.focus({ preventScroll: true });
}
