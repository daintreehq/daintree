import { BrowserWindow } from "electron";

/**
 * Map a window without activating it, leaving the window the user is in on top.
 *
 * X11 window managers (xfwm4 among them) stack a window mapped without focus
 * above the focused one, so the background windows of a startup restore buried
 * the window holding keyboard focus, and any dialog it showed, such as a
 * deep-link install. `moveTop()` restacks the focused window as a pager request
 * (`_NET_RESTACK_WINDOW`), which focus-stealing prevention does not apply to.
 * It does nothing under Wayland.
 */
export function showWindowInactive(win: BrowserWindow): void {
  const focused = process.platform === "linux" ? BrowserWindow.getFocusedWindow() : null;
  win.showInactive();
  if (focused && focused !== win && !focused.isDestroyed()) focused.moveTop();
}
