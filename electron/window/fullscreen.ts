import type { BrowserWindow } from "electron";

/**
 * The subset of BrowserWindow the toggle touches. Narrow on purpose: callers
 * still pass a real window, but tests can drive the platform matrix with four
 * spies instead of faking a whole window.
 */
type FullscreenTarget = Pick<
  BrowserWindow,
  "isFullScreen" | "setFullScreen" | "isSimpleFullScreen" | "setSimpleFullScreen"
>;

/**
 * Toggle fullscreen using the API that fits the platform, returning the new state.
 *
 * `setSimpleFullScreen`/`isSimpleFullScreen` are macOS-only. macOS wants them:
 * simple fullscreen stays on the current Space, skips the transition animation,
 * and extends into the menu-bar/notch area. Windows and Linux only define the
 * native fullScreen APIs.
 *
 * A macOS window can also land in *native* fullscreen — the green traffic-light
 * button puts it there, and `restoreWindowState` reopens a saved-fullscreen
 * window with `setFullScreen(true)`. Exiting that takes priority over entering
 * simple fullscreen, so a settled window is never left with both modes stacked,
 * and no single call both leaves one mode and enters the other. macOS only
 * promises `isFullScreen()` is accurate once `enter-full-screen`/
 * `leave-full-screen` has fired, so a toggle landing mid-transition can still
 * read the pre-transition value; exiting simple first keeps that recoverable.
 */
export function toggleWindowFullscreen(win: FullscreenTarget): boolean {
  if (process.platform !== "darwin") {
    const next = !win.isFullScreen();
    win.setFullScreen(next);
    return next;
  }

  if (win.isSimpleFullScreen()) {
    win.setSimpleFullScreen(false);
    return false;
  }

  if (win.isFullScreen()) {
    win.setFullScreen(false);
    return false;
  }

  win.setSimpleFullScreen(true);
  return true;
}
