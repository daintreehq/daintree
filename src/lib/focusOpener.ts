/**
 * The element to hand focus back to for a surface opened from `active`. A
 * surface opened from a menu item is recorded against the menu's trigger: the
 * item's select handler runs before the menu closes, so the item still holds
 * focus when the opener is read, and it unmounts with the menu, which would
 * leave the close nothing to restore to.
 */
export function resolveFocusOpener(active: HTMLElement | null): HTMLElement | null {
  let opener = active;
  // A submenu is labelled by its sub-trigger, itself an item of the parent menu.
  for (let depth = 0; depth < 4; depth++) {
    const triggerId = opener?.closest('[role="menu"]')?.getAttribute("aria-labelledby");
    const trigger = triggerId ? document.getElementById(triggerId) : null;
    if (!trigger || trigger === opener) break;
    opener = trigger;
  }
  return opener;
}
