import type { BrowserWindow } from "electron";
import { CHANNELS } from "../ipc/channels.js";
import { isWithheldFromView } from "../ipc/utils.js";
import { getWindowAppWebContents } from "./webContentsRegistry.js";

/**
 * Tell every project view in the window, cached ones included, that the window
 * entered or left fullscreen. Main pushes the change and never the state, so a
 * view cached when it happened would come back still drawing room for window
 * controls that are gone, or none for ones that are back.
 */
export function sendFullscreenChange(win: BrowserWindow, isFullscreen: boolean): void {
  if (win.isDestroyed()) return;
  const envelope = { name: "window:fullscreen-change", payload: isFullscreen };
  for (const webContents of getWindowAppWebContents(win)) {
    if (isWithheldFromView(webContents.id, CHANNELS.EVENTS_PUSH, [envelope])) continue;
    try {
      webContents.send(CHANNELS.EVENTS_PUSH, envelope);
    } catch {
      // Silently ignore send failures during window initialization/disposal.
    }
  }
}
