import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import type { HandlerDependencies } from "../types.js";
import type {
  DevPreviewEnsureRequest,
  DevPreviewSessionRequest,
  DevPreviewStateChangedPayload,
} from "../../../shared/types/ipc/devPreview.js";
import { DevPreviewSessionService } from "../../services/DevPreviewSessionService.js";

export function registerDevPreviewHandlers(deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const sendToRenderer = (channel: string, data: unknown) => {
    if (
      deps.mainWindow &&
      !deps.mainWindow.isDestroyed() &&
      !deps.mainWindow.webContents.isDestroyed()
    ) {
      try {
        deps.mainWindow.webContents.send(channel, data);
      } catch {
        // Ignore send failures during window disposal.
      }
    }
  };

  const sessionService = new DevPreviewSessionService(deps.ptyClient, (state) => {
    const payload: DevPreviewStateChangedPayload = { state };
    sendToRenderer(CHANNELS.DEV_PREVIEW_STATE_CHANGED, payload);
  });

  const handleEnsure = async (
    _event: Electron.IpcMainInvokeEvent,
    request: DevPreviewEnsureRequest
  ) => {
    return sessionService.ensure(request);
  };
  ipcMain.handle(CHANNELS.DEV_PREVIEW_ENSURE, handleEnsure);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.DEV_PREVIEW_ENSURE));

  const handleRestart = async (
    _event: Electron.IpcMainInvokeEvent,
    request: DevPreviewSessionRequest
  ) => {
    return sessionService.restart(request);
  };
  ipcMain.handle(CHANNELS.DEV_PREVIEW_RESTART, handleRestart);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.DEV_PREVIEW_RESTART));

  const handleStop = async (
    _event: Electron.IpcMainInvokeEvent,
    request: DevPreviewSessionRequest
  ) => {
    return sessionService.stop(request);
  };
  ipcMain.handle(CHANNELS.DEV_PREVIEW_STOP, handleStop);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.DEV_PREVIEW_STOP));

  const handleGetState = async (
    _event: Electron.IpcMainInvokeEvent,
    request: DevPreviewSessionRequest
  ) => {
    return sessionService.getState(request);
  };
  ipcMain.handle(CHANNELS.DEV_PREVIEW_GET_STATE, handleGetState);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.DEV_PREVIEW_GET_STATE));

  return () => {
    sessionService.dispose();
    handlers.forEach((dispose) => dispose());
  };
}
