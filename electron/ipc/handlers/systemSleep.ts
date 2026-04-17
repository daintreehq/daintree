import { CHANNELS } from "../channels.js";
import { broadcastToRenderer, typedHandle } from "../utils.js";
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
  handlers.push(typedHandle(CHANNELS.SYSTEM_SLEEP_GET_METRICS, handleGetMetrics));

  const handleGetAwakeTime = async (startTimestamp: number): Promise<number> => {
    if (typeof startTimestamp !== "number" || !Number.isFinite(startTimestamp)) {
      throw new Error("startTimestamp must be a finite number");
    }
    return systemSleepService.getAwakeTimeSince(startTimestamp);
  };
  handlers.push(typedHandle(CHANNELS.SYSTEM_SLEEP_GET_AWAKE_TIME, handleGetAwakeTime));

  const handleReset = async (): Promise<void> => {
    systemSleepService.reset();
  };
  handlers.push(typedHandle(CHANNELS.SYSTEM_SLEEP_RESET, handleReset));

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
