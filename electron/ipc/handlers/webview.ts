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
    } catch {
      // Debugger may detach during navigation or when DevTools are opened.
      // This is non-fatal — the webview will continue operating without throttling.
    }
  };

  ipcMain.handle(CHANNELS.WEBVIEW_SET_LIFECYCLE_STATE, handleSetLifecycleState);

  return () => {
    ipcMain.removeHandler(CHANNELS.WEBVIEW_SET_LIFECYCLE_STATE);
  };
}
