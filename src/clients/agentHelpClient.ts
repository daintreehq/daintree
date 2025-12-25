import type { AgentHelpRequest, AgentHelpResult } from "@shared/types/ipc/agent";

export const agentHelpClient = {
  get: (request: AgentHelpRequest): Promise<AgentHelpResult> => {
    return window.electron.agentHelp.get(request);
  },
} as const;
