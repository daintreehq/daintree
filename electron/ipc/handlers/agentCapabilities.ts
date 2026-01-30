import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";
import {
  AGENT_REGISTRY,
  getEffectiveRegistry,
  getEffectiveAgentIds,
  getEffectiveAgentConfig,
  type AgentConfig,
} from "../../../shared/config/agentRegistry.js";
import type { AgentMetadata } from "../../../shared/types/ipc/agentCapabilities.js";

function toAgentMetadata(config: AgentConfig, agentId: string): AgentMetadata {
  const isBuiltIn = agentId in AGENT_REGISTRY;
  return {
    id: config.id,
    name: config.name,
    command: config.command,
    color: config.color,
    iconId: config.iconId,
    supportsContextInjection: config.supportsContextInjection,
    shortcut: config.shortcut,
    tooltip: config.tooltip,
    usageUrl: config.usageUrl,
    capabilities: config.capabilities,
    routing: config.routing,
    hasDetection: !!config.detection,
    hasVersionConfig: !!config.version,
    hasUpdateConfig: !!config.update,
    hasInstallHelp: !!config.install,
    hasRoutingConfig: !!config.routing,
    isBuiltIn,
    isUserDefined: !isBuiltIn,
  };
}

export function registerAgentCapabilitiesHandlers(): () => void {
  const handlers: Array<() => void> = [];

  const handleGetRegistry = async () => {
    return getEffectiveRegistry();
  };
  ipcMain.handle(CHANNELS.AGENT_CAPABILITIES_GET_REGISTRY, handleGetRegistry);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.AGENT_CAPABILITIES_GET_REGISTRY));

  const handleGetAgentIds = async () => {
    return getEffectiveAgentIds();
  };
  ipcMain.handle(CHANNELS.AGENT_CAPABILITIES_GET_AGENT_IDS, handleGetAgentIds);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.AGENT_CAPABILITIES_GET_AGENT_IDS));

  const handleGetAgentMetadata = async (
    _event: Electron.IpcMainInvokeEvent,
    agentId: string
  ): Promise<AgentMetadata | null> => {
    if (!agentId || typeof agentId !== "string") {
      throw new Error("Invalid agentId");
    }
    if (agentId === "__proto__" || agentId === "constructor" || agentId === "prototype") {
      throw new Error("Invalid agentId: reserved keyword");
    }
    const config = getEffectiveAgentConfig(agentId);
    if (!config) {
      return null;
    }
    return toAgentMetadata(config, agentId);
  };
  ipcMain.handle(CHANNELS.AGENT_CAPABILITIES_GET_AGENT_METADATA, handleGetAgentMetadata);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.AGENT_CAPABILITIES_GET_AGENT_METADATA));

  const handleIsAgentEnabled = async (
    _event: Electron.IpcMainInvokeEvent,
    agentId: string
  ): Promise<boolean> => {
    if (!agentId || typeof agentId !== "string") {
      throw new Error("Invalid agentId");
    }
    if (agentId === "__proto__" || agentId === "constructor" || agentId === "prototype") {
      throw new Error("Invalid agentId: reserved keyword");
    }
    const config = getEffectiveAgentConfig(agentId);
    if (!config) {
      return false;
    }
    const agentSettings = store.get("agentSettings");
    const agentEntry = agentSettings?.agents?.[agentId];
    return agentEntry?.enabled !== false;
  };
  ipcMain.handle(CHANNELS.AGENT_CAPABILITIES_IS_AGENT_ENABLED, handleIsAgentEnabled);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.AGENT_CAPABILITIES_IS_AGENT_ENABLED));

  return () => handlers.forEach((cleanup) => cleanup());
}
