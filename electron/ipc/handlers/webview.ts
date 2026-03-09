import { ipcMain, webContents } from "electron";
import { CHANNELS } from "../channels.js";

export function registerWebviewHandlers(): () => void {
  const handleSetLifecycleState = async (
    _event: Electron.IpcMainInvokeEvent,
    webContentsId: unknown,
    frozen: unknown
  ): Promise<void> => {
    if (typeof webContentsId !== "number" || typeof frozen !== "boolean") {
      throw new Error("Invalid arguments: webContentsId must be number, frozen must be boolean");
    }

    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) return;

    try {
      if (!wc.debugger.isAttached()) {
        wc.debugger.attach("1.3");
      }
      await wc.debugger.sendCommand("Page.enable");
      await wc.debugger.sendCommand("Page.setWebLifecycleState", {
        state: frozen ? "frozen" : "active",
      });
    } catch (err) {
      // Transient failures (target detached during navigation, DevTools opened) are expected.
      // Log unexpected errors so they surface in dev without breaking the webview.
      const message = err instanceof Error ? err.message : String(err);
      const isExpected =
        message.includes("Target closed") ||
        message.includes("Inspected target navigated") ||
        message.includes("Cannot attach") ||
        message.includes("debugger is already attached");
      if (!isExpected) {
        console.warn(`[webview] CDP lifecycle state failed for id=${webContentsId}:`, message);
      }
    }
  };

  ipcMain.handle(CHANNELS.WEBVIEW_SET_LIFECYCLE_STATE, handleSetLifecycleState);

  return () => {
    ipcMain.removeHandler(CHANNELS.WEBVIEW_SET_LIFECYCLE_STATE);
  };
}
