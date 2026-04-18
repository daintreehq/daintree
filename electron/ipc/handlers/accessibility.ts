import { app, BrowserWindow } from "electron";
import { CHANNELS } from "../channels.js";
import { getAppWebContents } from "../../window/webContentsRegistry.js";
import { typedHandle } from "../utils.js";

export function registerAccessibilityHandlers(): () => void {
  const handlers: Array<() => void> = [];

  const handleGetEnabled = async () => {
    return app.accessibilitySupportEnabled;
  };
  handlers.push(typedHandle(CHANNELS.ACCESSIBILITY_GET_ENABLED, handleGetEnabled));

  const onChanged = (_event: Electron.Event, enabled: boolean) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        const wc = getAppWebContents(win);
        if (!wc.isDestroyed()) {
          wc.send(CHANNELS.ACCESSIBILITY_SUPPORT_CHANGED, { enabled });
        }
      }
    }
  };
  app.on("accessibility-support-changed", onChanged);
  handlers.push(() => app.removeListener("accessibility-support-changed", onChanged));

  return () => handlers.forEach((cleanup) => cleanup());
}
