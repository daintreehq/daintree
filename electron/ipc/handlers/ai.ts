import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";
import type { HandlerDependencies } from "../types.js";
import { DEFAULT_AGENT_SETTINGS, type UserAgentConfig } from "../../../shared/types/index.js";
import { AgentHelpService } from "../../services/AgentHelpService.js";
import { UserAgentRegistryService } from "../../services/UserAgentRegistryService.js";
import type { AgentHelpRequest, AgentHelpResult } from "../../../shared/types/ipc/agent.js";

const RESERVED_AGENT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

interface NormalizedAgentSettings {
  root: Record<string, unknown>;
  agents: Record<string, Record<string, unknown>>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateAgentType(agentType: unknown): string {
  if (typeof agentType !== "string") {
    throw new Error("Invalid agentType");
  }
  const trimmed = agentType.trim();
  if (!trimmed) {
    throw new Error("Invalid agentType");
  }
  if (RESERVED_AGENT_KEYS.has(trimmed)) {
    throw new Error(`Invalid agentType: reserved key "${trimmed}"`);
  }
  return trimmed;
}

function normalizeAgentSettings(value: unknown): NormalizedAgentSettings {
  const root = isPlainRecord(value) ? { ...(value as Record<string, unknown>) } : {};

  const agents: Record<string, Record<string, unknown>> = {};
  const rawAgents = root.agents;
  if (isPlainRecord(rawAgents)) {
    for (const [agentId, entry] of Object.entries(rawAgents as Record<string, unknown>)) {
      if (!agentId || RESERVED_AGENT_KEYS.has(agentId)) {
        continue;
      }
      if (isPlainRecord(entry)) {
        agents[agentId] = { ...(entry as Record<string, unknown>) };
      }
    }
  }

  return { root, agents };
}

export function registerAiHandlers(_deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];
  const agentHelpService = new AgentHelpService();
  const userAgentRegistryService = new UserAgentRegistryService();

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
    if (!isPlainRecord(payload)) {
      throw new Error("Invalid payload");
    }
    const { agentType, settings } = payload;
    const safeAgentType = validateAgentType(agentType);
    if (!isPlainRecord(settings)) {
      throw new Error("Invalid settings object");
    }

    const currentSettings = normalizeAgentSettings(
      store.get("agentSettings", DEFAULT_AGENT_SETTINGS)
    );
    const updatedSettings = {
      ...currentSettings.root,
      agents: {
        ...currentSettings.agents,
        [safeAgentType]: {
          ...(currentSettings.agents?.[safeAgentType] ?? {}),
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
    agentType?: unknown
  ) => {
    if (agentType !== undefined) {
      const safeAgentType = validateAgentType(agentType);
      const currentSettings = normalizeAgentSettings(
        store.get("agentSettings", DEFAULT_AGENT_SETTINGS)
      );
      const updatedSettings = {
        ...currentSettings.root,
        agents: {
          ...currentSettings.agents,
          [safeAgentType]: DEFAULT_AGENT_SETTINGS.agents[safeAgentType] ?? { enabled: true },
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

  const handleUserAgentRegistryGet = async () => {
    return userAgentRegistryService.getRegistry();
  };
  ipcMain.handle(CHANNELS.USER_AGENT_REGISTRY_GET, handleUserAgentRegistryGet);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.USER_AGENT_REGISTRY_GET));

  const handleUserAgentRegistryAdd = async (
    _event: Electron.IpcMainInvokeEvent,
    config: UserAgentConfig
  ) => {
    if (!config || typeof config !== "object") {
      throw new Error("Invalid config");
    }
    return userAgentRegistryService.addAgent(config);
  };
  ipcMain.handle(CHANNELS.USER_AGENT_REGISTRY_ADD, handleUserAgentRegistryAdd);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.USER_AGENT_REGISTRY_ADD));

  const handleUserAgentRegistryUpdate = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: { id: string; config: UserAgentConfig }
  ) => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }
    const { id, config } = payload;
    if (typeof id !== "string" || !id.trim()) {
      throw new Error("Invalid id");
    }
    if (!config || typeof config !== "object") {
      throw new Error("Invalid config");
    }
    return userAgentRegistryService.updateAgent(id, config);
  };
  ipcMain.handle(CHANNELS.USER_AGENT_REGISTRY_UPDATE, handleUserAgentRegistryUpdate);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.USER_AGENT_REGISTRY_UPDATE));

  const handleUserAgentRegistryRemove = async (_event: Electron.IpcMainInvokeEvent, id: string) => {
    if (!id || typeof id !== "string") {
      throw new Error("Invalid id");
    }
    return userAgentRegistryService.removeAgent(id);
  };
  ipcMain.handle(CHANNELS.USER_AGENT_REGISTRY_REMOVE, handleUserAgentRegistryRemove);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.USER_AGENT_REGISTRY_REMOVE));

  return () => handlers.forEach((cleanup) => cleanup());
}
