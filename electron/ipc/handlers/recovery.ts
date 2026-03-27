import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import type { HandlerDependencies } from "../types.js";
import { getCrashRecoveryService } from "../../services/CrashRecoveryService.js";
import { getDevServerUrl } from "../../../shared/config/devServer.js";

function getAppUrl(): string {
  if (process.env.NODE_ENV === "development") {
    return getDevServerUrl();
  }
  return "app://canopy/index.html";
}

export function registerRecoveryHandlers(deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  ipcMain.handle(CHANNELS.RECOVERY_RELOAD_APP, () => {
    const win = deps.mainWindow;
    if (win && !win.isDestroyed()) {
      console.log("[MAIN] Recovery: reloading app");
      win.loadURL(getAppUrl());
    }
  });
  handlers.push(() => ipcMain.removeHandler(CHANNELS.RECOVERY_RELOAD_APP));

  ipcMain.handle(CHANNELS.RECOVERY_RESET_AND_RELOAD, () => {
    const win = deps.mainWindow;
    if (win && !win.isDestroyed()) {
      console.log("[MAIN] Recovery: resetting state and reloading app");
      getCrashRecoveryService().resetToFresh();
      win.loadURL(getAppUrl());
    }
  });
  handlers.push(() => ipcMain.removeHandler(CHANNELS.RECOVERY_RESET_AND_RELOAD));

  return () => handlers.forEach((cleanup) => cleanup());
}
