/**
 * Marks a palette's surface. While it is closing (`aria-modal` no longer
 * "true") its controls are on their way out, so a surface opened from one is
 * recorded against whatever opened the palette instead.
 */
export const APP_PALETTE_SURFACE_ATTR = "data-app-palette-surface";

// Per opening, and kept through the exit: the palette clears its own record
// when it restores, which can be before a dialog it spawned reads this.
const paletteOpeners = new WeakMap<Element, HTMLElement | null>();

export function recordPaletteOpener(surface: Element, opener: HTMLElement | null): void {
  paletteOpeners.set(surface, opener);
}

function closingPaletteOpener(el: HTMLElement): HTMLElement | null {
  const surface = el.closest(`[${APP_PALETTE_SURFACE_ATTR}]`);
  if (!surface || surface.getAttribute("aria-modal") === "true") return null;
  return paletteOpeners.get(surface) ?? null;
}

/**
 * The element to hand focus back to for a surface opened from `active`. A
 * surface opened from a menu item is recorded against the menu's trigger: the
 * item's select handler runs before the menu closes, so the item still holds
 * focus when the opener is read, and it unmounts with the menu, which would
 * leave the close nothing to restore to. A palette that runs a command and
 * closes leaves the same thing behind in its search field.
 */
export function resolveFocusOpener(active: HTMLElement | null): HTMLElement | null {
  let opener = active;
  // A submenu is labelled by its sub-trigger, itself an item of the parent
  // menu; a palette can be opened from a menu item and the other way round.
  for (let depth = 0; depth < 6 && opener; depth++) {
    const triggerId = opener.closest('[role="menu"]')?.getAttribute("aria-labelledby");
    const next =
      (triggerId ? document.getElementById(triggerId) : null) ?? closingPaletteOpener(opener);
    if (!next || next === opener) break;
    opener = next;
  }
  return opener;
}
