import { BrowserWindow, type WebContents } from "electron";
import { viewWebContents } from "./activeViewFocus.js";
import { isInOrEnteringNativeFullScreen } from "./fullScreenEntry.js";

/**
 * Map a window without activating it, leaving the window the user is in on top.
 *
 * Both macOS and X11 stack a window shown inactive above the focused one, so
 * each background window of a startup restore buried the window holding
 * keyboard focus, and any dialog it showed, such as a deep-link install.
 *
 * macOS: `showInactive()` ends in `orderFrontRegardless`. `moveTop()` orders
 * the focused window back in front without touching the key window or its
 * first responder, so typing stays where it was. Not when either window is in
 * native full screen or on its way there: a native full-screen window is alone
 * on its own Space, so there is nothing to bury, and the restack lands during
 * the transition. It is the suspected cause of restored full-screen windows
 * whose title bar no longer slid down on hover, traffic lights gone until the
 * window left full screen and came back (v0.50.0, not reproduced in CI).
 *
 * X11: window managers stack a newly mapped window on top whether or not it
 * gets focus (xfwm4 raises every window it frames). A restack request can't
 * undo that: `moveTop()` sends `_NET_RESTACK_WINDOW`, which xfwm4 does not
 * handle at all. Activating the focused window again does, on any EWMH window
 * manager: the `_NET_ACTIVE_WINDOW` request carries a fresh timestamp from the
 * app that already holds focus, so focus-stealing prevention lets it through,
 * and the window manager raises the window it activates.
 *
 * Under Wayland the compositor owns stacking.
 */
export function showWindowInactive(win: BrowserWindow): void {
  const restack = stackingRestore();
  const focused = restack ? BrowserWindow.getFocusedWindow() : null;
  win.showInactive();
  if (!focused || focused === win || focused.isDestroyed()) return;
  if (restack === "reactivate") reactivate(focused);
  else if (!isInOrEnteringNativeFullScreen(win) && !isInOrEnteringNativeFullScreen(focused)) {
    focused.moveTop();
  }
}

function stackingRestore(): "restack" | "reactivate" | null {
  if (process.platform === "darwin") return "restack";
  if (process.platform === "linux" && process.env.XDG_SESSION_TYPE !== "wayland") {
    return "reactivate";
  }
  return null;
}

/**
 * Activate an already active window without moving its keyboard focus.
 * `BrowserWindow.focus()` alone would not do: on an active window Chromium
 * treats it as a request to focus the window root, taking focus off the
 * terminal the user is typing in. `webContents.focus()` activates its owner
 * window on Linux and then focuses itself again.
 */
function reactivate(win: BrowserWindow): void {
  const keyboardOwner = focusedChildWebContents(win);
  if (keyboardOwner) {
    keyboardOwner.focus();
  } else {
    win.focus();
  }
}

function focusedChildWebContents(win: BrowserWindow): WebContents | null {
  for (const child of win.contentView.children) {
    const wc = viewWebContents(child);
    if (wc?.isFocused()) return wc;
  }
  return null;
}
