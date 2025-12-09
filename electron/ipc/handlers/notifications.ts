import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import { notificationService, NotificationState } from "../../services/NotificationService.js";
import type { HandlerDependencies } from "../types.js";

export function registerNotificationHandlers(_deps: HandlerDependencies): () => void {
  const handleNotificationUpdate = (
    _event: Electron.IpcMainEvent,
    state: NotificationState
  ): void => {
    notificationService.updateNotifications(state);
  };

  ipcMain.on(CHANNELS.NOTIFICATION_UPDATE, handleNotificationUpdate);

  return () => {
    ipcMain.removeListener(CHANNELS.NOTIFICATION_UPDATE, handleNotificationUpdate);
  };
}
