import { CHANNELS } from "../channels.js";
import type { IdleTerminalNotificationService } from "../../services/IdleTerminalNotificationService.js";
import type { IdleTerminalNotifyConfig } from "../../../shared/types/ipc/idleTerminals.js";
import type { HandlerDependencies } from "../types.js";
import { typedHandle } from "../utils.js";

let cachedService: IdleTerminalNotificationService | null = null;
async function getService(): Promise<IdleTerminalNotificationService> {
  if (!cachedService) {
    const mod = await import("../../services/IdleTerminalNotificationService.js");
    cachedService = mod.getIdleTerminalNotificationService();
  }
  return cachedService;
}

export function registerIdleTerminalHandlers(_deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleGetConfig = async (): Promise<IdleTerminalNotifyConfig> => {
    const service = await getService();
    return service.getConfig();
  };
  handlers.push(typedHandle(CHANNELS.IDLE_TERMINAL_GET_CONFIG, handleGetConfig));

  const handleUpdateConfig = async (
    config: Partial<IdleTerminalNotifyConfig>
  ): Promise<IdleTerminalNotifyConfig> => {
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
  };
  handlers.push(typedHandle(CHANNELS.IDLE_TERMINAL_UPDATE_CONFIG, handleUpdateConfig));

  const handleCloseProject = async (projectId: unknown): Promise<void> => {
    if (typeof projectId !== "string" || projectId.trim() === "") {
      throw new Error("projectId must be a non-empty string");
    }
    const service = await getService();
    await service.closeProject(projectId);
  };
  handlers.push(typedHandle(CHANNELS.IDLE_TERMINAL_CLOSE_PROJECT, handleCloseProject));

  const handleDismissProject = async (projectId: unknown): Promise<void> => {
    if (typeof projectId !== "string" || projectId.trim() === "") {
      throw new Error("projectId must be a non-empty string");
    }
    const service = await getService();
    service.dismissProject(projectId);
  };
  handlers.push(typedHandle(CHANNELS.IDLE_TERMINAL_DISMISS_PROJECT, handleDismissProject));

  return () => handlers.forEach((cleanup) => cleanup());
}
