import { codexClient } from "./codexClient";
import { claudeClient } from "./claudeClient";
import type {
  AgentSubagentUnavailableReason,
  AgentSubagentsResult,
  AgentSubagentTranscriptResult,
  SubagentProvider,
} from "@shared/types/ipc/agentSubagents";

/**
 * The whole per-agent difference, in one table.
 *
 * Codex answers a protocol and Claude reads files, but that divergence stops at
 * `list`/`readTranscript`. Everything downstream — the hook's cache and
 * throttle, the chip, the row, the transcript view — is one implementation
 * working off the shared model, which is the point: two subagent views that
 * drift apart is the failure this feature was asked to avoid.
 */
export interface SubagentProviderAdapter {
  /** Agent name as it appears in the popover header. */
  label: string;
  list: (payload: { terminalId: string }) => Promise<AgentSubagentsResult>;
  readTranscript: (payload: {
    terminalId: string;
    subagentId: string;
  }) => Promise<AgentSubagentTranscriptResult>;
  /**
   * Reason to report when the IPC call itself rejects. Each provider names its
   * own failure so a filesystem error isn't reported as a protocol one.
   */
  fallbackReason: AgentSubagentUnavailableReason;
}

export const SUBAGENT_PROVIDERS: Record<SubagentProvider, SubagentProviderAdapter> = {
  codex: {
    label: "Codex",
    list: codexClient.listSubagents,
    readTranscript: codexClient.readSubagentTranscript,
    fallbackReason: "protocol-error",
  },
  claude: {
    label: "Claude",
    list: claudeClient.listSubagents,
    readTranscript: claudeClient.readSubagentTranscript,
    fallbackReason: "store-unreadable",
  },
};

/** Narrow a panel's agent id to a provider whose children can be listed. */
export function toSubagentProvider(agentId: string | undefined): SubagentProvider | null {
  return agentId === "codex" || agentId === "claude" ? agentId : null;
}
