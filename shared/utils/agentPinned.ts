import type { AgentSettings, AgentSettingsEntry } from "../types/agentSettings.js";

/**
 * Returns true only when the entry explicitly sets `pinned: true`. Missing
 * entries and missing `pinned` fields resolve to `false` (opt-in semantics).
 * The renderer normalizer synthesizes `pinned: true` for registered agents
 * whose CLI is installed — uninstalled or unknown-state agents stay unpinned
 * until the user pins them explicitly.
 */
export function isAgentPinned(entry: AgentSettingsEntry | undefined | null): boolean {
  if (!entry) return false;
  return entry.pinned === true;
}

export function isAgentPinnedById(
  settings: AgentSettings | null | undefined,
  agentId: string
): boolean {
  return isAgentPinned(settings?.agents?.[agentId]);
}
