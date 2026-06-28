import type { IdleBackgroundAutoCloseService } from "../../services/IdleBackgroundAutoCloseService.js";
import type { IdleBackgroundAutoCloseConfig } from "../../../shared/types/ipc/idleBackgroundAutoClose.js";
import type { HandlerDependencies } from "../types.js";
import { defineIpcNamespace, op } from "../define.js";
import { IDLE_BACKGROUND_METHOD_CHANNELS } from "./idleBackgroundAutoClose.preload.js";

let cachedService: IdleBackgroundAutoCloseService | null = null;
async function getService(): Promise<IdleBackgroundAutoCloseService> {
  if (!cachedService) {
    const mod = await import("../../services/IdleBackgroundAutoCloseService.js");
    cachedService = mod.getIdleBackgroundAutoCloseService();
  }
  return cachedService;
}

export const idleBackgroundAutoCloseNamespace = defineIpcNamespace({
  name: "idleBackgroundAutoClose",
  ops: {
    getConfig: op(
      IDLE_BACKGROUND_METHOD_CHANNELS.getConfig,
      async (): Promise<IdleBackgroundAutoCloseConfig> => {
        const service = await getService();
        return service.getConfig();
      }
    ),
    updateConfig: op(
      IDLE_BACKGROUND_METHOD_CHANNELS.updateConfig,
      async (
        config: Partial<IdleBackgroundAutoCloseConfig>
      ): Promise<IdleBackgroundAutoCloseConfig> => {
        if (typeof config !== "object" || config === null || Array.isArray(config)) {
          throw new Error("Invalid config object");
        }
        if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
          throw new Error("enabled must be a boolean");
        }
        if (config.thresholdMinutes !== undefined) {
          if (typeof config.thresholdMinutes !== "number") {
            throw new Error("thresholdMinutes must be a number");
          }
          if (!Number.isFinite(config.thresholdMinutes)) {
            throw new Error("thresholdMinutes must be a finite number");
          }
          const rounded = Math.round(config.thresholdMinutes);
          if (rounded < 15 || rounded > 1440) {
            throw new Error("thresholdMinutes must be between 15 and 1440");
          }
        }
        const service = await getService();
        return service.updateConfig(config);
      }
    ),
  },
});

export function registerIdleBackgroundAutoCloseHandlers(_deps: HandlerDependencies): () => void {
  return idleBackgroundAutoCloseNamespace.register();
}
