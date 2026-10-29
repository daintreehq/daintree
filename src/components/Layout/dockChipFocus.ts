/**
 * The panel behind the dock chip holding keyboard focus, if any: the sortable id
 * its slot carries, which names one of the chip's members. Focusing a chip
 * doesn't open its preview, so a chip reached by Tab or the rail's arrow keys
 * never owns `focusedId`; a move keybinding pressed on it reads it from the DOM.
 */
export function getFocusedDockChipPanelId(): string | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !active.hasAttribute("data-dock-item")) return null;
  return active.closest<HTMLElement>("[data-dock-item-id]")?.dataset.dockItemId ?? null;
}
