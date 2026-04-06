import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import { broadcastToRenderer } from "../utils.js";
import {
  getSystemSleepService,
  type SystemSleepMetrics,
} from "../../services/SystemSleepService.js";
import type { HandlerDependencies } from "../types.js";

export function registerSystemSleepHandlers(_deps: HandlerDependencies): () => void {
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
    broadcastToRenderer(CHANNELS.SYSTEM_SLEEP_ON_SUSPEND);
  });

  const unsubscribeWake = systemSleepService.onWake((sleepDurationMs) => {
    broadcastToRenderer(CHANNELS.SYSTEM_SLEEP_ON_WAKE, sleepDurationMs);
  });

  return () => {
    handlers.forEach((cleanup) => cleanup());
    unsubscribeSuspend();
    unsubscribeWake();
  };
}
