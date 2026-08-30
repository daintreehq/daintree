import type {
  AgentSubagentsResult,
  AgentSubagentTranscriptResult,
} from "@shared/types/ipc/agentSubagents";

/**
 * @example
 * const result = await codexClient.listSubagents({ terminalId });
 * if (result.status === "ok") console.log(result.subagents.length);
 */
export const codexClient = {
  listSubagents: (payload: { terminalId: string }): Promise<AgentSubagentsResult> => {
    return window.electron.codex.listSubagents(payload);
  },

  readSubagentTranscript: (payload: {
    terminalId: string;
    subagentId: string;
  }): Promise<AgentSubagentTranscriptResult> => {
    return window.electron.codex.readSubagentTranscript(payload);
  },
} as const;
