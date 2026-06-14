// eager-import-allow: reads agent-capability settings via store.get synchronously in the IPC handler
import { store } from "../../store.js";
import { CcrConfigService } from "../../services/CcrConfigService.js";
import {
  AGENT_REGISTRY,
  getEffectiveRegistry,
  getEffectiveAgentIds,
  getEffectiveAgentConfig,
  type AgentConfig,
} from "../../../shared/config/agentRegistry.js";
import type {
  AgentMetadata,
  AgentRegistry,
  ResolvedModelCatalog,
} from "../../../shared/types/ipc/agentCapabilities.js";
import type { AgentPreset } from "../../../shared/config/agentRegistry.js";
import { isAgentPinned } from "../../../shared/utils/agentPinned.js";
import { defineIpcNamespace, op } from "../define.js";
import { AGENT_CAPABILITIES_METHOD_CHANNELS } from "./agentCapabilities.preload.js";
import { getAgentModelCatalogService } from "../../window/serviceRefs.js";

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
    hasVersionConfig: !!config.version,
    hasUpdateConfig: !!config.update,
    hasInstallHelp: !!config.install,
    isBuiltIn,
    isUserDefined: !isBuiltIn,
  };
}

export const agentCapabilitiesNamespace = defineIpcNamespace({
  name: "agentCapabilities",
  ops: {
    getRegistry: op(
      AGENT_CAPABILITIES_METHOD_CHANNELS.getRegistry,
      async (): Promise<AgentRegistry> => {
        return getEffectiveRegistry();
      }
    ),
    getAgentIds: op(AGENT_CAPABILITIES_METHOD_CHANNELS.getAgentIds, async (): Promise<string[]> => {
      return getEffectiveAgentIds();
    }),
    getAgentMetadata: op(
      AGENT_CAPABILITIES_METHOD_CHANNELS.getAgentMetadata,
      async (agentId: string): Promise<AgentMetadata | null> => {
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
      }
    ),
    isAgentEnabled: op(
      AGENT_CAPABILITIES_METHOD_CHANNELS.isAgentEnabled,
      async (agentId: string): Promise<boolean> => {
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
      }
    ),
    getCcrPresets: op(
      AGENT_CAPABILITIES_METHOD_CHANNELS.getCcrPresets,
      async (): Promise<AgentPreset[]> => {
        return CcrConfigService.getInstance().loadAndApply();
      }
    ),
    getResolvedModelList: op(
      AGENT_CAPABILITIES_METHOD_CHANNELS.getResolvedModelList,
      async (agentId: string): Promise<ResolvedModelCatalog | null> => {
        if (!agentId || typeof agentId !== "string") {
          throw new Error("Invalid agentId");
        }
        if (agentId === "__proto__" || agentId === "constructor" || agentId === "prototype") {
          throw new Error("Invalid agentId: reserved keyword");
        }
        const config = getEffectiveAgentConfig(agentId);
        if (!config) return null;

        const service = getAgentModelCatalogService();
        if (service) {
          try {
            return await service.getResolvedModels(agentId);
          } catch (err) {
            console.warn(
              "[agentCapabilities] getResolvedModelList resolver failed, returning bundled fallback",
              err
            );
          }
        }

        return {
          agentId,
          models: config.models ? [...config.models] : [],
          contextWindow: config.contextWindow ?? null,
          source: "bundled",
        };
      }
    ),
  },
});

export function registerAgentCapabilitiesHandlers(): () => void {
  return agentCapabilitiesNamespace.register();
}
