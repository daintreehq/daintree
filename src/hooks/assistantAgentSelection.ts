import type { CliAvailability } from "@shared/types";
import { isAgentInstalled } from "@shared/utils/agentAvailability";

/**
 * The assistant-supported agents that are installed. Empty until CLI
 * availability has real data, so nothing offers — or auto-launches — a choice
 * it can't yet stand behind.
 */
export function selectInstalledAssistantAgentIds(
  supportedIds: readonly string[],
  availability: Partial<CliAvailability>,
  hasRealData: boolean
): string[] {
  if (!hasRealData) return [];
  return supportedIds.filter((id) => isAgentInstalled(availability[id]));
}

/**
 * The agent a new assistant session starts on without asking: the saved
 * preference, else the sole installed supported agent. With several installed
 * there is no unambiguous target, so the user has to choose. The dock's Start
 * button, its auto-launch, and Settings all read the same answer.
 */
export function resolveLaunchableAssistantAgentId(
  preferredAgentId: string | null,
  installedAgentIds: readonly string[]
): string | null {
  if (preferredAgentId) return preferredAgentId;
  return installedAgentIds.length === 1 ? (installedAgentIds[0] ?? null) : null;
}
