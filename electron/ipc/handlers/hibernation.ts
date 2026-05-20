import { getHibernationService } from "../../services/HibernationService.js";
import type { HibernationConfig } from "../../../shared/types/ipc/hibernation.js";
import type { HandlerDependencies } from "../types.js";
import { defineIpcNamespace, op } from "../define.js";
import { HIBERNATION_METHOD_CHANNELS } from "./hibernation.preload.js";

export function registerHibernationHandlers(_deps: HandlerDependencies): () => void {
  const hibernationService = getHibernationService();

  const namespace = defineIpcNamespace({
    name: "hibernation",
    ops: {
      getConfig: op(
        HIBERNATION_METHOD_CHANNELS.getConfig,
        async (): Promise<HibernationConfig> => {
          return hibernationService.getConfig();
        }
      ),
      updateConfig: op(
        HIBERNATION_METHOD_CHANNELS.updateConfig,
        async (config: Partial<HibernationConfig>): Promise<HibernationConfig> => {
          if (typeof config !== "object" || config === null || Array.isArray(config)) {
            throw new Error("Invalid config object");
          }

          if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
            throw new Error("enabled must be a boolean");
          }

          if (config.inactiveThresholdHours !== undefined) {
            if (typeof config.inactiveThresholdHours !== "number") {
              throw new Error("inactiveThresholdHours must be a number");
            }
            if (!Number.isFinite(config.inactiveThresholdHours)) {
              throw new Error("inactiveThresholdHours must be a finite number");
            }
            const rounded = Math.round(config.inactiveThresholdHours);
            if (rounded < 1 || rounded > 168) {
              throw new Error("inactiveThresholdHours must be between 1 and 168");
            }
          }

          hibernationService.updateConfig(config);
          return hibernationService.getConfig();
        }
      ),
    },
  });

  return namespace.register();
}
