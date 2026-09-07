// eager-import-allow: reads notification settings via store.get synchronously in the IPC handler
import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import {
  notificationService,
  type NotificationState,
  type WatchNotificationContext,
} from "../../services/NotificationService.js";
import type * as AgentNotificationServiceModule from "../../services/AgentNotificationService.js";
import type * as SoundServiceModule from "../../services/SoundService.js";
import {
  getSoundService,
  getAllowedSoundFiles,
  getSoundFiles,
  getSoundsDirectory,
} from "../../services/getSoundService.js";
import { store } from "../../store.js";
import type { HandlerDependencies } from "../types.js";
import type { NotificationSettings } from "../../../shared/types/ipc/api.js";
import { typedHandle } from "../utils.js";
import { sanitizeNotificationSettingsPatch } from "../../utils/notificationSettingsPatch.js";
import { shouldPlayUiFeedbackSound } from "../../utils/uiFeedbackSound.js";

type SoundId = keyof typeof SoundServiceModule.SOUND_FILES;
type AgentNotificationSingleton = typeof AgentNotificationServiceModule.agentNotificationService;
type AllowedSoundFilesSet = typeof SoundServiceModule.ALLOWED_SOUND_FILES;
type SoundFilesMap = typeof SoundServiceModule.SOUND_FILES;

let cachedAgentNotificationService: AgentNotificationSingleton | null = null;
async function getAgentNotificationService(): Promise<AgentNotificationSingleton> {
  if (!cachedAgentNotificationService) {
    const mod = await import("../../services/AgentNotificationService.js");
    cachedAgentNotificationService = mod.agentNotificationService;
  }
  return cachedAgentNotificationService;
}

let cachedAllowedSoundFiles: AllowedSoundFilesSet | null = null;
async function allowedSoundFiles(): Promise<AllowedSoundFilesSet> {
  if (!cachedAllowedSoundFiles) {
    cachedAllowedSoundFiles = await getAllowedSoundFiles();
  }
  return cachedAllowedSoundFiles;
}

let cachedSoundFiles: SoundFilesMap | null = null;
async function soundFiles(): Promise<SoundFilesMap> {
  if (!cachedSoundFiles) {
    cachedSoundFiles = await getSoundFiles();
  }
  return cachedSoundFiles;
}

