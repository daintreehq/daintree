import type { AgentSettings, AgentSettingsEntry } from "../types/agentSettings.js";

/**
 * Returns true if the agent is pinned to the toolbar. Treats missing entries
 * and missing `pinned` fields as pinned=true (default-pin semantics): installed
 * agents show in the toolbar until the user explicitly unpins them.
 */
export function isAgentPinned(entry: AgentSettingsEntry | undefined | null): boolean {
  if (!entry) return true;
  return entry.pinned !== false;
}

export function isAgentPinnedById(
  settings: AgentSettings | null | undefined,
  agentId: string
): boolean {
  return isAgentPinned(settings?.agents?.[agentId]);
}
