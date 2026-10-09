import { ipcMain, type IpcMainEvent, type WebContents } from "electron";
import { CHANNELS } from "../channels.js";
import {
  getProjectForWebContents,
  getWindowForWebContents,
  onRendererScopeChanged,
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
      // Which view holds native focus decides whose report counts, and that
      // can change with no new report (a warm switch back to a view whose
      // answer is unchanged), so re-derive on the view's own focus edges.
      sender.on("focus", () => tracker.refresh());
      sender.on("blur", () => tracker.refresh());
    }
    tracker.report(senderId, window.id, getProjectForWebContents(senderId), payload);
  };

  ipcMain.on(CHANNELS.PLUGIN_REPORT_FOCUSED_PANEL, handleReport);
  // A view reports before it is registered to its project (the first view
  // loads first), and an unchanged answer is never re-sent, so re-attribute
  // when scope membership changes.
  const offScope = onRendererScopeChanged(() => tracker.refresh());
  return () => {
    offScope();
    ipcMain.removeListener(CHANNELS.PLUGIN_REPORT_FOCUSED_PANEL, handleReport);
  };
}
