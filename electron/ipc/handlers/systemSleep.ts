import { CHANNELS } from "../channels.js";
import { defineIpcNamespace, op } from "../define.js";
import { broadcastToRenderer } from "../utils.js";
import { getSystemSleepService } from "../../services/SystemSleepService.js";
import type { SystemSleepMetrics } from "../../../shared/types/ipc/systemSleep.js";
import type { HandlerDependencies } from "../types.js";

async function handleGetMetrics(): Promise<SystemSleepMetrics> {
  return getSystemSleepService().getMetrics();
}

async function handleGetAwakeTime(startTimestamp: number): Promise<number> {
  if (typeof startTimestamp !== "number" || !Number.isFinite(startTimestamp)) {
    throw new Error("startTimestamp must be a finite number");
  }
  return getSystemSleepService().getAwakeTimeSince(startTimestamp);
}

async function handleReset(): Promise<void> {
  getSystemSleepService().reset();
}

export const systemSleepNamespace = defineIpcNamespace({
  name: "system-sleep",
  ops: {
    getMetrics: op(CHANNELS.SYSTEM_SLEEP_GET_METRICS, handleGetMetrics),
    getAwakeTime: op(CHANNELS.SYSTEM_SLEEP_GET_AWAKE_TIME, handleGetAwakeTime),
    reset: op(CHANNELS.SYSTEM_SLEEP_RESET, handleReset),
  },
});

export function registerSystemSleepHandlers(_deps: HandlerDependencies): () => void {
  const cleanups: Array<() => void> = [];
  const systemSleepService = getSystemSleepService();

  cleanups.push(systemSleepNamespace.register());

  const unsubscribeSuspend = systemSleepService.onSuspend(() => {
    broadcastToRenderer(CHANNELS.SYSTEM_SLEEP_ON_SUSPEND);
  });
  cleanups.push(unsubscribeSuspend);

  const unsubscribeWake = systemSleepService.onWake((sleepDurationMs) => {
    broadcastToRenderer(CHANNELS.SYSTEM_SLEEP_ON_WAKE, sleepDurationMs);
  });
  cleanups.push(unsubscribeWake);

  return () => cleanups.forEach((cleanup) => cleanup());
}
