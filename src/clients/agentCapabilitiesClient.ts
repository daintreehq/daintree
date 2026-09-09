import type {
  CapabilitySearchRequest,
  CapabilityGetRequest,
} from "@shared/types/agentCapabilities";
import type {
  AgentRegistry,
  AgentMetadata,
  ResolvedModelCatalog,
} from "@shared/types/ipc/agentCapabilities";

export const agentCapabilitiesClient = {
  search: (request: CapabilitySearchRequest) => window.electron.agentCapabilities.search(request),
  get: (request: CapabilityGetRequest) => window.electron.agentCapabilities.get(request),
  getRegistry: (): Promise<AgentRegistry> => {
    return window.electron.agentCapabilities.getRegistry();
  },

  getAgentIds: (): Promise<string[]> => {
    return window.electron.agentCapabilities.getAgentIds();
  },

  getAgentMetadata: (agentId: string): Promise<AgentMetadata | null> => {
    return window.electron.agentCapabilities.getAgentMetadata(agentId);
  },

  isAgentEnabled: (agentId: string): Promise<boolean> => {
    return window.electron.agentCapabilities.isAgentEnabled(agentId);
  },

  getResolvedModelList: (agentId: string): Promise<ResolvedModelCatalog | null> => {
    return window.electron.agentCapabilities.getResolvedModelList(agentId);
  },
} as const;
