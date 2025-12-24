import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";
import type { HandlerDependencies } from "../types.js";
import { DEFAULT_AGENT_SETTINGS } from "../../../shared/types/index.js";
import { AgentHelpService } from "../../services/AgentHelpService.js";
import type { AgentHelpRequest, AgentHelpResult } from "../../../shared/types/ipc/agent.js";

export function registerAiHandlers(_deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];
  const agentHelpService = new AgentHelpService();

  const handleAgentSettingsGet = async () => {
    return store.get("agentSettings");
  };
  ipcMain.handle(CHANNELS.AGENT_SETTINGS_GET, handleAgentSettingsGet);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.AGENT_SETTINGS_GET));

  const handleAgentSettingsSet = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: {
      agentType: string;
      settings: Record<string, unknown>;
    }
  ) => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }
    const { agentType, settings } = payload;
    if (!settings || typeof settings !== "object") {
      throw new Error("Invalid settings object");
    }

    const currentSettings = store.get("agentSettings");
    const updatedSettings = {
      ...currentSettings,
      agents: {
        ...currentSettings.agents,
        [agentType]: {
          ...(currentSettings.agents?.[agentType] ?? {}),
          ...settings,
        },
      },
    };
    store.set("agentSettings", updatedSettings);
    return updatedSettings;
  };
  ipcMain.handle(CHANNELS.AGENT_SETTINGS_SET, handleAgentSettingsSet);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.AGENT_SETTINGS_SET));

  const handleAgentSettingsReset = async (
    _event: Electron.IpcMainInvokeEvent,
    agentType?: string
  ) => {
    if (agentType) {
      const currentSettings = store.get("agentSettings");
      const updatedSettings = {
        ...currentSettings,
        agents: {
          ...currentSettings.agents,
          [agentType]: DEFAULT_AGENT_SETTINGS.agents[agentType] ?? { enabled: true },
        },
      };
      store.set("agentSettings", updatedSettings);
      return updatedSettings;
    } else {
      store.set("agentSettings", DEFAULT_AGENT_SETTINGS);
      return DEFAULT_AGENT_SETTINGS;
    }
  };
  ipcMain.handle(CHANNELS.AGENT_SETTINGS_RESET, handleAgentSettingsReset);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.AGENT_SETTINGS_RESET));

  const handleAgentHelpGet = async (
    _event: Electron.IpcMainInvokeEvent,
    request: AgentHelpRequest
  ): Promise<AgentHelpResult> => {
    if (!request || typeof request !== "object") {
      throw new Error("Invalid request");
    }
    const { agentId, refresh = false } = request;
    if (typeof agentId !== "string" || !agentId) {
      throw new Error("Invalid agentId");
    }
    if (refresh !== undefined && typeof refresh !== "boolean") {
      throw new Error("Invalid refresh parameter");
    }
    return agentHelpService.getHelp(agentId, refresh);
  };
  ipcMain.handle(CHANNELS.AGENT_HELP_GET, handleAgentHelpGet);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.AGENT_HELP_GET));

  return () => handlers.forEach((cleanup) => cleanup());
}
