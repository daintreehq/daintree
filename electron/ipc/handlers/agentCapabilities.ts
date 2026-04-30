import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";
import { CcrConfigService } from "../../services/CcrConfigService.js";
import {
  AGENT_REGISTRY,
  getEffectiveRegistry,
  getEffectiveAgentIds,
  getEffectiveAgentConfig,
  type AgentConfig,
} from "../../../shared/config/agentRegistry.js";
import type { AgentMetadata } from "../../../shared/types/ipc/agentCapabilities.js";
import { isAgentPinned } from "../../../shared/utils/agentPinned.js";
import { typedHandle } from "../utils.js";

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
  handlers.push(typedHandle(CHANNELS.AGENT_CAPABILITIES_GET_REGISTRY, handleGetRegistry));

  const handleGetAgentIds = async () => {
    return getEffectiveAgentIds();
  };
  handlers.push(typedHandle(CHANNELS.AGENT_CAPABILITIES_GET_AGENT_IDS, handleGetAgentIds));

  const handleGetAgentMetadata = async (agentId: string): Promise<AgentMetadata | null> => {
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
  handlers.push(
    typedHandle(CHANNELS.AGENT_CAPABILITIES_GET_AGENT_METADATA, handleGetAgentMetadata)
  );

  const handleIsAgentEnabled = async (agentId: string): Promise<boolean> => {
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
    return isAgentPinned(agentEntry);
  };
  handlers.push(typedHandle(CHANNELS.AGENT_CAPABILITIES_IS_AGENT_ENABLED, handleIsAgentEnabled));

  const handleGetCcrPresets = async () => {
    return CcrConfigService.getInstance().getPresets();
  };
  handlers.push(typedHandle(CHANNELS.AGENT_CAPABILITIES_GET_CCR_PRESETS, handleGetCcrPresets));

  return () => handlers.forEach((cleanup) => cleanup());
}
