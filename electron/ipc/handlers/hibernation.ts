import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import {
  getHibernationService,
  type HibernationConfig,
} from "../../services/HibernationService.js";
import type { HandlerDependencies } from "../types.js";

export function registerHibernationHandlers(_deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];
  const hibernationService = getHibernationService();

  const handleGetConfig = async (): Promise<HibernationConfig> => {
    return hibernationService.getConfig();
  };
  ipcMain.handle(CHANNELS.HIBERNATION_GET_CONFIG, handleGetConfig);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.HIBERNATION_GET_CONFIG));

  const handleUpdateConfig = async (
    _event: Electron.IpcMainInvokeEvent,
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
  ipcMain.handle(CHANNELS.HIBERNATION_UPDATE_CONFIG, handleUpdateConfig);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.HIBERNATION_UPDATE_CONFIG));

  return () => handlers.forEach((cleanup) => cleanup());
}
