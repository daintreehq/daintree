import type { CliAvailability } from "@shared/types";
import { BUILT_IN_AGENT_IDS, type BuiltInAgentId } from "@shared/config/agentIds";
import { isAgentLaunchable } from "../../shared/utils/agentAvailability";

/**
 * Resolve which agent to use given a user preference, an optional secondary
 * default, and the current CLI-availability map.  Returns the first usable
 * agent in priority order: defaultAgent → defaultSelection →
 * daintree-assistant (when installed) → registry order.
 */
export function getDefaultAgentId(
  defaultAgent: string | undefined,
  defaultSelection: string | undefined,
  availability: CliAvailability,
  selectedAgents?: Set<string>
): BuiltInAgentId | null {
  const isUsable = (id: string) =>
    isAgentLaunchable(availability[id as keyof CliAvailability]) &&
    (!selectedAgents || selectedAgents.has(id));

  if (
    defaultAgent &&
    (BUILT_IN_AGENT_IDS as readonly string[]).includes(defaultAgent) &&
    isUsable(defaultAgent)
  ) {
    return defaultAgent as BuiltInAgentId;
  }

  if (
    defaultSelection &&
    (BUILT_IN_AGENT_IDS as readonly string[]).includes(defaultSelection) &&
    isUsable(defaultSelection)
  ) {
    return defaultSelection as BuiltInAgentId;
  }

  // Favour the Daintree assistant when it's installed and the user hasn't set
  // an explicit preference. This is a live availability check at call time —
  // never persisted — so uninstalling the CLI immediately reverts the default.
  if (
    (BUILT_IN_AGENT_IDS as readonly string[]).includes("daintree-assistant") &&
    isUsable("daintree-assistant")
  ) {
    return "daintree-assistant" as BuiltInAgentId;
  }

  for (const agentId of BUILT_IN_AGENT_IDS) {
    if (isUsable(agentId)) {
      return agentId;
    }
  }

  return null;
}
