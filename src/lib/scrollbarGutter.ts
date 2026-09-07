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
 * The probe's configuration, which is the whole measurement: `overflow: scroll`
 * and `scrollbar-gutter: stable` force exactly one gutter to be reserved, and
 * `scrollbar-width: thin` matches what a dialog body inherits from
 * `* { scrollbar-width: thin }` in `index.css` — a probe left on `auto` would
 * measure the wider bar and over-subtract. It needs a real size and no border
 * or padding of its own for `offsetWidth - clientWidth` to be the gutter alone.
 */
const PROBE_STYLE = [
  "position:absolute",
  "top:-9999px",
  "left:-9999px",
  "width:100px",
  "height:100px",
  "padding:0",
  "border:0",
  "overflow:scroll",
  "scrollbar-gutter:stable",
  "scrollbar-width:thin",
  "visibility:hidden",
  "pointer-events:none",
].join(";");

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
  // `setAttribute` rather than `style.cssText` so the declaration survives
  // verbatim on the attribute: a CSSOM that does not implement
  // `scrollbar-gutter` drops it when re-serialising `cssText`, and the probe's
  // configuration would then be unassertable in a test. It changes nothing in
  // an engine that supports the property.
  probe.setAttribute("style", PROBE_STYLE);

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

/**
 * Keep the published figure current for the lifetime of the renderer, and
 * return a disposer.
 *
 * `AppDialog` re-measures as it opens, which covers the usual path — change the
 * setting, then open a dialog. It does not cover a dialog that is *already*
 * open: Chromium re-lays out its scrollport straight away, and the published
 * figure would stay stale until that dialog was reopened, leaving its content
 * a gutter's width off the chrome's column in the meantime.
 *
 * Focus is the event that catches it, because changing the setting means going
 * to System Settings and coming back. The measurement is one off-screen probe
 * and the write is skipped unless the figure actually moved, so an ordinary
 * alt-tab costs a layout read and nothing else.
 */
export function watchScrollbarGutter(): () => void {
  if (typeof window === "undefined") return () => {};

  const onFocus = () => {
    publishScrollbarGutter();
  };
  window.addEventListener("focus", onFocus);
  return () => window.removeEventListener("focus", onFocus);
}
