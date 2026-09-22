import { getPowerSaveBlockerService } from "../../services/PowerSaveBlockerService.js";
import type { KeepAwakeConfig, KeepAwakeState } from "../../../shared/types/ipc/keepAwake.js";
import type { HandlerDependencies } from "../types.js";
import { defineIpcNamespace, op } from "../define.js";
import { KEEP_AWAKE_METHOD_CHANNELS } from "./keepAwake.preload.js";

const CONFIG_KEYS = new Set<string>(["enabled", "onBattery"]);

/**
 * The service is resolved per call rather than at registration: it is a global
 * that shutdown disposes, and a captured reference would outlive it.
 */
export function registerKeepAwakeHandlers(_deps: HandlerDependencies): () => void {
  const namespace = defineIpcNamespace({
    name: "keepAwake",
    ops: {
      getState: op(KEEP_AWAKE_METHOD_CHANNELS.getState, async (): Promise<KeepAwakeState> =>
        getPowerSaveBlockerService().getState()
      ),
      updateConfig: op(
        KEEP_AWAKE_METHOD_CHANNELS.updateConfig,
        async (config: Partial<KeepAwakeConfig>): Promise<KeepAwakeState> => {
          if (typeof config !== "object" || config === null || Array.isArray(config)) {
            throw new Error("Invalid config object");
          }
          for (const key of Object.keys(config)) {
            if (!CONFIG_KEYS.has(key)) {
              throw new Error(`Unknown keep-awake setting: ${key}`);
            }
          }
          if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
            throw new Error("enabled must be a boolean");
          }
          if (config.onBattery !== undefined && typeof config.onBattery !== "boolean") {
            throw new Error("onBattery must be a boolean");
          }
          return getPowerSaveBlockerService().updateConfig({
            ...(config.enabled !== undefined ? { enabled: config.enabled } : {}),
            ...(config.onBattery !== undefined ? { onBattery: config.onBattery } : {}),
          });
        }
      ),
    },
  });

  return namespace.register();
}
