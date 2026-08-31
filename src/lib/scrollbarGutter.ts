/**
 * How much room the platform's scrollbar actually takes, measured rather than
 * assumed.
 *
 * `scrollbar-gutter: stable` reserves a scrollbar-width of layout — but only
 * where the scrollbar is a classic, space-taking one. macOS draws overlay
 * scrollbars, which sit on top of the content and reserve nothing, so the same
 * declaration reserves 0 there and the full bar width on Windows and Linux.
 * Nothing in CSS exposes which of those happened, and the user can switch
 * between them mid-session (System Settings › Appearance › Show scroll bars).
 *
 * So a stylesheet that has to line up with a reserved gutter cannot name a
 * number: #12101 shipped `calc(1.5rem + 11px)` against a gutter that turned out
 * to be 0px on macOS, which put every dialog's header and footer 11px inside
 * its own form. This module measures the real figure and publishes it, and
 * `.dialog-body-inset` in `index.css` subtracts it back out of the body's
 * padding so the column lands on 24px either way.
 */

/** The custom property `.dialog-body-inset` reads. */
export const SCROLLBAR_GUTTER_VAR = "--app-scrollbar-gutter";

/**
 * The width of one reserved gutter, in CSS px. 0 under overlay scrollbars.
 *
 * The probe has to be in the document to have layout at all — a detached
 * element reports 0 for every box metric, which would read as "overlay
 * scrollbars" on every platform. It is parked off-screen and hidden rather
 * than sized to nothing: `overflow: scroll` on a zero-sized box has no room to
 * put a scrollbar in.
 *
 * `stable` (not `both-edges`) so the result is one gutter, which is what the
 * padding subtracts per side.
 */
export function measureScrollbarGutter(): number {
  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = [
    "position:absolute",
    "top:-9999px",
    "left:-9999px",
    "width:100px",
    "height:100px",
    "padding:0",
    "border:0",
    "overflow:scroll",
    "scrollbar-gutter:stable",
    // Matches what dialog bodies inherit from `* { scrollbar-width: thin }`.
    // A probe left on `auto` would measure the wider bar and over-subtract.
    "scrollbar-width:thin",
    "visibility:hidden",
    "pointer-events:none",
  ].join(";");

  document.body.appendChild(probe);
  try {
    return Math.max(0, probe.offsetWidth - probe.clientWidth);
  } finally {
    probe.remove();
  }
}

/**
 * Measure and publish onto the document root, returning the figure (or `null`
 * if there is no document to measure in yet).
 *
 * The write is skipped when the value has not moved. It normally never moves,
 * and every dialog opening calls this — an unconditional `setProperty` on
 * `documentElement` would invalidate style for the whole tree each time.
 */
export function publishScrollbarGutter(): number | null {
  if (typeof document === "undefined" || !document.body) return null;

  const gutter = measureScrollbarGutter();
  const next = `${gutter}px`;
  const root = document.documentElement;
  if (root.style.getPropertyValue(SCROLLBAR_GUTTER_VAR) !== next) {
    root.style.setProperty(SCROLLBAR_GUTTER_VAR, next);
  }
  return gutter;
}
