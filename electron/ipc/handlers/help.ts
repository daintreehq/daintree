import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import * as HelpService from "../../services/HelpService.js";
import { getAgentAvailabilityStore } from "../../services/AgentAvailabilityStore.js";

export function registerHelpHandlers(): () => void {
  const handlers: Array<() => void> = [];

  ipcMain.handle(CHANNELS.HELP_GET_FOLDER_PATH, async () => {
    return HelpService.getHelpFolderPath();
  });
  handlers.push(() => ipcMain.removeHandler(CHANNELS.HELP_GET_FOLDER_PATH));

  ipcMain.handle(
    CHANNELS.HELP_MARK_TERMINAL,
    (_event: Electron.IpcMainInvokeEvent, terminalId: string) => {
      getAgentAvailabilityStore().markAsHelp(terminalId);
    }
  );
  handlers.push(() => ipcMain.removeHandler(CHANNELS.HELP_MARK_TERMINAL));

  ipcMain.handle(
    CHANNELS.HELP_UNMARK_TERMINAL,
    (_event: Electron.IpcMainInvokeEvent, terminalId: string) => {
      getAgentAvailabilityStore().unmarkAsHelp(terminalId);
    }
  );
  handlers.push(() => ipcMain.removeHandler(CHANNELS.HELP_UNMARK_TERMINAL));

  return () => {
    for (const cleanup of handlers) {
      cleanup();
    }
  };
}
