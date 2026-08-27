import type {
  AgentSubagentsResult,
  AgentSubagentTranscriptResult,
} from "@shared/types/ipc/agentSubagents";

/**
 * @example
 * const result = await claudeClient.listSubagents({ terminalId });
 * if (result.status === "ok") console.log(result.subagents.length);
 */
export const claudeClient = {
  listSubagents: (payload: { terminalId: string }): Promise<AgentSubagentsResult> => {
    return window.electron.claude.listSubagents(payload);
  },

  readSubagentTranscript: (payload: {
    terminalId: string;
    subagentId: string;
  }): Promise<AgentSubagentTranscriptResult> => {
    return window.electron.claude.readSubagentTranscript(payload);
  },
} as const;
