// How long the `settings-highlight` pulse stays on the landed-on element before
// the class is removed. Long enough to read, short enough not to draw attention
// after the user has oriented.
export const SETTINGS_HIGHLIGHT_DECAY_MS = 1500;

// The control a landed-on section hands focus to: its setting first (a switch, a
// select, a field), then anything else operable in it. Only looking for an <input>
// left focus stranded in the search box for every switch, select and button row.
const SECTION_CONTROL_SELECTOR = [
  'input:not([type="hidden"]):not([disabled])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[role="switch"]:not([disabled])',
  '[role="combobox"]:not([disabled])',
  '[role="radio"][tabindex="0"]',
].join(", ");
const SECTION_FALLBACK_SELECTOR = 'button:not([disabled]), a[href], [tabindex="0"]';

/**
 * Scroll a settings section or row into view, focus its control, and pulse the
 * `settings-highlight` on it. The one landing every settings deep link uses —
 * search results and plugin-settings links alike — so they all read the same.
 */
export function landOnSettingsElement(el: HTMLElement): void {
  el.scrollIntoView({ behavior: "instant", block: "start" });
  const control =
    el.querySelector<HTMLElement>(SECTION_CONTROL_SELECTOR) ??
    el.querySelector<HTMLElement>(SECTION_FALLBACK_SELECTOR);
  control?.focus({ preventScroll: true });
  el.classList.add("settings-highlight");
  setTimeout(() => el.classList.remove("settings-highlight"), SETTINGS_HIGHLIGHT_DECAY_MS);
}
