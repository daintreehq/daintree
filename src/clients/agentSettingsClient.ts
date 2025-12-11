import type { AgentSettings, AgentSettingsEntry } from "@shared/types";

export const agentSettingsClient = {
  get: (): Promise<AgentSettings> => {
    return window.electron.agentSettings.get();
  },

  set: (agentId: string, settings: Partial<AgentSettingsEntry>): Promise<AgentSettings> => {
    return window.electron.agentSettings.set(agentId, settings);
  },

  reset: (agentType?: string): Promise<AgentSettings> => {
    return window.electron.agentSettings.reset(agentType);
  },
} as const;
