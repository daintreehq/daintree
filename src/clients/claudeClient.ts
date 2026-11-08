import type {
  AgentSubagentsResult,
  AgentSubagentTranscriptResult,
} from "@shared/types/ipc/agentSubagents";
import type { ClaudeUsageAccount } from "@shared/types/ipc/agentQuota";

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

  /** The stretch of a recent reply `selection` shows, as the agent wrote it, or null. */
  findReplySpan: (payload: { terminalId: string; selection: string }): Promise<string | null> => {
    return window.electron.claude.findReplySpan(payload);
  },

  /**
   * The latest usage message per limit that the host's Claude Code panes
   * showed, grouped by the login each pane ran on (#16370). Empty until a
   * pane has shown one.
   */
  readUsage: (): Promise<ClaudeUsageAccount[]> => {
    return window.electron.claude.readUsage();
  },
} as const;
