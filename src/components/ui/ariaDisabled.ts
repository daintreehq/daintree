/**
 * Stand-ins for the `disabled:` variants on a Button that announces
 * unavailability with `aria-disabled` instead of the native attribute — which
 * leaves the tab order and drops focus to <body> if the button had it. The
 * attribute is advisory, so the caller vetoes activation in JS too. Apply only
 * when the action itself is unavailable: `loading` also synthesises
 * `aria-disabled`, and dimming there would fade the spinner it overlays. No
 * `aria-disabled:pointer-events-none` — that would suppress hover and put the
 * control back out of reach.
 */
export const ARIA_DISABLED_CLASSES = "aria-disabled:opacity-50 aria-disabled:cursor-not-allowed";

/**
 * The same, for a control with nothing to show on hover: the pointer gets
 * exactly what a native disabled button gave it — no hover fill, no press —
 * and only the keyboard gains, because the control keeps its focus.
 */
export const ARIA_DISABLED_INERT_CLASSES = `${ARIA_DISABLED_CLASSES} aria-disabled:pointer-events-none`;
