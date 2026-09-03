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

  /**
   * Which session `codex resume --last` would open in `cwd`, or null when the
   * folder has none, two are tied for most recent, or Codex can't be asked
   * (#12178). Null is a normal answer: restore falls back to plain `--last`.
   */
  resolveResumeLatestSession: (payload: { cwd: string }): Promise<string | null> => {
    return window.electron.codex.resolveResumeLatestSession(payload);
  },
} as const;
