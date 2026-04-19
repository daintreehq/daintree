import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import {
  notificationService,
  type NotificationState,
  type WatchNotificationContext,
} from "../../services/NotificationService.js";
import { agentNotificationService } from "../../services/AgentNotificationService.js";
import {
  soundService,
  ALLOWED_SOUND_FILES,
  SOUND_FILES,
  getSoundsDir,
} from "../../services/SoundService.js";
import { store } from "../../store.js";
import type { HandlerDependencies } from "../types.js";
import type { NotificationSettings } from "../../../shared/types/ipc/api.js";
import { typedHandle } from "../utils.js";

type SoundId = keyof typeof SOUND_FILES;

export function registerNotificationHandlers(_deps: HandlerDependencies): () => void {
  const cleanups: Array<() => void> = [];

  const handleNotificationUpdate = (
    _event: Electron.IpcMainEvent,
    state: NotificationState
  ): void => {
    notificationService.updateNotifications(state);
  };

  const handleSettingsGet = async (): Promise<NotificationSettings> => {
    return store.get("notificationSettings");
  };

  const handleSettingsSet = async (rawSettings: unknown): Promise<void> => {
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
    if (typeof s.workingPulseEnabled === "boolean") {
      allowed.workingPulseEnabled = s.workingPulseEnabled;
    }
    if (
      typeof s.workingPulseSoundFile === "string" &&
      ALLOWED_SOUND_FILES.has(s.workingPulseSoundFile)
    ) {
      allowed.workingPulseSoundFile = s.workingPulseSoundFile;
    }
    if (typeof s.uiFeedbackSoundEnabled === "boolean") {
      allowed.uiFeedbackSoundEnabled = s.uiFeedbackSoundEnabled;
    }
    if (typeof s.quietHoursEnabled === "boolean") {
      allowed.quietHoursEnabled = s.quietHoursEnabled;
    }
    if (typeof s.quietHoursStartMin === "number" && Number.isFinite(s.quietHoursStartMin)) {
      allowed.quietHoursStartMin = Math.max(0, Math.min(1439, Math.floor(s.quietHoursStartMin)));
    }
    if (typeof s.quietHoursEndMin === "number" && Number.isFinite(s.quietHoursEndMin)) {
      allowed.quietHoursEndMin = Math.max(0, Math.min(1439, Math.floor(s.quietHoursEndMin)));
    }
    if (Array.isArray(s.quietHoursWeekdays)) {
      const days = s.quietHoursWeekdays
        .filter(
          (d): d is number => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6
        )
        .sort((a, b) => a - b);
      allowed.quietHoursWeekdays = Array.from(new Set(days));
    }

    const current = store.get("notificationSettings");
    store.set("notificationSettings", { ...current, ...allowed });
  };

  const handlePlaySound = async (soundFile: unknown): Promise<void> => {
    if (typeof soundFile !== "string" || !ALLOWED_SOUND_FILES.has(soundFile)) return;
    soundService.previewFile(soundFile);
  };

  const handleSyncWatched = (_event: Electron.IpcMainEvent, payload: unknown): void => {
    if (!Array.isArray(payload)) return;
    const ids = payload.filter((v): v is string => typeof v === "string");
    agentNotificationService.syncWatchedPanels(ids);
  };

  const handlePlayUiEvent = async (soundId: unknown): Promise<void> => {
    if (typeof soundId !== "string") return;
    if (!(soundId in SOUND_FILES)) return;
    if (!store.get("notificationSettings").uiFeedbackSoundEnabled) return;
    soundService.play(soundId as SoundId);
  };

  const handleWaitingAcknowledge = (_event: Electron.IpcMainEvent, payload: unknown): void => {
    if (!payload || typeof payload !== "object") return;
    const p = payload as Record<string, unknown>;
    if (typeof p.terminalId !== "string") return;
    agentNotificationService.acknowledgeWaiting(p.terminalId);
  };

  const handleWorkingPulseAcknowledge = (_event: Electron.IpcMainEvent, payload: unknown): void => {
    if (!payload || typeof payload !== "object") return;
    const p = payload as Record<string, unknown>;
    if (typeof p.terminalId !== "string") return;
    agentNotificationService.acknowledgeWorkingPulse(p.terminalId);
  };

  const handleSessionMuteSet = (_event: Electron.IpcMainEvent, payload: unknown): void => {
    if (!payload || typeof payload !== "object") return;
    const p = payload as Record<string, unknown>;
    if (typeof p.timestampMs !== "number" || !Number.isFinite(p.timestampMs)) return;
    agentNotificationService.setSessionMuteUntil(p.timestampMs);
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

  const handleGetSoundDir = async (): Promise<string> => {
    return getSoundsDir();
  };

  // Fire-and-forget listeners (ipcMain.on) — no typedHandle equivalent.
  ipcMain.on(CHANNELS.NOTIFICATION_UPDATE, handleNotificationUpdate);
  ipcMain.on(CHANNELS.NOTIFICATION_SHOW_NATIVE, handleShowNative);
  ipcMain.on(CHANNELS.NOTIFICATION_SHOW_WATCH, handleShowWatch);
  ipcMain.on(CHANNELS.NOTIFICATION_SYNC_WATCHED, handleSyncWatched);
  ipcMain.on(CHANNELS.NOTIFICATION_WAITING_ACKNOWLEDGE, handleWaitingAcknowledge);
  ipcMain.on(CHANNELS.NOTIFICATION_WORKING_PULSE_ACKNOWLEDGE, handleWorkingPulseAcknowledge);
  ipcMain.on(CHANNELS.NOTIFICATION_SESSION_MUTE_SET, handleSessionMuteSet);

  cleanups.push(typedHandle(CHANNELS.NOTIFICATION_SETTINGS_GET, handleSettingsGet));
  cleanups.push(typedHandle(CHANNELS.NOTIFICATION_SETTINGS_SET, handleSettingsSet));
  cleanups.push(typedHandle(CHANNELS.NOTIFICATION_PLAY_SOUND, handlePlaySound));
  cleanups.push(typedHandle(CHANNELS.SOUND_GET_DIR, handleGetSoundDir));
  cleanups.push(typedHandle(CHANNELS.SOUND_PLAY_UI_EVENT, handlePlayUiEvent));

  return () => {
    ipcMain.removeListener(CHANNELS.NOTIFICATION_UPDATE, handleNotificationUpdate);
    ipcMain.removeListener(CHANNELS.NOTIFICATION_SHOW_NATIVE, handleShowNative);
    ipcMain.removeListener(CHANNELS.NOTIFICATION_SHOW_WATCH, handleShowWatch);
    ipcMain.removeListener(CHANNELS.NOTIFICATION_SYNC_WATCHED, handleSyncWatched);
    ipcMain.removeListener(CHANNELS.NOTIFICATION_WAITING_ACKNOWLEDGE, handleWaitingAcknowledge);
    ipcMain.removeListener(
      CHANNELS.NOTIFICATION_WORKING_PULSE_ACKNOWLEDGE,
      handleWorkingPulseAcknowledge
    );
    ipcMain.removeListener(CHANNELS.NOTIFICATION_SESSION_MUTE_SET, handleSessionMuteSet);
    cleanups.forEach((c) => c());
  };
}
