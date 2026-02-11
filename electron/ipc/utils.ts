import { BrowserWindow, ipcMain } from "electron";
import type { IpcInvokeMap, IpcEventMap } from "../types/index.js";
import { performance } from "node:perf_hooks";
import { PERF_MARKS } from "../../shared/perf/marks.js";
import {
  isPerformanceCaptureEnabled,
  markPerformance,
  sampleIpcTiming,
} from "../utils/performance.js";

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
  const captureEnabled = isPerformanceCaptureEnabled();

  ipcMain.handle(channel as string, async (_event, ...args) => {
    if (!captureEnabled) {
      return await handler(...(args as IpcInvokeMap[K]["args"]));
    }

    const startedAt = performance.now();
    markPerformance(PERF_MARKS.IPC_REQUEST_START, { channel: channel as string });

    try {
      return await handler(...(args as IpcInvokeMap[K]["args"]));
    } finally {
      const durationMs = performance.now() - startedAt;
      markPerformance(PERF_MARKS.IPC_REQUEST_END, {
        channel: channel as string,
        durationMs,
      });
      sampleIpcTiming(channel as string, durationMs);
    }
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
