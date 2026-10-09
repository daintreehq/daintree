import { ipcMain, type IpcMainEvent, type WebContents } from "electron";
import { CHANNELS } from "../channels.js";
import {
  getProjectForWebContents,
  getWindowForWebContents,
} from "../../window/webContentsRegistry.js";
import {
  getFocusedPanelTracker,
  type FocusedPanelTracker,
} from "../../services/FocusedPanelTracker.js";

/**
 * Wire the fire-and-forget channel through which each project view reports the
 * kind of panel holding its DOM focus (#13221). The sender, its window and its
 * project are resolved here from `event.sender`, never taken from the payload,
 * and the payload is re-normalised by the tracker.
 */
export function registerPluginFocusedPanelHandlers(
  tracker: FocusedPanelTracker = getFocusedPanelTracker()
): () => void {
  const watched = new WeakSet<WebContents>();

  const handleReport = (event: IpcMainEvent, payload: unknown): void => {
    // Only the top frame runs the preload that owns the report.
    if (event.senderFrame && event.senderFrame.parent !== null) return;
    const sender = event.sender;
    if (sender.isDestroyed()) return;
    const window = getWindowForWebContents(sender);
    if (!window || window.isDestroyed()) return;
    const senderId = sender.id;
    if (!watched.has(sender)) {
      watched.add(sender);
      sender.once("destroyed", () => tracker.removeSender(senderId));
      // A crashed renderer keeps its WebContents, so `destroyed` alone would
      // leave its last report standing until the reload reports again.
      sender.on("render-process-gone", () => tracker.removeSender(senderId));
    }
    tracker.report(senderId, window.id, getProjectForWebContents(senderId), payload);
  };

  ipcMain.on(CHANNELS.PLUGIN_REPORT_FOCUSED_PANEL, handleReport);
  return () => {
    ipcMain.removeListener(CHANNELS.PLUGIN_REPORT_FOCUSED_PANEL, handleReport);
  };
}
