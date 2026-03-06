import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import { notificationService, NotificationState } from "../../services/NotificationService.js";
import { agentNotificationService } from "../../services/AgentNotificationService.js";
import { store } from "../../store.js";
import type { HandlerDependencies } from "../types.js";

export function registerNotificationHandlers(_deps: HandlerDependencies): () => void {
  const handleNotificationUpdate = (
    _event: Electron.IpcMainEvent,
    state: NotificationState
  ): void => {
    notificationService.updateNotifications(state);
  };

  const handleSettingsGet = async () => {
    return store.get("notificationSettings");
  };

  const handleSettingsSet = async (
    _event: Electron.IpcMainInvokeEvent,
    settings: Partial<{
      completedEnabled: boolean;
      waitingEnabled: boolean;
      failedEnabled: boolean;
      soundEnabled: boolean;
      soundFile: string;
    }>
  ) => {
    const current = store.get("notificationSettings");
    store.set("notificationSettings", { ...current, ...settings });
  };

  const handlePlaySound = async (_event: Electron.IpcMainInvokeEvent, soundFile: string) => {
    agentNotificationService.playSoundPreview(soundFile);
  };

  ipcMain.on(CHANNELS.NOTIFICATION_UPDATE, handleNotificationUpdate);
  ipcMain.handle(CHANNELS.NOTIFICATION_SETTINGS_GET, handleSettingsGet);
  ipcMain.handle(CHANNELS.NOTIFICATION_SETTINGS_SET, handleSettingsSet);
  ipcMain.handle(CHANNELS.NOTIFICATION_PLAY_SOUND, handlePlaySound);

  return () => {
    ipcMain.removeListener(CHANNELS.NOTIFICATION_UPDATE, handleNotificationUpdate);
    ipcMain.removeHandler(CHANNELS.NOTIFICATION_SETTINGS_GET);
    ipcMain.removeHandler(CHANNELS.NOTIFICATION_SETTINGS_SET);
    ipcMain.removeHandler(CHANNELS.NOTIFICATION_PLAY_SOUND);
  };
}
