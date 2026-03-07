import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import * as CliInstallService from "../../services/CliInstallService.js";

export function registerCliHandlers(): () => void {
  const handlers: Array<() => void> = [];

  ipcMain.handle(CHANNELS.CLI_GET_STATUS, async () => {
    return CliInstallService.getStatus();
  });
  handlers.push(() => ipcMain.removeHandler(CHANNELS.CLI_GET_STATUS));

  ipcMain.handle(CHANNELS.CLI_INSTALL, async () => {
    return CliInstallService.install();
  });
  handlers.push(() => ipcMain.removeHandler(CHANNELS.CLI_INSTALL));

  return () => {
    for (const cleanup of handlers) {
      cleanup();
    }
  };
}
