import { BrowserWindow, ipcMain } from "electron";
import type { IpcInvokeMap, IpcEventMap } from "../types/index.js";

export function sendToRenderer(
  mainWindow: BrowserWindow,
  channel: string,
  ...args: unknown[]
): void {
  const webContents = mainWindow?.webContents;
  if (!mainWindow || mainWindow.isDestroyed() || !webContents) {
    return;
  }

  if (typeof webContents.send !== "function") {
    return;
  }

  if (typeof webContents.isDestroyed === "function" && webContents.isDestroyed()) {
    return;
  }

  try {
    webContents.send(channel, ...args);
  } catch {
    // Silently ignore send failures during window initialization/disposal.
  }
}

export function typedHandle<K extends keyof IpcInvokeMap>(
  channel: K,
  handler: (
    ...args: IpcInvokeMap[K]["args"]
  ) => Promise<IpcInvokeMap[K]["result"]> | IpcInvokeMap[K]["result"]
): () => void {
  ipcMain.handle(channel as string, async (_event, ...args) => {
    return handler(...(args as IpcInvokeMap[K]["args"]));
  });
  return () => ipcMain.removeHandler(channel as string);
}

export function typedSend<K extends keyof IpcEventMap>(
  window: BrowserWindow,
  channel: K,
  payload: IpcEventMap[K]
): void {
  const webContents = window?.webContents;
  if (!window || window.isDestroyed() || !webContents) {
    return;
  }

  if (typeof webContents.send !== "function") {
    return;
  }

  if (typeof webContents.isDestroyed === "function" && webContents.isDestroyed()) {
    return;
  }

  try {
    webContents.send(channel as string, payload);
  } catch {
    // Silently ignore send failures during window initialization/disposal.
  }
}
