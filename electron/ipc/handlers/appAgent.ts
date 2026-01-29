import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import type { HandlerDependencies } from "../types.js";
import { appAgentService } from "../../services/AppAgentService.js";
import type { AppAgentConfig } from "../../../shared/types/appAgent.js";
import { AppAgentConfigSchema } from "../../../shared/types/appAgent.js";

export function registerAppAgentHandlers(_deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleGetConfig = async () => {
    return appAgentService.getConfig();
  };
  ipcMain.handle(CHANNELS.APP_AGENT_GET_CONFIG, handleGetConfig);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.APP_AGENT_GET_CONFIG));

  const handleSetConfig = async (
    _event: Electron.IpcMainInvokeEvent,
    config: Partial<AppAgentConfig>
  ) => {
    if (!config || typeof config !== "object") {
      throw new Error("Invalid config");
    }

    const configResult = AppAgentConfigSchema.partial().safeParse(config);
    if (!configResult.success) {
      throw new Error(`Invalid config: ${configResult.error.message}`);
    }

    appAgentService.setConfig(configResult.data);
    return appAgentService.getConfig();
  };
  ipcMain.handle(CHANNELS.APP_AGENT_SET_CONFIG, handleSetConfig);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.APP_AGENT_SET_CONFIG));

  const handleHasApiKey = async () => {
    return appAgentService.hasApiKey();
  };
  ipcMain.handle(CHANNELS.APP_AGENT_HAS_API_KEY, handleHasApiKey);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.APP_AGENT_HAS_API_KEY));

  const handleTestApiKey = async (_event: Electron.IpcMainInvokeEvent, apiKey: string) => {
    if (!apiKey || typeof apiKey !== "string") {
      throw new Error("Invalid API key");
    }
    return appAgentService.testApiKey(apiKey.trim());
  };
  ipcMain.handle(CHANNELS.APP_AGENT_TEST_API_KEY, handleTestApiKey);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.APP_AGENT_TEST_API_KEY));

  const handleTestModel = async (_event: Electron.IpcMainInvokeEvent, model: string) => {
    if (!model || typeof model !== "string") {
      throw new Error("Invalid model");
    }
    return appAgentService.testModel(model.trim());
  };
  ipcMain.handle(CHANNELS.APP_AGENT_TEST_MODEL, handleTestModel);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.APP_AGENT_TEST_MODEL));

  return () => handlers.forEach((cleanup) => cleanup());
}
