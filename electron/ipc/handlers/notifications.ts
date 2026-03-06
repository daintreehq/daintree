import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import { notificationService, NotificationState } from "../../services/NotificationService.js";
import { agentNotificationService } from "../../services/AgentNotificationService.js";
import { store } from "../../store.js";
import type { HandlerDependencies } from "../types.js";
import type { NotificationSettings } from "../../../shared/types/ipc/api.js";

const ALLOWED_SOUND_FILES = new Set([
  "chime.wav",
  "ping.wav",
  "complete.wav",
  "waiting.wav",
  "error.wav",
]);

export function registerNotificationHandlers(_deps: HandlerDependencies): () => void {
  const handleNotificationUpdate = (
    _event: Electron.IpcMainEvent,
    state: NotificationState
  ): void => {
    notificationService.updateNotifications(state);
  };

  const handleSettingsGet = async (): Promise<NotificationSettings> => {
    return store.get("notificationSettings");
  };

  const handleSettingsSet = async (
    _event: Electron.IpcMainInvokeEvent,
    rawSettings: unknown
  ): Promise<void> => {
    if (!rawSettings || typeof rawSettings !== "object") return;

    const allowed: Partial<NotificationSettings> = {};
    const s = rawSettings as Record<string, unknown>;

    if (typeof s.completedEnabled === "boolean") allowed.completedEnabled = s.completedEnabled;
    if (typeof s.waitingEnabled === "boolean") allowed.waitingEnabled = s.waitingEnabled;
    if (typeof s.failedEnabled === "boolean") allowed.failedEnabled = s.failedEnabled;
    if (typeof s.soundEnabled === "boolean") allowed.soundEnabled = s.soundEnabled;
    if (typeof s.soundFile === "string" && ALLOWED_SOUND_FILES.has(s.soundFile)) {
      allowed.soundFile = s.soundFile;
    }

    const current = store.get("notificationSettings");
    store.set("notificationSettings", { ...current, ...allowed });
  };

  const handlePlaySound = async (
    _event: Electron.IpcMainInvokeEvent,
    soundFile: unknown
  ): Promise<void> => {
    if (typeof soundFile !== "string" || !ALLOWED_SOUND_FILES.has(soundFile)) return;
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
