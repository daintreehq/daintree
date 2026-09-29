import { app, BrowserWindow } from "electron";

/**
 * Background e2e windows (macOS): every BrowserWindow is mapped (so Chromium
 * keeps compositing, rAF and CDP screenshots behave as they do headed) but
 * fully transparent and click-through, and the app can never be activated, so
 * it has no Dock or Cmd-Tab presence and never takes the menu bar.
 *
 * The window can never hold real OS focus — key status would route the
 * developer's own keystrokes into an invisible window. Instead focus is
 * virtual: the calls that focus a window headed (show, focus, restore,
 * webContents.focus) record it as focused, the calls that take focus away
 * (blur, hide, minimize, close) hand it to another visible window, and
 * isFocused()/getFocusedWindow() read that record, so focus-gated main process
 * paths (notification routing, crash recovery, power monitor) run as they
 * would in a headed session. Page-level focus is already emulated by
 * Playwright's CDP attachment.
 */
export function installE2EBackgroundWindows(): void {
  // alphaValue 0 can count as occluded on macOS, which would mark the page
  // hidden and throttle it — unlike a headed run, where the window is on screen.
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

  // Not "accessory": that still lets the app activate, and webContents.focus()
  // focuses its owner window natively (activating the app) without passing
  // through the patched BrowserWindow methods below.
  app.setActivationPolicy("prohibited");

  const proto = BrowserWindow.prototype;
  const nativeShowInactive = proto.showInactive;
  const nativeHide = proto.hide;
  const nativeMinimize = proto.minimize;
  const nativeRestore = proto.restore;
  const nativeIsVisible = proto.isVisible;

  let focused: BrowserWindow | null = null;

  const setFocused = (next: BrowserWindow | null): void => {
    if (focused === next) return;
    const prev = focused;
    focused = next;
    if (prev && !prev.isDestroyed()) prev.emit("blur");
    if (next && !next.isDestroyed()) next.emit("focus");
  };

  const canHoldFocus = (win: BrowserWindow): boolean =>
    !win.isDestroyed() && nativeIsVisible.call(win) && !win.isMinimized();

  const handOff = (from: BrowserWindow): void => {
    if (focused !== from) return;
    const next = BrowserWindow.getAllWindows().find((w) => w !== from && canHoldFocus(w));
    setFocused(next ?? null);
  };

  proto.show = function (this: BrowserWindow) {
    nativeShowInactive.call(this);
    setFocused(this);
  };
  // Native focus() is a no-op on a hidden window; keep that, so a missing
  // show() in app code still fails here the way it does headed.
  proto.focus = function (this: BrowserWindow) {
    if (canHoldFocus(this)) setFocused(this);
  };
  proto.blur = function (this: BrowserWindow) {
    if (focused === this) setFocused(null);
  };
  proto.hide = function (this: BrowserWindow) {
    nativeHide.call(this);
    handOff(this);
  };
  proto.minimize = function (this: BrowserWindow) {
    nativeMinimize.call(this);
    handOff(this);
  };
  proto.restore = function (this: BrowserWindow) {
    nativeRestore.call(this);
    if (canHoldFocus(this)) setFocused(this);
  };
  proto.isFocused = function (this: BrowserWindow) {
    return focused === this;
  };
  BrowserWindow.getFocusedWindow = () => (focused && !focused.isDestroyed() ? focused : null);
  app.focus = () => {};

  app.on("browser-window-created", (_event, win) => {
    win.setOpacity(0);
    win.setIgnoreMouseEvents(true);
    win.once("closed", () => {
      if (focused !== win) return;
      focused = null;
      const next = BrowserWindow.getAllWindows().find((w) => w !== win && canHoldFocus(w));
      if (next) setFocused(next);
    });
  });

  // webContents.focus() focuses its owner window natively; mirror that here.
  app.on("web-contents-created", (_event, contents) => {
    const nativeFocus = contents.focus.bind(contents);
    contents.focus = () => {
      nativeFocus();
      const owner = BrowserWindow.fromWebContents(contents);
      if (owner && canHoldFocus(owner)) setFocused(owner);
    };
  });
}
