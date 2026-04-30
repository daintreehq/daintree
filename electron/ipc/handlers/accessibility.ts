import { app, BrowserWindow } from "electron";
import { defineIpcNamespace, op } from "../define.js";
import { ACCESSIBILITY_METHOD_CHANNELS } from "./accessibility.preload.js";
import { CHANNELS } from "../channels.js";
import { getAppWebContents } from "../../window/webContentsRegistry.js";

async function handleGetEnabled(): Promise<boolean> {
  return app.accessibilitySupportEnabled;
}

export const accessibilityNamespace = defineIpcNamespace({
  name: "accessibility",
  ops: {
    getEnabled: op(ACCESSIBILITY_METHOD_CHANNELS.getEnabled, handleGetEnabled),
  },
});

export function registerAccessibilityHandlers(): () => void {
  const cleanups: Array<() => void> = [];

  cleanups.push(accessibilityNamespace.register());

  // Push-only event — not an ipcMain.handle op, so it lives outside the namespace.
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
  cleanups.push(() => app.removeListener("accessibility-support-changed", onChanged));

  return () => cleanups.forEach((cleanup) => cleanup());
}
