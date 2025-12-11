import { AGENT_REGISTRY } from "../config/agentRegistry.js";

export interface AgentSettingsEntry {
  enabled?: boolean;
  customFlags?: string;
  /** Additional args appended when dangerous mode is enabled */
  dangerousArgs?: string;
  /** Toggle to include dangerousArgs in the final command */
  dangerousEnabled?: boolean;
  [key: string]: unknown;
}

// Legacy aliases for compatibility
export type ClaudeSettings = AgentSettingsEntry;
export type GeminiSettings = AgentSettingsEntry;
export type CodexSettings = AgentSettingsEntry;

export interface AgentSettings {
  agents: Record<string, AgentSettingsEntry>;
}

export const DEFAULT_DANGEROUS_ARGS: Record<string, string> = {
  claude: "--dangerously-skip-permissions",
  gemini: "--yolo",
  codex: "--dangerously-bypass-approvals-and-sandbox",
};

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  agents: Object.fromEntries(
    Object.keys(AGENT_REGISTRY).map((id) => [
      id,
      {
        enabled: true,
        customFlags: "",
        dangerousArgs: DEFAULT_DANGEROUS_ARGS[id] ?? "",
        dangerousEnabled: false,
      },
    ])
  ),
};

export function getAgentSettingsEntry(
  settings: AgentSettings | null | undefined,
  agentId: string
): AgentSettingsEntry {
  if (!settings || !settings.agents) return {};
  return settings.agents[agentId] ?? {};
}

export function generateAgentFlags(
  entry: AgentSettingsEntry,
  agentId?: string
): string[] {
  const flags: string[] = [];
  if (entry.dangerousEnabled) {
    // Use entry.dangerousArgs if set, otherwise fall back to default for this agent
    const dangerousArgs =
      entry.dangerousArgs?.trim() || (agentId ? DEFAULT_DANGEROUS_ARGS[agentId] : "");
    if (dangerousArgs) {
      flags.push(...dangerousArgs.split(/\s+/));
    }
  }
  if (entry.customFlags) {
    const trimmed = entry.customFlags.trim();
    if (trimmed) {
      flags.push(...trimmed.split(/\s+/));
    }
  }
  return flags;
}

// Legacy helpers preserved for compatibility (all now use customFlags only)
export const generateClaudeFlags = generateAgentFlags;
export const generateGeminiFlags = generateAgentFlags;
export const generateCodexFlags = generateAgentFlags;
