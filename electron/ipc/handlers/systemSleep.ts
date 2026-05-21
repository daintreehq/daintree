import { CHANNELS } from "../channels.js";
import { broadcastToRenderer } from "../utils.js";
import { getSystemSleepService } from "../../services/SystemSleepService.js";
import type { SystemSleepMetrics } from "../../../shared/types/ipc/systemSleep.js";
import type { HandlerDependencies } from "../types.js";
import { defineIpcNamespace, op } from "../define.js";
import { SYSTEM_SLEEP_METHOD_CHANNELS } from "./systemSleep.preload.js";

export function registerSystemSleepHandlers(_deps: HandlerDependencies): () => void {
  const systemSleepService = getSystemSleepService();

  const namespace = defineIpcNamespace({
    name: "systemSleep",
    ops: {
      getMetrics: op(
        SYSTEM_SLEEP_METHOD_CHANNELS.getMetrics,
        async (): Promise<SystemSleepMetrics> => {
          return systemSleepService.getMetrics();
        }
      ),
      getAwakeTime: op(
        SYSTEM_SLEEP_METHOD_CHANNELS.getAwakeTime,
        async (startTimestamp: number): Promise<number> => {
          if (typeof startTimestamp !== "number" || !Number.isFinite(startTimestamp)) {
            throw new Error("startTimestamp must be a finite number");
          }
          return systemSleepService.getAwakeTimeSince(startTimestamp);
        }
      ),
      reset: op(SYSTEM_SLEEP_METHOD_CHANNELS.reset, async (): Promise<void> => {
        systemSleepService.reset();
      }),
    },
  });

  const cleanups: Array<() => void> = [];
  cleanups.push(namespace.register());

  cleanups.push(
    systemSleepService.onSuspend(() => {
      broadcastToRenderer(CHANNELS.SYSTEM_SLEEP_ON_SUSPEND);
    })
  );

  cleanups.push(
    systemSleepService.onWake((sleepDurationMs) => {
      broadcastToRenderer(CHANNELS.SYSTEM_SLEEP_ON_WAKE, sleepDurationMs);
    })
  );

  return () => cleanups.forEach((cleanup) => cleanup());
}
