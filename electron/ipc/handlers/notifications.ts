import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import {
  notificationService,
  type NotificationState,
  type WatchNotificationContext,
} from "../../services/NotificationService.js";
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

    if (typeof s.enabled === "boolean") allowed.enabled = s.enabled;
    if (typeof s.completedEnabled === "boolean") allowed.completedEnabled = s.completedEnabled;
    if (typeof s.waitingEnabled === "boolean") allowed.waitingEnabled = s.waitingEnabled;
    if (typeof s.soundEnabled === "boolean") allowed.soundEnabled = s.soundEnabled;
    if (typeof s.completedSoundFile === "string" && ALLOWED_SOUND_FILES.has(s.completedSoundFile)) {
      allowed.completedSoundFile = s.completedSoundFile;
    }
    if (typeof s.waitingSoundFile === "string" && ALLOWED_SOUND_FILES.has(s.waitingSoundFile)) {
      allowed.waitingSoundFile = s.waitingSoundFile;
    }
    if (
      typeof s.escalationSoundFile === "string" &&
      ALLOWED_SOUND_FILES.has(s.escalationSoundFile)
    ) {
      allowed.escalationSoundFile = s.escalationSoundFile;
    }
    if (typeof s.waitingEscalationEnabled === "boolean") {
      allowed.waitingEscalationEnabled = s.waitingEscalationEnabled;
    }
    if (
      typeof s.waitingEscalationDelayMs === "number" &&
      Number.isFinite(s.waitingEscalationDelayMs)
    ) {
      allowed.waitingEscalationDelayMs = Math.max(
        30_000,
        Math.min(3_600_000, s.waitingEscalationDelayMs)
      );
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

  const handleSyncWatched = (_event: Electron.IpcMainEvent, payload: unknown): void => {
    if (!Array.isArray(payload)) return;
    const ids = payload.filter((v): v is string => typeof v === "string");
    agentNotificationService.syncWatchedPanels(ids);
  };

  const handleWaitingAcknowledge = (_event: Electron.IpcMainEvent, payload: unknown): void => {
    if (!payload || typeof payload !== "object") return;
    const p = payload as Record<string, unknown>;
    if (typeof p.terminalId !== "string") return;
    agentNotificationService.acknowledgeWaiting(p.terminalId);
  };

  const handleShowNative = (_event: Electron.IpcMainEvent, payload: unknown): void => {
    if (!payload || typeof payload !== "object") return;
    const p = payload as Record<string, unknown>;
    if (typeof p.title !== "string" || typeof p.body !== "string") return;
    notificationService.showNativeNotification(p.title, p.body);
  };

  const handleShowWatch = (_event: Electron.IpcMainEvent, payload: unknown): void => {
    if (!payload || typeof payload !== "object") return;
    const p = payload as Record<string, unknown>;
    if (typeof p.title !== "string" || typeof p.body !== "string") return;
    if (typeof p.panelId !== "string") return;

    const context: WatchNotificationContext = {
      panelId: p.panelId,
      panelTitle: typeof p.panelTitle === "string" ? p.panelTitle : p.panelId,
      worktreeId: typeof p.worktreeId === "string" ? p.worktreeId : undefined,
    };

    notificationService.showWatchNotification(
      p.title,
      p.body,
      context,
      CHANNELS.NOTIFICATION_WATCH_NAVIGATE
    );
  };

  ipcMain.on(CHANNELS.NOTIFICATION_UPDATE, handleNotificationUpdate);
  ipcMain.handle(CHANNELS.NOTIFICATION_SETTINGS_GET, handleSettingsGet);
  ipcMain.handle(CHANNELS.NOTIFICATION_SETTINGS_SET, handleSettingsSet);
  ipcMain.handle(CHANNELS.NOTIFICATION_PLAY_SOUND, handlePlaySound);
  ipcMain.on(CHANNELS.NOTIFICATION_SHOW_NATIVE, handleShowNative);
  ipcMain.on(CHANNELS.NOTIFICATION_SHOW_WATCH, handleShowWatch);
  ipcMain.on(CHANNELS.NOTIFICATION_SYNC_WATCHED, handleSyncWatched);
  ipcMain.on(CHANNELS.NOTIFICATION_WAITING_ACKNOWLEDGE, handleWaitingAcknowledge);

  return () => {
    ipcMain.removeListener(CHANNELS.NOTIFICATION_UPDATE, handleNotificationUpdate);
    ipcMain.removeHandler(CHANNELS.NOTIFICATION_SETTINGS_GET);
    ipcMain.removeHandler(CHANNELS.NOTIFICATION_SETTINGS_SET);
    ipcMain.removeHandler(CHANNELS.NOTIFICATION_PLAY_SOUND);
    ipcMain.removeListener(CHANNELS.NOTIFICATION_SHOW_NATIVE, handleShowNative);
    ipcMain.removeListener(CHANNELS.NOTIFICATION_SHOW_WATCH, handleShowWatch);
    ipcMain.removeListener(CHANNELS.NOTIFICATION_SYNC_WATCHED, handleSyncWatched);
    ipcMain.removeListener(CHANNELS.NOTIFICATION_WAITING_ACKNOWLEDGE, handleWaitingAcknowledge);
  };
}
