import { CHANNELS } from "../channels.js";
import {
  getHibernationService,
  type HibernationConfig,
} from "../../services/HibernationService.js";
import type { HandlerDependencies } from "../types.js";
import { typedHandle } from "../utils.js";

export function registerHibernationHandlers(_deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];
  const hibernationService = getHibernationService();

  const handleGetConfig = async (): Promise<HibernationConfig> => {
    return hibernationService.getConfig();
  };
  handlers.push(typedHandle(CHANNELS.HIBERNATION_GET_CONFIG, handleGetConfig));

  const handleUpdateConfig = async (
    config: Partial<HibernationConfig>
  ): Promise<HibernationConfig> => {
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
  };
  handlers.push(typedHandle(CHANNELS.HIBERNATION_UPDATE_CONFIG, handleUpdateConfig));

  return () => handlers.forEach((cleanup) => cleanup());
}
