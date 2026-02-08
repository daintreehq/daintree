import { ipcMain } from "electron";
import { promises as fs } from "fs";
import path from "path";
import { CHANNELS } from "../channels.js";
import type { HandlerDependencies } from "../types.js";
import { DevPreviewService } from "../../services/DevPreviewService.js";

let devPreviewService: DevPreviewService | null = null;

export function registerDevPreviewHandlers(deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  if (!devPreviewService) {
    devPreviewService = new DevPreviewService(deps.ptyClient);

    devPreviewService.on("status", (data) => {
      if (
        deps.mainWindow &&
        !deps.mainWindow.isDestroyed() &&
        !deps.mainWindow.webContents.isDestroyed()
      ) {
        try {
          deps.mainWindow.webContents.send(CHANNELS.DEV_PREVIEW_STATUS, data);
        } catch {
          // Silently ignore send failures during window disposal.
        }
      }
    });

    devPreviewService.on("url", (data) => {
      if (
        deps.mainWindow &&
        !deps.mainWindow.isDestroyed() &&
        !deps.mainWindow.webContents.isDestroyed()
      ) {
        try {
          deps.mainWindow.webContents.send(CHANNELS.DEV_PREVIEW_URL, data);
        } catch {
          // Silently ignore send failures during window disposal.
        }
      }
    });

    devPreviewService.on("recovery", (data) => {
      if (
        deps.mainWindow &&
        !deps.mainWindow.isDestroyed() &&
        !deps.mainWindow.webContents.isDestroyed()
      ) {
        try {
          deps.mainWindow.webContents.send(CHANNELS.DEV_PREVIEW_RECOVERY, data);
        } catch {
          // Silently ignore send failures during window disposal.
        }
      }
    });
  }

  const handleAttach = async (
    _event: Electron.IpcMainInvokeEvent,
    terminalId: string,
    cwd: string,
    devCommand?: string
  ) => {
    if (!devPreviewService) throw new Error("DevPreviewService not initialized");

    if (!terminalId || typeof terminalId !== "string") {
      throw new Error("terminalId is required");
    }
    if (!cwd || typeof cwd !== "string" || !path.isAbsolute(cwd)) {
      throw new Error("cwd must be an absolute path");
    }
    if (devCommand !== undefined && typeof devCommand !== "string") {
      throw new Error("devCommand must be a string if provided");
    }

    try {
      const stats = await fs.stat(cwd);
      if (!stats.isDirectory()) {
        throw new Error(`cwd is not a directory: ${cwd}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("cwd")) {
        throw error;
      }
      throw new Error(`Cannot access cwd: ${cwd}`);
    }

    return await devPreviewService.attach({
      panelId: terminalId,
      ptyId: terminalId,
      cwd,
      devCommand,
    });
  };
  ipcMain.handle(CHANNELS.DEV_PREVIEW_ATTACH, handleAttach);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.DEV_PREVIEW_ATTACH));

  const handleDetach = async (_event: Electron.IpcMainInvokeEvent, panelId: string) => {
    if (!devPreviewService) throw new Error("DevPreviewService not initialized");
    devPreviewService.detach(panelId);
  };
  ipcMain.handle(CHANNELS.DEV_PREVIEW_DETACH, handleDetach);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.DEV_PREVIEW_DETACH));

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
