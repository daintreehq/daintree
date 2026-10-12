import type { BrowserWindow, View, WebContents, WebContentsView } from "electron";

/**
 * Keyboard focus for a window that becomes active with nothing focused.
 *
 * Every BrowserWindow here is an empty shell: the UI lives in child
 * WebContentsViews. On Windows and Linux, Electron's BrowserWindow focus
 * handler focuses the window's OWN webContents on every activation, and
 * Chromium only hands focus back to a child view it stored on the previous
 * deactivation. The startup view is attached without ever being focused, so a
 * window's first activation (and any activation that stored nothing) leaves
 * keystrokes in the shell until the user clicks: the restored project's
 * terminal never sees them. Once something inside has been focused, Chromium's
 * own restore keeps working, and this stays out of its way.
 */
export interface ActiveViewFocusOptions {
  /** The view keystrokes belong in: the window's foreground project view, or its welcome view. */
  getActiveView: () => WebContentsView | null;
  /** True while a switch shows the outgoing view over the incoming one; the switch focuses what it reveals. */
  isSwitchBridged?: () => boolean;
}

export interface ActiveViewFocusHandle {
  /** Check on the next turn, after any focus restore of Chromium's own has run. */
  schedule: () => void;
  dispose: () => void;
}

export function viewWebContents(view: View): WebContents | null {
  const wc = (view as Partial<WebContentsView>).webContents;
  return wc && !wc.isDestroyed() ? wc : null;
}

/**
 * Focus the active view when the window is the OS-active window but no child
 * view holds keyboard focus (it sits in the shell's webContents, or nowhere).
 * Never runs for an inactive window: on Linux and macOS `webContents.focus()`
 * activates its owner, which would pull a window revealed with `showInactive`
 * in front of the one the user is in.
 */
export function focusActiveViewIfUnfocused(
  win: BrowserWindow,
  options: ActiveViewFocusOptions
): boolean {
  if (win.isDestroyed() || !win.isFocused()) return false;
  if (options.isSwitchBridged?.()) return false;

  const target = options.getActiveView();
  const targetWc = target ? viewWebContents(target) : null;
  if (!target || !targetWc) return false;

  const children = win.contentView.children;
  if (!children.includes(target)) return false;
  // A browser panel, plugin surface or dev preview the user was in keeps it.
  for (const child of children) {
    if (viewWebContents(child)?.isFocused()) return false;
  }

  targetWc.focus();
  return true;
}

export function attachActiveViewFocus(
  win: BrowserWindow,
  options: ActiveViewFocusOptions
): ActiveViewFocusHandle {
  let pending: ReturnType<typeof setImmediate> | null = null;
  let disposed = false;

  const cancel = (): void => {
    if (pending) {
      clearImmediate(pending);
      pending = null;
    }
  };

  // Deferred because the `focus` event is emitted inside the activation, before
  // Chromium restores a stored child focus — checking synchronously would see
  // the shell focused and take focus from a view that was about to get it back.
  const schedule = (): void => {
    if (disposed || pending || win.isDestroyed()) return;
    pending = setImmediate(() => {
      pending = null;
      if (disposed) return;
      try {
        focusActiveViewIfUnfocused(win, options);
      } catch (error) {
        console.warn("[MAIN] Restoring active view focus failed:", error);
      }
    });
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    cancel();
    if (!win.isDestroyed()) {
      win.removeListener("focus", schedule);
      win.removeListener("blur", cancel);
    }
  };

  win.on("focus", schedule);
  // Focusing a view activates its window on Linux and macOS: a check still
  // queued when the user has already left must not drag them back.
  win.on("blur", cancel);

  return { schedule, dispose };
}