export function registerNotificationHandlers(deps: HandlerDependencies): () => void {
  const cleanups: Array<() => void> = [];

  // Owners are the renderers that reported notification state — identified by
  // `event.sender.id`, never by a "current window/project" global (the bug this
  // whole change exists to kill). Each is tracked once so its state can be
  // purged when it goes away.
  const trackedOwners = new Map<number, Electron.WebContents>();

  const purgeOwner = (ownerId: number): void => {
    // Short-circuit: the webContents "destroyed" listener and the owning
    // window's cleanup both fire for the same owner on window close, and the
    // window's DisposableStore keeps a purge for every view it ever hosted.
    if (!trackedOwners.delete(ownerId)) return;

    notificationService.removeOwner(ownerId);
    void getAgentNotificationService()
      .then((svc) => svc.removeOwner(ownerId))
      .catch((err) => console.error("[notifications] removeOwner failed:", err));
  };

  const trackOwner = (sender: Electron.WebContents): number => {
    const ownerId = sender.id;
    if (trackedOwners.has(ownerId)) return ownerId;
    trackedOwners.set(ownerId, sender);

    // A view's webContents is destroyed when its window closes AND when it is
    // evicted under memory pressure (eviction closes it). A *deactivated*
    // (cached, still-alive) view fires nothing — which is exactly right: its
    // watched panels and waiting count must survive until the user returns.
    sender.once("destroyed", () => purgeOwner(ownerId));

    // Belt and braces for window teardown, where the view's "destroyed" event
    // can race the registry's own unwinding.
    const windowCleanup = deps.windowRegistry?.getByWebContentsId(ownerId)?.cleanup;
    windowCleanup?.add({ dispose: () => purgeOwner(ownerId) });

    return ownerId;
  };

  const handleNotificationUpdate = (
    event: Electron.IpcMainEvent,
    state: NotificationState
  ): void => {
    notificationService.updateNotifications(trackOwner(event.sender), state);
  };

  const handleSettingsGet = async (): Promise<NotificationSettings> => {
    return store.get("notificationSettings");
  };

  const handleSettingsSet = async (rawSettings: unknown): Promise<void> => {
    const allowed = sanitizeNotificationSettingsPatch(rawSettings, await allowedSoundFiles());

    for (const [field, value] of Object.entries(allowed)) {
      store.set(`notificationSettings.${field}`, value);
    }
  };

  const handlePlaySound = async (soundFile: unknown): Promise<void> => {
    if (typeof soundFile !== "string") return;
    const ALLOWED = await allowedSoundFiles();
    if (!ALLOWED.has(soundFile)) return;
    const sound = await getSoundService();
    sound.previewFile(soundFile);
  };

  const handleSyncWatched = (event: Electron.IpcMainEvent, payload: unknown): void => {
    if (!Array.isArray(payload)) return;
    const ids = payload.filter((v): v is string => typeof v === "string");
    // Pin the sender synchronously: the service import is async, and a view
    // destroyed while it settles would otherwise have its state resurrected by
    // the late sync — a leak no destroy event can clean up.
    const ownerId = trackOwner(event.sender);
    void getAgentNotificationService()
      .then((svc) => {
        if (!trackedOwners.has(ownerId)) return;
        svc.syncWatchedPanels(ownerId, ids);
      })
      .catch((err) => console.error("[notifications] syncWatched failed:", err));
  };

  const handlePlayUiEvent = async (soundId: unknown): Promise<void> => {
    if (typeof soundId !== "string") return;
    const SOUNDS = await soundFiles();
    if (!(soundId in SOUNDS)) return;
    if (!shouldPlayUiFeedbackSound(store.get("notificationSettings"))) return;
    const sound = await getSoundService();
    sound.play(soundId as SoundId);
  };

  const handleWaitingAcknowledge = (_event: Electron.IpcMainEvent, payload: unknown): void => {
    if (!payload || typeof payload !== "object") return;
    const p = payload as Record<string, unknown>;
    if (typeof p.terminalId !== "string") return;
    const terminalId = p.terminalId;
    void getAgentNotificationService()
      .then((svc) => svc.acknowledgeWaiting(terminalId))
      .catch((err) => console.error("[notifications] acknowledgeWaiting failed:", err));
  };

  const handleWorkingPulseAcknowledge = (_event: Electron.IpcMainEvent, payload: unknown): void => {
    if (!payload || typeof payload !== "object") return;
    const p = payload as Record<string, unknown>;
    if (typeof p.terminalId !== "string") return;
    const terminalId = p.terminalId;
    void getAgentNotificationService()
      .then((svc) => svc.acknowledgeWorkingPulse(terminalId))
      .catch((err) => console.error("[notifications] acknowledgeWorkingPulse failed:", err));
  };

  const handleSessionMuteSet = (_event: Electron.IpcMainEvent, payload: unknown): void => {
    if (!payload || typeof payload !== "object") return;
    const p = payload as Record<string, unknown>;
    if (typeof p.timestampMs !== "number" || !Number.isFinite(p.timestampMs)) return;
    const ts = p.timestampMs;
    void getAgentNotificationService()
      .then((svc) => svc.setSessionMuteUntil(ts))
      .catch((err) => console.error("[notifications] setSessionMuteUntil failed:", err));
  };

  const handleShowNative = (_event: Electron.IpcMainEvent, payload: unknown): void => {
    if (!payload || typeof payload !== "object") return;
    const p = payload as Record<string, unknown>;
    if (typeof p.title !== "string" || typeof p.body !== "string") return;
    notificationService.showNativeNotification(p.title, p.body);
  };

  const handleShowWatch = (event: Electron.IpcMainEvent, payload: unknown): void => {
    if (!payload || typeof payload !== "object") return;
    const p = payload as Record<string, unknown>;
    if (typeof p.title !== "string" || typeof p.body !== "string") return;
    if (typeof p.panelId !== "string") return;

    const context: WatchNotificationContext = {
      panelId: p.panelId,
      panelTitle: typeof p.panelTitle === "string" ? p.panelTitle : p.panelId,
      worktreeId: typeof p.worktreeId === "string" ? p.worktreeId : undefined,
    };

    // The renderer that asked for the notification owns the panel it names, so
    // a click on it belongs back in that same renderer's window.
    notificationService.showWatchNotification(
      p.title,
      p.body,
      context,
      CHANNELS.NOTIFICATION_WATCH_NAVIGATE,
      { ownerWebContentsId: event.sender.id }
    );
  };

  const handleGetSoundDir = async (): Promise<string> => {
    return getSoundsDirectory();
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
    trackedOwners.clear();
    cleanups.forEach((c) => c());
  };
}
