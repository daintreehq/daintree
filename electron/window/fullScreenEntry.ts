import type { BrowserWindow } from "electron";

type FullScreenWindow = Pick<BrowserWindow, "isFullScreen" | "once">;

/** Long past any native transition (well under a second), short enough that a refused one heals. */
const ENTRY_GIVE_UP_MS = 5000;

const entering = new WeakSet<object>();

/**
 * Note that a hidden window goes into native full screen when it shows: one
 * restored full screen, or one replacing a full-screen window. macOS reports
 * `isFullScreen()` only once the transition has ended, so until then nothing on
 * the window says where it is headed. The mark lasts until the window enters or
 * leaves full screen, or a few seconds after it shows if macOS refused the
 * transition and neither ever comes.
 */
export function markEnteringFullScreen(win: FullScreenWindow): void {
  entering.add(win);
  const clear = () => entering.delete(win);
  win.once("enter-full-screen", clear);
  win.once("leave-full-screen", clear);
  win.once("show", () => setTimeout(clear, ENTRY_GIVE_UP_MS).unref());
}

/**
 * In native full screen or on its way there. Simple full screen does not count:
 * it stays on the current Space, among the other windows there.
 */
export function isInOrEnteringNativeFullScreen(win: FullScreenWindow): boolean {
  return entering.has(win) || win.isFullScreen();
}
