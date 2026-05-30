/**
 * Snapshot of the OS-level Do-Not-Disturb (macOS Focus) state.
 *
 * `osDndActive` is the read-only signal surfaced from the main process:
 *   - `true`  — DND/Focus is engaged
 *   - `false` — DND/Focus is off
 *   - `undefined` — fail-soft default (unsupported platform or detection
 *     failed). Treat `undefined` as "unknown / do not gate".
 *
 * The signal must NEVER be used to suppress in-app toasts — the OS already
 * silences its own native banners, and double-gating would hide signals the
 * user cannot otherwise observe. The only consumers are the working-pulse
 * audio loop and the read-only toolbar/notification-center display.
 */
export interface OsDndState {
  osDndActive: boolean | undefined;
}
