import type {
  CodexSubagentsResult,
  CodexSubagentTranscriptResult,
} from "@shared/types/ipc/codexSubagents";

/**
 * @example
 * const result = await codexClient.listSubagents({ terminalId });
 * if (result.status === "ok") console.log(result.subagents.length);
 */
export const codexClient = {
  listSubagents: (payload: { terminalId: string }): Promise<CodexSubagentsResult> => {
    return window.electron.codex.listSubagents(payload);
  },

  readSubagentTranscript: (payload: {
    terminalId: string;
    threadId: string;
  }): Promise<CodexSubagentTranscriptResult> => {
    return window.electron.codex.readSubagentTranscript(payload);
  },
} as const;
