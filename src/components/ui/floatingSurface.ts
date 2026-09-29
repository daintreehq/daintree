/**
 * Elevation for anything that floats over app content without being a
 * popover: toasts, the re-entry summary, find bars, the scroll pill, the
 * artifact overlay, the getting-started checklist, and the side sheets that
 * slide over the workspace. Popovers and menus keep `surface-overlay
 * shadow-overlay` (popover.tsx); this is the other half of the family.
 *
 * Shadows always come from theme tokens, never Tailwind's stock `shadow-*`
 * scale: that scale is pure black, while the theme tokens give light themes
 * their cool-slate shadow source. `component-contract/no-raw-shadow` enforces
 * it.
 */

/** One radius for every floating card, matching the popover it sits beside. */
export const FLOATING_CARD_RADIUS_CLASS = "rounded-[var(--radius-lg)]";

/** Fill, edge and shadow, without the radius (the scroll pill is a full pill). */
export const FLOATING_CARD_SURFACE_CLASS =
  "border border-border-default bg-surface-panel-elevated shadow-[var(--theme-shadow-floating)]";

/** The whole floating-card chrome. Placement and stacking stay with each host. */
export const FLOATING_CARD_CLASS = `${FLOATING_CARD_RADIUS_CLASS} ${FLOATING_CARD_SURFACE_CLASS}`;

/**
 * A full-height sheet that overlays the workspace (Portal, Theme Browser). It
 * sits at dialog depth. A docked panel that pushes content aside, like the
 * assistant, takes only its border: it does not float, so it casts nothing.
 */
export const OVERLAY_SHEET_SHADOW_CLASS = "shadow-[var(--theme-shadow-dialog)]";
