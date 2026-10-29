import { flushSync } from "react-dom";

export interface FocusedDockChip {
  element: HTMLElement;
  /** Any member of the chip: the sortable id its slot carries. */
  panelId: string;
}

/**
 * The dock chip holding keyboard focus, if any. Focusing a chip doesn't open
 * its preview, so a chip reached by Tab or the rail's arrow keys never owns
 * `focusedId`; a move keybinding pressed on it has to read it from the DOM.
 */
export function getFocusedDockChip(): FocusedDockChip | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !active.hasAttribute("data-dock-item")) return null;
  const panelId = active.closest<HTMLElement>("[data-dock-item-id]")?.dataset.dockItemId;
  return panelId ? { element: active, panelId } : null;
}

/**
 * Run a reorder that moves `chip` and keep keyboard focus on it. React reorders
 * keyed children with `insertBefore`, and Chromium drops focus from a node it
 * moves, so a chip stepping right would leave focus on <body>. The commit is
 * flushed so focus is back before the next keystroke (a held key repeats) is
 * dispatched.
 */
export function keepDockChipFocus(chip: HTMLElement, reorder: () => void): void {
  flushSync(reorder);
  if (!chip.isConnected) return;
  if (document.activeElement !== chip) chip.focus();
  chip.scrollIntoView({ behavior: "instant", block: "nearest", inline: "nearest" });
}
