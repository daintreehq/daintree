import type {
  AgentRegistry,
  AgentMetadata,
  ResolvedModelCatalog,
} from "@shared/types/ipc/agentCapabilities";

export const agentCapabilitiesClient = {
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
