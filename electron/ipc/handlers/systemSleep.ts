import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import {
  getSystemSleepService,
  type SystemSleepMetrics,
} from "../../services/SystemSleepService.js";
import type { HandlerDependencies } from "../types.js";

export function registerSystemSleepHandlers(deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];
  const systemSleepService = getSystemSleepService();

  const handleGetMetrics = async (): Promise<SystemSleepMetrics> => {
    return systemSleepService.getMetrics();
  };
  ipcMain.handle(CHANNELS.SYSTEM_SLEEP_GET_METRICS, handleGetMetrics);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SYSTEM_SLEEP_GET_METRICS));

  const handleGetAwakeTime = async (
    _event: Electron.IpcMainInvokeEvent,
    startTimestamp: number
  ): Promise<number> => {
    if (typeof startTimestamp !== "number" || !Number.isFinite(startTimestamp)) {
      throw new Error("startTimestamp must be a finite number");
    }
    return systemSleepService.getAwakeTimeSince(startTimestamp);
  };
  ipcMain.handle(CHANNELS.SYSTEM_SLEEP_GET_AWAKE_TIME, handleGetAwakeTime);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SYSTEM_SLEEP_GET_AWAKE_TIME));

  const handleReset = async (): Promise<void> => {
    systemSleepService.reset();
  };
  ipcMain.handle(CHANNELS.SYSTEM_SLEEP_RESET, handleReset);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.SYSTEM_SLEEP_RESET));

  const unsubscribeSuspend = systemSleepService.onSuspend(() => {
    const { mainWindow } = deps;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(CHANNELS.SYSTEM_SLEEP_ON_SUSPEND);
    }
  });

  // Subscribe to wake events and forward to renderer
  const unsubscribeWake = systemSleepService.onWake((sleepDurationMs) => {
    const { mainWindow } = deps;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(CHANNELS.SYSTEM_SLEEP_ON_WAKE, sleepDurationMs);
    }
  });

  return () => {
    handlers.forEach((cleanup) => cleanup());
    unsubscribeSuspend();
    unsubscribeWake();
  };
}
