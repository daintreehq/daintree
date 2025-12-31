import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import type { HandlerDependencies } from "../types.js";
import { DevPreviewService } from "../../services/DevPreviewService.js";

let devPreviewService: DevPreviewService | null = null;

export function registerDevPreviewHandlers(deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  if (!devPreviewService) {
    devPreviewService = new DevPreviewService(deps.ptyClient);

    devPreviewService.on("status", (data) => {
      deps.mainWindow.webContents.send(CHANNELS.DEV_PREVIEW_STATUS, data);
    });

    devPreviewService.on("url", (data) => {
      deps.mainWindow.webContents.send(CHANNELS.DEV_PREVIEW_URL, data);
    });
  }

  const handleStart = async (
    _event: Electron.IpcMainInvokeEvent,
    panelId: string,
    cwd: string,
    cols: number,
    rows: number,
    devCommand?: string
  ) => {
    if (!devPreviewService) throw new Error("DevPreviewService not initialized");
    // Validate devCommand if provided
    const validatedDevCommand =
      devCommand !== undefined && typeof devCommand === "string" ? devCommand : undefined;
    await devPreviewService.start({ panelId, cwd, cols, rows, devCommand: validatedDevCommand });
  };
  ipcMain.handle(CHANNELS.DEV_PREVIEW_START, handleStart);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.DEV_PREVIEW_START));

  const handleStop = async (_event: Electron.IpcMainInvokeEvent, panelId: string) => {
    if (!devPreviewService) throw new Error("DevPreviewService not initialized");
    await devPreviewService.stop(panelId);
  };
  ipcMain.handle(CHANNELS.DEV_PREVIEW_STOP, handleStop);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.DEV_PREVIEW_STOP));

  const handleRestart = async (_event: Electron.IpcMainInvokeEvent, panelId: string) => {
    if (!devPreviewService) throw new Error("DevPreviewService not initialized");
    await devPreviewService.restart(panelId);
  };
  ipcMain.handle(CHANNELS.DEV_PREVIEW_RESTART, handleRestart);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.DEV_PREVIEW_RESTART));

  const handleSetUrl = async (
    _event: Electron.IpcMainInvokeEvent,
    panelId: string,
    url: string
  ) => {
    if (!devPreviewService) throw new Error("DevPreviewService not initialized");
    devPreviewService.setUrl(panelId, url);
  };
  ipcMain.handle(CHANNELS.DEV_PREVIEW_SET_URL, handleSetUrl);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.DEV_PREVIEW_SET_URL));

  return () => {
    handlers.forEach((dispose) => dispose());
  };
}
