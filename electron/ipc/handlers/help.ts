import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import * as HelpService from "../../services/HelpService.js";

export function registerHelpHandlers(): () => void {
  const handlers: Array<() => void> = [];

  ipcMain.handle(CHANNELS.HELP_GET_FOLDER_PATH, async () => {
    return HelpService.getHelpFolderPath();
  });
  handlers.push(() => ipcMain.removeHandler(CHANNELS.HELP_GET_FOLDER_PATH));

  return () => {
    for (const cleanup of handlers) {
      cleanup();
    }
  };
}
