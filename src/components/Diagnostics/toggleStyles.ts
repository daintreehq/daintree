/**
 * The pressed look for the diagnostics tabs' toggle and filter buttons (on top
 * of `Button variant="subtle"`), matching the app's other filter chips
 * (`WorktreeFilterPopover`, `NotificationCenter`): the filter-selected fill,
 * medium weight, and a text-secondary edge. Neutral on purpose: several can be
 * on at once, which rules out accent, and `aria-pressed` carries the state for
 * AT. Filter chips also set `data-filter-chip="true"`, the hook the
 * forced-colors and prefers-contrast rules in `index.css` redraw them from.
 */
export const PRESSED_TOGGLE =
  "bg-filter-selected-bg-strong font-medium text-text-primary ring-text-secondary";
